import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditActorType,
  AuditEventType,
  DeathVerificationCaseStatus,
  MessageStatus,
  Prisma,
  UserRole,
  UserStatus,
} from '../generated/prisma/client.js';
import {
  type AuditActor,
  paginate,
  writeAuditLog,
} from '../audit/audit-log.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminQueuesService } from './admin-queues.service.js';
import type { AdminUserListQueryDto } from './dto/admin.dto.js';

// Account metadata only. Never passwordHash, notes, Message/Memory Vault/
// My Story/My Wishes content, MFA secrets or sessions.
const adminUserSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

const WRONG_STATE: Record<UserStatus, string> = {
  ACTIVE: 'This account is not suspended.',
  SUSPENDED: 'This account is already suspended.',
  PASSED:
    'This account holder has a verified death. Their status cannot be changed here.',
  DELETED: 'This account is deleted.',
};

/**
 * Least privilege: ADMIN manages CUSTOMER accounts; SUPER_ADMIN also manages
 * ADMIN accounts. Nobody manages a SUPER_ADMIN (or themselves) through the
 * API, so the last SUPER_ADMIN can never be locked out this way.
 */
const canManage = (actor: AuditActorType, target: UserRole) =>
  target === UserRole.CUSTOMER ||
  (target === UserRole.ADMIN && actor === AuditActorType.SUPER_ADMIN);

type StatusChange = {
  from: UserStatus;
  to: UserStatus;
  event: AuditEventType;
  reason?: string | null;
};

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: AdminQueuesService,
  ) {}

  /** Real aggregates only; billing and delivery do not exist yet. */
  async dashboard() {
    const [users, cases, failed] = await Promise.all([
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.deathVerificationCase.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.queues.failedTotal(),
    ]);
    const userCount = (s: UserStatus) =>
      users.find((u) => u.status === s)?._count._all ?? 0;
    const caseCount = (s: DeathVerificationCaseStatus) =>
      cases.find((c) => c.status === s)?._count._all ?? 0;
    return {
      users: {
        total: users.reduce((sum, u) => sum + u._count._all, 0),
        active: userCount(UserStatus.ACTIVE),
        suspended: userCount(UserStatus.SUSPENDED),
        passed: userCount(UserStatus.PASSED),
        deleted: userCount(UserStatus.DELETED),
      },
      deathVerification: {
        pending: caseCount(DeathVerificationCaseStatus.PENDING_VERIFICATION),
        safeguardActive: caseCount(
          DeathVerificationCaseStatus.SAFEGUARD_ACTIVE,
        ),
        readyForReview: caseCount(DeathVerificationCaseStatus.READY_FOR_REVIEW),
      },
      // null = Redis could not be read, not "zero failures".
      queues: { failed },
    };
  }

  async listUsers(q: AdminUserListQueryDto) {
    const where: Prisma.UserWhereInput = {
      role: q.role,
      status: q.status,
      OR: q.search
        ? (['email', 'firstName', 'lastName'] as const).map((field) => ({
            [field]: { contains: q.search, mode: 'insensitive' as const },
          }))
        : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: adminUserSelect,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, pagination: paginate(q.page, q.limit, total) };
  }

  /** Account metadata + counts. The view itself is audited. */
  async getUser(userId: string, actor: AuditActor) {
    const found = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...adminUserSelect,
        emailVerifiedAt: true,
        twoFactorEnabled: true,
        passedAt: true,
        deletedAt: true,
        _count: {
          select: {
            recipients: { where: { deletedAt: null } },
            trustedContacts: { where: { deletedAt: null } },
            messages: { where: { deletedAt: null } },
            memoryVaultItems: { where: { deletedAt: null } },
          },
        },
        deathVerificationCase: { select: { id: true, status: true } },
      },
    });
    if (!found) throw new NotFoundException('User not found.');
    const releasedMessageCount = await this.prisma.message.count({
      where: {
        ownerUserId: userId,
        status: MessageStatus.RELEASED,
        deletedAt: null,
      },
    });
    await writeAuditLog(this.prisma, {
      eventType: AuditEventType.ADMIN_VIEWED_USER,
      actor,
      subjectType: 'User',
      subjectId: userId,
    });
    this.logger.log(`admin_user_viewed user ${userId} admin ${actor.userId}`);
    const { _count, deathVerificationCase, twoFactorEnabled, ...user } = found;
    return {
      ...user,
      mfaEnabled: twoFactorEnabled,
      counts: {
        recipientCount: _count.recipients,
        trustedContactCount: _count.trustedContacts,
        messageCount: _count.messages,
        releasedMessageCount,
        memoryVaultCount: _count.memoryVaultItems,
      },
      deathVerification: deathVerificationCase
        ? {
            caseId: deathVerificationCase.id,
            status: deathVerificationCase.status,
          }
        : null,
    };
  }

  /** ACTIVE → SUSPENDED. SessionAuthGuard re-reads status, so it is immediate. */
  suspend(userId: string, reason: string, actor: AuditActor) {
    return this.changeStatus(userId, actor, {
      from: UserStatus.ACTIVE,
      to: UserStatus.SUSPENDED,
      event: AuditEventType.USER_SUSPENDED,
      reason,
    });
  }

  /** SUSPENDED → ACTIVE only. Never PASSED (verified death) or DELETED. */
  reactivate(
    userId: string,
    reason: string | null | undefined,
    actor: AuditActor,
  ) {
    return this.changeStatus(userId, actor, {
      from: UserStatus.SUSPENDED,
      to: UserStatus.ACTIVE,
      event: AuditEventType.USER_REACTIVATED,
      reason,
    });
  }

  private async changeStatus(
    userId: string,
    actor: AuditActor,
    change: StatusChange,
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
    if (!target) throw new NotFoundException('User not found.');
    if (target.id === actor.userId) {
      throw new ForbiddenException(
        'You cannot change your own account status.',
      );
    }
    if (!canManage(actor.type, target.role)) {
      throw new ForbiddenException(
        'You are not allowed to manage this account.',
      );
    }
    const user = await this.prisma.$transaction(async (tx) => {
      // Conditional: a concurrent change (or a death verification setting
      // PASSED) wins cleanly and this one gets 409.
      const { count } = await tx.user.updateMany({
        where: { id: userId, status: change.from, role: target.role },
        data: { status: change.to },
      });
      if (!count) return null;
      await writeAuditLog(tx, {
        eventType: change.event,
        actor,
        subjectType: 'User',
        subjectId: userId,
        metadata: {
          previousStatus: change.from,
          newStatus: change.to,
          reason: change.reason ?? null,
        },
      });
      return tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: adminUserSelect,
      });
    });
    if (!user) {
      const current = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { status: true },
      });
      if (!current) throw new NotFoundException('User not found.');
      throw new ConflictException(WRONG_STATE[current.status]);
    }
    // The reason is never logged; it is in the audit row only.
    this.logger.log(
      `admin_user_${change.to === UserStatus.SUSPENDED ? 'suspended' : 'reactivated'} user ${userId} admin ${actor.userId}`,
    );
    return user;
  }
}

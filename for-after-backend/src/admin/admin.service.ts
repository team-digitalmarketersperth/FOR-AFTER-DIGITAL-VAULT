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
  DeadLetterStatus,
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
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { AdminQueuesService } from './admin-queues.service.js';
import { releaseEmailWhere } from './admin-deliveries.service.js';
import { pastDueWhere } from './admin-releases.service.js';
import { AdminSecurityService } from './admin-security.service.js';
import { SystemHealthService } from './system-health.service.js';
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
export const canManage = (actor: AuditActorType, target: UserRole) =>
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
    private readonly systemHealth: SystemHealthService,
    private readonly security: AdminSecurityService,
  ) {}

  /**
   * The admin Overview: counts and statuses only, never content, names,
   * emails or ids. Each source is read on its own, so one failing (Redis,
   * say) leaves the others; a section that could not be read is null, never
   * zero. Definitions: docs/admin.md → Overview. Read-only: nothing here
   * queues, releases or sends anything.
   */
  async dashboard(now = new Date()) {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const db = <T>(work: Promise<T>) =>
      work.catch((err: unknown) => {
        this.logger.error(`admin_dashboard_unavailable (code: ${errorCode(err)})`);
        return null;
      });

    const [customers, cases, releases, emails, deadLetters, mfaFailures, queues, health] =
      await Promise.all([
        db(
          Promise.all([
            this.prisma.user.groupBy({
              by: ['status'],
              where: { role: UserRole.CUSTOMER },
              _count: { _all: true },
            }),
            this.prisma.user.count({
              where: { role: UserRole.CUSTOMER, createdAt: { gte: weekAgo } },
            }),
          ]),
        ),
        db(
          this.prisma.deathVerificationCase.groupBy({
            by: ['status'],
            where: {
              status: {
                in: [
                  DeathVerificationCaseStatus.PENDING_VERIFICATION,
                  DeathVerificationCaseStatus.SAFEGUARD_ACTIVE,
                  DeathVerificationCaseStatus.READY_FOR_REVIEW,
                ],
              },
            },
            _count: { _all: true },
          }),
        ),
        // Messages, with the same definition as the Releases page's filter.
        db(this.prisma.message.count({ where: pastDueWhere(now) })),
        db(
          Promise.all([
            // Same definitions as the Deliveries page's status filter.
            this.prisma.releaseNotification.count({ where: releaseEmailWhere.retrying }),
            this.prisma.releaseNotification.count({ where: releaseEmailWhere.failed }),
          ]),
        ),
        db(
          this.prisma.deadLetterJob.count({
            where: { status: DeadLetterStatus.OPEN },
          }),
        ),
        // Same definition as Security Activity's "Admin two-factor failed".
        db(this.security.mfaFailuresSince(weekAgo)),
        this.queues.totals(),
        this.systemHealth.check(),
      ]);

    const [byStatus, newLast7Days] = customers ?? [[], 0];
    const customerCount = (s: UserStatus) =>
      byStatus.find((u) => u.status === s)?._count._all ?? 0;
    const caseCount = (s: DeathVerificationCaseStatus) =>
      cases?.find((c) => c.status === s)?._count._all ?? 0;
    return {
      generatedAt: now.toISOString(),
      customers: customers && {
        total: byStatus.reduce((sum, u) => sum + u._count._all, 0),
        active: customerCount(UserStatus.ACTIVE),
        suspended: customerCount(UserStatus.SUSPENDED),
        passed: customerCount(UserStatus.PASSED),
        deleted: customerCount(UserStatus.DELETED),
        newLast7Days,
      },
      deathVerification: cases && {
        pending: caseCount(DeathVerificationCaseStatus.PENDING_VERIFICATION),
        safeguardActive: caseCount(DeathVerificationCaseStatus.SAFEGUARD_ACTIVE),
        readyForReview: caseCount(DeathVerificationCaseStatus.READY_FOR_REVIEW),
      },
      releases: releases === null ? null : { pastDue: releases },
      releaseEmails: emails && { retrying: emails[0], failed: emails[1] },
      // null = Redis could not be read, not "no jobs".
      queues,
      // PostgreSQL, so still shown when Redis is down.
      deadLetters: deadLetters === null ? null : { open: deadLetters },
      // Recorded AuditLog rows, not attempts (§20).
      security: mfaFailures === null ? null : { adminMfaFailuresLast7Days: mfaFailures },
      // The System Health snapshot's statuses (same checks, same definitions;
      // details on /admin/system/health).
      services: {
        database: health.database.status,
        redis: health.redis.status,
        worker: health.worker.status,
        malwareScanner: health.malwareScanner.status,
      },
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
        // The current (newest) case; older ones are in the death-case list.
        deathVerificationCases: {
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { id: true, status: true },
        },
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
    const {
      _count,
      deathVerificationCases: [deathVerificationCase],
      twoFactorEnabled,
      ...user
    } = found;
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

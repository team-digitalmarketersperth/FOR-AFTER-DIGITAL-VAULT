import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { actorTypeFor, paginate, writeAuditLog, type AuditActor } from '../audit/audit-log.service.js';
import { AuthTokensService } from '../auth/auth-tokens.service.js';
import { ADMIN_ROLES } from '../auth/guards/admin.guard.js';
import { AuditEventType, type AuditActorType, Prisma, UserRole, type UserStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { canManage } from './admin.service.js';
import type { AdminAccessQueryDto, CreateAdminDto } from './dto/admin.dto.js';

/**
 * Admin access (docs/admin.md §22): a read-only view of administrator
 * accounts. Visible to every admin, as admin accounts already are on the Users
 * page. No mutation here: suspension stays on the Users page with its existing
 * rules, and role changes do not exist (no step-up re-authentication yet).
 */

/**
 * What a role may do, computed from the same functions and guards that enforce
 * it (canManage, ADMIN_ROLES/AdminGuard), so the page cannot drift from them.
 */
export const effectivePermissions = (role: UserRole) => {
  const actor = actorTypeFor(role);
  return {
    adminPortal: ADMIN_ROLES.includes(role),
    manageCustomerAccounts: canManage(actor, UserRole.CUSTOMER),
    manageAdminAccounts: canManage(actor, UserRole.ADMIN),
    manageSuperAdminAccounts: canManage(actor, UserRole.SUPER_ADMIN),
    changeRoles: false, // no API changes a role
  };
};

// Never passwordHash, MFA secrets, recovery codes, sessions or customer content.
const select = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  status: true,
  createdAt: true,
  passwordChangedAt: true,
  adminMfaCredential: { select: { enabledAt: true } },
  _count: { select: { authTokens: { where: { purpose: 'ADMIN_INVITATION' } } } },
} satisfies Prisma.UserSelect;
type Row = Prisma.UserGetPayload<{ select: typeof select }>;

// Access-related history about this account (subject = the admin).
const HISTORY: AuditEventType[] = [
  AuditEventType.USER_SUSPENDED,
  AuditEventType.USER_REACTIVATED,
  AuditEventType.ADMIN_MFA_SETUP_COMPLETED,
];
const STATUSES = ['ACTIVE', 'SUSPENDED', 'PASSED', 'DELETED'];

export const RECENT_AUTH_MS = 15 * 60 * 1000;
export const EMAIL_TAKEN = 'An account with this email already exists.';
const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/**
 * Creating an admin: SUPER_ADMIN only, with two-factor completed in the last
 * 15 minutes (the session's own MFA time; sign in again otherwise).
 */
export function assertCanCreateAdmins(role: UserRole, adminMfaVerifiedAt: number | undefined, now = Date.now()) {
  if (role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('Only a super admin can create admins.');
  if (!adminMfaVerifiedAt || now - adminMfaVerifiedAt > RECENT_AUTH_MS) {
    throw new ForbiddenException('For your security, sign in again (with two-factor) to create an admin.');
  }
}

export const hasRecentAuth = (adminMfaVerifiedAt: number | undefined, now = Date.now()) =>
  !!adminMfaVerifiedAt && now - adminMfaVerifiedAt <= RECENT_AUTH_MS;

/** Creating or revoking an IP block: same rule as creating an admin. */
export function assertCanManageIpBlocks(role: UserRole, adminMfaVerifiedAt: number | undefined, now = Date.now()) {
  if (role !== UserRole.SUPER_ADMIN) throw new ForbiddenException('Only a super admin can manage IP blocks.');
  if (!hasRecentAuth(adminMfaVerifiedAt, now)) {
    throw new ForbiddenException('For your security, sign in again (with two-factor) to manage IP blocks.');
  }
}

const summary = (r: Row, lastSignInAt: Date | undefined) => ({
  id: r.id,
  email: r.email,
  firstName: r.firstName,
  lastName: r.lastName,
  role: r.role,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  // Enrolment only (a confirmed authenticator); not whether a session passed MFA.
  mfaEnrolled: !!r.adminMfaCredential?.enabledAt,
  // The last ADMIN_LOGIN audit row (password + two-factor completed). null: none recorded.
  lastSignInAt: lastSignInAt?.toISOString() ?? null,
  // Invited and has not set a password yet (cannot sign in).
  invitationPending: r._count.authTokens > 0 && !r.passwordChangedAt,
});

@Injectable()
export class AdminAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: AuthTokensService,
  ) {}

  /**
   * A new ordinary ADMIN (never SUPER_ADMIN): no usable password until the
   * invitation link is used, then the normal admin sign-in requires TOTP setup.
   * An existing account with this email is never changed or elevated.
   */
  async create(dto: CreateAdminDto, actor: AuditActor) {
    // Nobody knows this password: the account cannot sign in until invited.
    const unusable = await argon2.hash(randomBytes(32), { type: argon2.argon2id });
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        if (await tx.user.findUnique({ where: { email: dto.email }, select: { id: true } })) throw new ConflictException(EMAIL_TAKEN);
        const user = await tx.user.create({
          data: { email: dto.email, firstName: dto.firstName, lastName: dto.lastName, role: UserRole.ADMIN, passwordHash: unusable },
          select: { id: true },
        });
        await writeAuditLog(tx, {
          eventType: AuditEventType.ADMIN_CREATED,
          actor,
          subjectType: 'User',
          subjectId: user.id,
          metadata: { role: UserRole.ADMIN },
        });
        return user.id;
      });
    } catch (err) {
      // Two creations at once: the unique email decides; the loser gets the same 409.
      if (isUniqueViolation(err)) throw new ConflictException(EMAIL_TAKEN);
      throw err;
    }
    const invitation = await this.invite(id, actor);
    return { id, invitation };
  }

  /** Resend for an admin who has not accepted yet (older links stop working). */
  async resend(id: string, actor: AuditActor) {
    const row = await this.prisma.user.findFirst({ where: { id, role: UserRole.ADMIN }, select });
    if (!row) throw new NotFoundException('Administrator not found.');
    if (row.passwordChangedAt) throw new ConflictException('This admin has already set their password.');
    return { id, invitation: await this.invite(id, actor) };
  }

  private async invite(id: string, actor: AuditActor) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, email: true, firstName: true } });
    return this.tokens.sendAdminInvitation(user, {
      eventType: AuditEventType.ADMIN_INVITATION_SENT,
      actor,
      subjectType: 'User',
      subjectId: id,
    });
  }

  async list(q: AdminAccessQueryDto) {
    const where: Prisma.UserWhereInput = {
      role: q.role ?? { in: ADMIN_ROLES },
      status: q.status,
      adminMfaCredential: q.mfa === 'enrolled' ? { is: { enabledAt: { not: null } } } : undefined,
      ...(q.mfa === 'not_enrolled' && {
        OR: [{ adminMfaCredential: { is: null } }, { adminMfaCredential: { enabledAt: null } }],
      }),
      ...(q.search && {
        AND: [
          {
            OR: (['email', 'firstName', 'lastName'] as const).map((field) => ({
              [field]: { contains: q.search, mode: 'insensitive' as const },
            })),
          },
        ],
      }),
    };
    const dir = q.dir ?? (q.sort === 'email' ? 'asc' : 'desc');
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        orderBy: [{ [q.sort ?? 'createdAt']: dir }, { id: dir }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select,
      }),
      this.prisma.user.count({ where }),
    ]);
    const last = await this.lastSignIns(rows.map((r) => r.id));
    return { items: rows.map((r) => summary(r, last.get(r.id))), pagination: paginate(q.page, q.limit, total) };
  }

  /** viewer: the signed-in admin, to say whether they may manage this account on the Users page. */
  async get(id: string, viewer: { id: string; type: AuditActorType }) {
    const row = await this.prisma.user.findFirst({ where: { id, role: { in: ADMIN_ROLES } }, select });
    if (!row) throw new NotFoundException('Administrator not found.');
    const [last, history] = await Promise.all([
      this.lastSignIns([id]),
      this.prisma.auditLog.findMany({
        where: { subjectType: 'User', subjectId: id, eventType: { in: HISTORY } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        select: { id: true, eventType: true, actorType: true, actorUserId: true, metadata: true, createdAt: true },
      }),
    ]);
    const statusOf = (m: unknown, k: string) => {
      const v = m && typeof m === 'object' ? (m as Record<string, unknown>)[k] : undefined;
      return typeof v === 'string' && STATUSES.includes(v) ? (v as UserStatus) : null;
    };
    return {
      ...summary(row, last.get(id)),
      mfaEnrolledAt: row.adminMfaCredential?.enabledAt?.toISOString() ?? null,
      permissions: effectivePermissions(row.role),
      // Same rule the Users page enforces; it still checks again on every action.
      viewerCanManage: viewer.id !== id && canManage(viewer.type, row.role),
      // Explicit fields only: never the free-text reason or raw metadata.
      history: history.map((h) => ({
        reference: h.id,
        eventType: h.eventType,
        actorType: h.actorType,
        actorUserId: h.actorUserId,
        previousStatus: statusOf(h.metadata, 'previousStatus'),
        newStatus: statusOf(h.metadata, 'newStatus'),
        recordedAt: h.createdAt.toISOString(),
      })),
    };
  }

  // One grouped read per page, no per-row queries.
  private async lastSignIns(ids: string[]) {
    if (!ids.length) return new Map<string, Date>();
    const rows = await this.prisma.auditLog.groupBy({
      by: ['actorUserId'],
      where: { eventType: AuditEventType.ADMIN_LOGIN, actorUserId: { in: ids } },
      _max: { createdAt: true },
      orderBy: { actorUserId: 'asc' },
    });
    return new Map(rows.filter((r) => r.actorUserId && r._max?.createdAt).map((r) => [r.actorUserId!, r._max!.createdAt!]));
  }
}

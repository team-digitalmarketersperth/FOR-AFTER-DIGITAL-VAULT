import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { paginate } from '../audit/audit-log.service.js';
import { type AuditActorType, AuditEventType, type Prisma } from '../generated/prisma/client.js';
import { IpBlockService } from '../ip-blocks/ip-block.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SecurityEventQueryDto } from './dto/admin.dto.js';

/**
 * Security Activity (docs/admin.md §20): a read-only projection of the AuditLog
 * rows that are security events. No second audit store, no new capture: events
 * that only reach logs or Redis counters (customer sign-in failures, OTP limits,
 * throttling, Origin rejections) are documented gaps, not rows here.
 */
export const SECURITY_CATEGORIES = ['admin_sign_in', 'mfa_failure', 'recovery_code', 'mfa_setup', 'account_status', 'account_credentials', 'ip_controls'] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];
export const SECURITY_OUTCOMES = ['failed', 'completed'] as const;
export type SecurityOutcome = (typeof SECURITY_OUTCOMES)[number];

const E = AuditEventType;
export const SECURITY_EVENTS: Partial<Record<AuditEventType, { category: SecurityCategory; outcome: SecurityOutcome }>> = {
  [E.ADMIN_PASSWORD_AUTH_SUCCEEDED]: { category: 'admin_sign_in', outcome: 'completed' },
  [E.ADMIN_MFA_VERIFIED]: { category: 'admin_sign_in', outcome: 'completed' },
  [E.ADMIN_LOGIN]: { category: 'admin_sign_in', outcome: 'completed' },
  [E.ADMIN_LOGOUT]: { category: 'admin_sign_in', outcome: 'completed' },
  [E.ADMIN_MFA_FAILED]: { category: 'mfa_failure', outcome: 'failed' },
  [E.ADMIN_RECOVERY_CODE_USED]: { category: 'recovery_code', outcome: 'completed' },
  [E.ADMIN_MFA_SETUP_COMPLETED]: { category: 'mfa_setup', outcome: 'completed' },
  [E.USER_SUSPENDED]: { category: 'account_status', outcome: 'completed' },
  [E.USER_REACTIVATED]: { category: 'account_status', outcome: 'completed' },
  [E.PASSWORD_CHANGED]: { category: 'account_credentials', outcome: 'completed' },
  [E.PASSWORD_RESET_COMPLETED]: { category: 'account_credentials', outcome: 'completed' },
  [E.EMAIL_CHANGE_REQUESTED]: { category: 'account_credentials', outcome: 'completed' },
  [E.EMAIL_CHANGED]: { category: 'account_credentials', outcome: 'completed' },
  [E.IP_BLOCK_CREATED]: { category: 'ip_controls', outcome: 'completed' },
  [E.IP_BLOCK_REVOKED]: { category: 'ip_controls', outcome: 'completed' },
};
const ALL = Object.keys(SECURITY_EVENTS) as AuditEventType[];
const typesWhere = (pick: (m: { category: SecurityCategory; outcome: SecurityOutcome }) => boolean) =>
  ALL.filter((t) => pick(SECURITY_EVENTS[t]!));

// ADMIN_MFA_FAILED metadata as written by AdminMfaService.failed(); anything
// else (legacy or unexpected) is shown as "not recorded", never echoed.
const MFA_METHODS = ['totp', 'recovery', 'challenge'] as const;
const MFA_REASONS = ['wrong_code', 'replay', 'already_used', 'attempts_exhausted'] as const;
const INVALIDATED = '_challenge_invalidated';
const oneOf = <T extends string>(values: readonly T[], v: unknown) =>
  typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null;

// The stored prefix is already /24 or /48 (ipPrefix()); re-checked so a legacy
// or malformed value is dropped instead of displayed.
const PREFIX = /^(\d{1,3}\.){3}0\/24$|^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){2}::\/48$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_WINDOW_DAYS = 30;
export const MAX_WINDOW_DAYS = 366;
const HOURLY_MAX_MS = 2 * DAY;
const TOP_SOURCES = 5;

const select = {
  id: true,
  eventType: true,
  actorType: true,
  actorUserId: true,
  subjectType: true,
  subjectId: true,
  ipPrefix: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;
type Row = Prisma.AuditLogGetPayload<{ select: typeof select }>;

/** The response DTO. No userAgent, no free-text metadata (e.g. a suspension reason). */
export const toSecurityEvent = (r: Row, verifiedFrom: Date | null = null) => {
  const m = r.metadata && typeof r.metadata === 'object' && !Array.isArray(r.metadata) ? r.metadata : {};
  const raw = typeof m.reason === 'string' ? m.reason : null;
  const failure = r.eventType === E.ADMIN_MFA_FAILED;
  return {
    reference: r.id,
    recordedAt: r.createdAt.toISOString(),
    eventType: r.eventType,
    ...SECURITY_EVENTS[r.eventType]!,
    actorType: r.actorType as AuditActorType,
    // Set by the server from a session or a password-verified admin, never
    // from a submitted identifier.
    actorUserId: r.actorUserId,
    accountId: r.subjectType === 'User' && r.subjectId && UUID.test(r.subjectId) ? r.subjectId : null,
    network: r.ipPrefix && PREFIX.test(r.ipPrefix) ? r.ipPrefix : null,
    // The extraction path was verified when this row was written. Says nothing about who sent it.
    sourceTrusted: !!verifiedFrom && r.createdAt >= verifiedFrom,
    reason: failure
      ? {
          method: oneOf(MFA_METHODS, m.method),
          code: oneOf(MFA_REASONS, raw?.replace(INVALIDATED, '')),
          challengeInvalidated: raw?.endsWith(INVALIDATED) ?? false,
        }
      : null,
  };
};

@Injectable()
export class AdminSecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ipBlocks: IpBlockService,
  ) {}

  async list(q: SecurityEventQueryDto, now = new Date()) {
    const to = q.to ? new Date(q.to) : now;
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY);
    if (from > to) throw new BadRequestException('from must be before to');
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY) {
      throw new BadRequestException(`The time range can be at most ${MAX_WINDOW_DAYS} days.`);
    }
    const window: Prisma.AuditLogWhereInput = {
      eventType: { in: ALL },
      createdAt: { gte: from, lte: to },
    };
    const where: Prisma.AuditLogWhereInput = {
      AND: [
        window,
        {
          eventType: q.category || q.outcome
            ? { in: typesWhere((m) => (!q.category || m.category === q.category) && (!q.outcome || m.outcome === q.outcome)) }
            : undefined,
          actorType: q.actorType,
          id: q.reference,
          ...(q.accountId && { subjectType: 'User', subjectId: q.accountId }),
        },
      ],
    };
    const unit = to.getTime() - from.getTime() <= HOURLY_MAX_MS ? 'hour' : 'day';
    const tz = q.tz ?? 'UTC';
    // Bins stop at now: a future hour is not a confirmed zero.
    const [fromIso, toIso] = [from.toISOString(), (to > now ? now : to).toISOString()];
    const signIn = typesWhere((m) => m.category === 'admin_sign_in');
    const mfaFailure = typesWhere((m) => m.category === 'mfa_failure');
    const [items, total, byType, bins, sources] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select,
      }),
      this.prisma.auditLog.count({ where }),
      // Summary: stored rows per category in the window (not the other filters).
      this.prisma.auditLog.groupBy({ by: ['eventType'], where: window, orderBy: { eventType: 'asc' }, _count: { _all: true } }),
      // Whole local days or hours in the viewer's zone, zero-filled: a zero here is a
      // confirmed "no stored rows", and only a failed query means unavailable. createdAt
      // is timestamp(3) UTC, so bounds are compared as UTC text (session TZ may differ).
      this.prisma.$queryRaw<{ bin: string; signIn: number; mfaFailure: number }[]>`
        WITH bins AS (
          SELECT generate_series(
            date_trunc(${unit}::text, ${fromIso}::timestamptz AT TIME ZONE ${tz}::text),
            ${toIso}::timestamptz AT TIME ZONE ${tz}::text,
            ('1 ' || ${unit}::text)::interval
          ) AS bin
        ), rows AS (
          SELECT date_trunc(${unit}::text, "createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}::text) AS bin, "eventType"::text AS type
          FROM "AuditLog"
          WHERE "createdAt" >= ${fromIso}::timestamp AND "createdAt" <= ${toIso}::timestamp
            AND "eventType"::text = ANY(${[...signIn, ...mfaFailure]}::text[])
        )
        SELECT to_char(b.bin, 'YYYY-MM-DD"T"HH24:MI') AS bin,
          (count(r.type) FILTER (WHERE r.type = ANY(${signIn}::text[])))::int AS "signIn",
          (count(r.type) FILTER (WHERE r.type = ANY(${mfaFailure}::text[])))::int AS "mfaFailure"
        FROM bins b LEFT JOIN rows r USING (bin)
        GROUP BY b.bin ORDER BY b.bin`,
      this.prisma.auditLog.groupBy({
        by: ['ipPrefix'],
        where: { ...window, ipPrefix: { not: null } },
        orderBy: { _count: { ipPrefix: 'desc' } },
        take: TOP_SOURCES,
        _count: { ipPrefix: true },
      }),
    ]);
    const counts = Object.fromEntries(SECURITY_CATEGORIES.map((c) => [c, 0])) as Record<SecurityCategory, number>;
    for (const g of byType) {
      const n = (g._count as { _all: number })._all;
      counts[SECURITY_EVENTS[g.eventType]!.category] += n;
    }
    return {
      evaluatedAt: now.toISOString(),
      window: { from: from.toISOString(), to: to.toISOString() },
      counts,
      series: { unit, timeZone: tz, bins },
      // Masked networks only: never an exact address, so never a block target.
      sources: sources.flatMap((s) =>
        s.ipPrefix && PREFIX.test(s.ipPrefix) ? [{ network: s.ipPrefix, count: (s._count as { ipPrefix: number }).ipPrefix }] : [],
      ),
      sourcesTrusted: !!this.ipBlocks.verifiedFrom && from >= this.ipBlocks.verifiedFrom,
      items: items.map((r) => toSecurityEvent(r, this.ipBlocks.verifiedFrom)),
      pagination: paginate(q.page, q.limit, total),
    };
  }

  async get(reference: string) {
    const found = await this.prisma.auditLog.findFirst({ where: { id: reference, eventType: { in: ALL } }, select });
    if (!found) throw new NotFoundException('Security event not found.');
    return toSecurityEvent(found, this.ipBlocks.verifiedFrom);
  }

  /** Overview: ADMIN_MFA_FAILED rows since `since`. */
  mfaFailuresSince(since: Date) {
    return this.prisma.auditLog.count({ where: { eventType: E.ADMIN_MFA_FAILED, createdAt: { gte: since } } });
  }
}

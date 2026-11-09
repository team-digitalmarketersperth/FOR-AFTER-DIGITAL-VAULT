import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { IpBlockService } from '../ip-blocks/ip-block.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminSecurityController } from './admin.controller.js';
import { AdminSecurityService, SECURITY_EVENTS, toSecurityEvent } from './admin-security.service.js';
import { SecurityEventQueryDto } from './dto/admin.dto.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const ADMIN = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const ROW = '11111111-1111-4111-8111-111111111111';
const row = (over: object = {}) => ({
  id: ROW,
  eventType: 'ADMIN_MFA_FAILED',
  actorType: 'ADMIN',
  actorUserId: ADMIN,
  subjectType: 'User',
  subjectId: ADMIN,
  ipPrefix: '203.0.113.0/24',
  metadata: { method: 'totp', reason: 'wrong_code_challenge_invalidated' },
  createdAt: NOW,
  ...over,
});
const q = (body: object) => plainToInstance(SecurityEventQueryDto, { page: 1, limit: 25, ...body });

const setup = (rows = [row()], verifiedFrom: Date | null = null) => {
  const auditLog = {
    findMany: vi.fn(async (_a: unknown) => rows),
    findFirst: vi.fn(async (_a: unknown) => rows[0] ?? null),
    count: vi.fn(async (_a: unknown) => rows.length),
    groupBy: vi.fn(async (_a: unknown) => [
      { eventType: 'ADMIN_MFA_FAILED', _count: { _all: 4 } },
      { eventType: 'ADMIN_LOGIN', _count: { _all: 2 } },
      { eventType: 'ADMIN_LOGOUT', _count: { _all: 1 } },
    ]),
  };
  auditLog.groupBy.mockImplementation(async (a: unknown) =>
    (a as { by: string[] }).by[0] === 'ipPrefix'
      ? ([
          { ipPrefix: '203.0.113.0/24', _count: { ipPrefix: 3 } },
          { ipPrefix: '203.0.113.7', _count: { ipPrefix: 9 } },
        ] as never)
      : [
          { eventType: 'ADMIN_MFA_FAILED', _count: { _all: 4 } },
          { eventType: 'ADMIN_LOGIN', _count: { _all: 2 } },
          { eventType: 'ADMIN_LOGOUT', _count: { _all: 1 } },
        ],
  );
  const db = {
    auditLog,
    $queryRaw: vi.fn(async (..._a: unknown[]) => [{ bin: '2026-10-30T00:00', signIn: 1, mfaFailure: 2 }]),
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return {
    service: new AdminSecurityService(db as unknown as PrismaService, { verifiedFrom } as unknown as IpBlockService),
    auditLog,
    db,
  };
};

describe('AdminSecurityService', () => {
  it('admin role + MFA guards on the controller', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminSecurityController)).toEqual([SessionAuthGuard, AdminGuard]);
  });

  it('a security subset of audit events; never page views or death decisions', () => {
    expect(Object.keys(SECURITY_EVENTS)).not.toContain('ADMIN_VIEWED_USER');
    expect(Object.keys(SECURITY_EVENTS)).not.toContain('DEATH_VERIFICATION_VERIFIED');
    expect(SECURITY_EVENTS.ADMIN_MFA_FAILED).toEqual({ category: 'mfa_failure', outcome: 'failed' });
  });

  it('explicit DTO: no user agent, no free-text metadata, controlled reason codes', () => {
    const e = toSecurityEvent(
      row({ userAgent: 'Mozilla/5.0 secret-ua', metadata: { method: 'totp', reason: 'wrong_code_challenge_invalidated', note: 'x' } }) as never,
    );
    expect(e).toEqual({
      reference: ROW,
      recordedAt: NOW.toISOString(),
      eventType: 'ADMIN_MFA_FAILED',
      category: 'mfa_failure',
      outcome: 'failed',
      actorType: 'ADMIN',
      actorUserId: ADMIN,
      accountId: ADMIN,
      network: '203.0.113.0/24',
      sourceTrusted: false,
      reason: { method: 'totp', code: 'wrong_code', challengeInvalidated: true },
    });
    // A suspension's free-text reason is never returned.
    const s = toSecurityEvent(
      row({ eventType: 'USER_SUSPENDED', metadata: { previousStatus: 'ACTIVE', newStatus: 'SUSPENDED', reason: 'Called 0400 000 000' } }) as never,
    );
    expect(JSON.stringify(s)).not.toMatch(/0400|previousStatus|Mozilla/);
    expect(s.reason).toBeNull();
  });

  it('legacy or malformed metadata and addresses are dropped, not echoed', () => {
    for (const metadata of [null, [], 'text', { method: '<script>', reason: 'brute force detected' }]) {
      const e = toSecurityEvent(row({ metadata }) as never);
      expect(e.reason).toEqual({ method: null, code: null, challengeInvalidated: false });
    }
    // Only /24 and /48 prefixes; a full address (legacy/odd value) is never shown.
    expect(toSecurityEvent(row({ ipPrefix: '2001:db8:85a3::/48' }) as never).network).toBe('2001:db8:85a3::/48');
    for (const ipPrefix of ['203.0.113.7', '203.0.113.7/32', '2001:db8::1', 'x-forwarded-for: 1.2.3.4', null]) {
      expect(toSecurityEvent(row({ ipPrefix }) as never).network).toBeNull();
    }
    // A subject that is not a User UUID is not an account reference.
    expect(toSecurityEvent(row({ subjectType: 'Job', subjectId: 'release:1' }) as never).accountId).toBeNull();
    expect(toSecurityEvent(row({ subjectId: 'someone@example.com' }) as never).accountId).toBeNull();
  });

  it('defaults to the last 30 days; summary counts are stored rows per category in that window', async () => {
    const { service, auditLog } = setup();
    const res = await service.list(q({}), NOW);
    expect(res.window).toEqual({ from: '2026-09-30T12:00:00.000Z', to: NOW.toISOString() });
    expect(res.counts).toEqual({
      admin_sign_in: 3,
      mfa_failure: 4,
      recovery_code: 0,
      mfa_setup: 0,
      account_status: 0,
      account_credentials: 0,
      ip_controls: 0,
    });
    const args = auditLog.findMany.mock.calls[0]![0] as { orderBy: unknown; take: number; where: { AND: [{ eventType: { in: string[] } }] } };
    // Stable order with a unique tie-breaker; security types only.
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(25);
    expect(args.where.AND[0].eventType.in).toEqual(Object.keys(SECURITY_EVENTS));
    expect(auditLog.groupBy.mock.calls[0]![0]).toMatchObject({ where: args.where.AND[0] });
  });

  it('chart, cards and sources use the date range only; the table uses every filter', async () => {
    const { service, auditLog, db } = setup();
    const res = await service.list(q({ category: 'recovery_code', outcome: 'completed', actorType: 'ADMIN', tz: 'Australia/Perth' }), NOW);
    const window = (auditLog.findMany.mock.calls[0]![0] as { where: { AND: [unknown, unknown] } }).where.AND[0];
    expect(auditLog.groupBy.mock.calls[0]![0]).toMatchObject({ where: window });
    expect(auditLog.groupBy.mock.calls[1]![0]).toMatchObject({ where: { ...(window as object), ipPrefix: { not: null } }, take: 5 });
    // Bound parameters only; the zone is never spliced into the SQL.
    expect(db.$queryRaw.mock.calls[0]).toContain('Australia/Perth');
    expect((db.$queryRaw.mock.calls[0]![0] as string[]).join('')).not.toContain('Australia/Perth');
    expect(res.series).toEqual({ unit: 'day', timeZone: 'Australia/Perth', bins: [{ bin: '2026-10-30T00:00', signIn: 1, mfaFailure: 2 }] });
  });

  it('hourly bins up to 2 days, daily beyond; UTC without a zone', async () => {
    const { service, db } = setup();
    const short = await service.list(q({ from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00Z' }), NOW);
    expect(short.series).toMatchObject({ unit: 'hour', timeZone: 'UTC' });
    const long = await service.list(q({ from: '2026-10-01T00:00:00Z', to: '2026-10-03T00:00:00.001Z' }), NOW);
    expect(long.series.unit).toBe('day');
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('sources are masked networks only (a stray full address is dropped), so nothing is a block target', async () => {
    const { service } = setup();
    expect((await service.list(q({}), NOW)).sources).toEqual([{ network: '203.0.113.0/24', count: 3 }]);
  });

  it('attribution: unverified by default; trusted only for rows recorded from the verification date', async () => {
    const at = new Date('2026-10-30T12:00:00.000Z');
    const { service } = setup([row({ createdAt: at }), row({ createdAt: new Date(at.getTime() - 1) })], at);
    const res = await service.list(q({}), NOW);
    expect(res.items.map((e) => e.sourceTrusted)).toEqual([true, false]);
    // The window starts before verification, so a network's rows can't all be vouched for.
    expect(res.sourcesTrusted).toBe(false);
    expect((await service.list(q({ from: at.toISOString() }), NOW)).sourcesTrusted).toBe(true);
    expect((await setup().service.list(q({}), NOW)).items[0]!.sourceTrusted).toBe(false);
  });

  it('filters: category + outcome narrow the types; account is the recorded User subject; exact reference', async () => {
    const { service, auditLog } = setup();
    await service.list(
      q({ category: 'admin_sign_in', outcome: 'completed', actorType: 'ADMIN', accountId: ADMIN, reference: ROW }),
      NOW,
    );
    const where = (auditLog.findMany.mock.calls[0]![0] as { where: { AND: unknown[] } }).where.AND[1];
    expect(where).toEqual({
      eventType: { in: ['ADMIN_PASSWORD_AUTH_SUCCEEDED', 'ADMIN_MFA_VERIFIED', 'ADMIN_LOGIN', 'ADMIN_LOGOUT'] },
      actorType: 'ADMIN',
      id: ROW,
      subjectType: 'User',
      subjectId: ADMIN,
    });
    // No overlap (sign-in events never fail here) → matches nothing, not everything.
    await service.list(q({ category: 'admin_sign_in', outcome: 'failed' }), NOW);
    expect((auditLog.findMany.mock.calls[1]![0] as { where: { AND: [unknown, { eventType: unknown }] } }).where.AND[1].eventType).toEqual({ in: [] });
  });

  it('date range: inclusive bounds, from ≤ to, at most 366 days', async () => {
    const { service, auditLog } = setup();
    await service.list(q({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' }), NOW);
    expect((auditLog.findMany.mock.calls[0]![0] as { where: { AND: [{ createdAt: unknown }] } }).where.AND[0].createdAt).toEqual({
      gte: new Date('2026-10-01T00:00:00.000Z'),
      lte: new Date('2026-10-02T00:00:00.000Z'),
    });
    await expect(service.list(q({ from: '2026-10-02T00:00:00Z', to: '2026-10-01T00:00:00Z' }), NOW)).rejects.toThrow(BadRequestException);
    await expect(service.list(q({ from: '2025-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' }), NOW)).rejects.toThrow(/366 days/);
  });

  it('a failed query is an error, never zero counts', async () => {
    const { service, auditLog } = setup();
    auditLog.groupBy.mockRejectedValueOnce(new Error('db down'));
    await expect(service.list(q({}), NOW)).rejects.toThrow('db down');
  });

  it('detail: security rows only; others are not found', async () => {
    const { service, auditLog } = setup([]);
    await expect(service.get(ROW)).rejects.toThrow(NotFoundException);
    expect(auditLog.findFirst.mock.calls[0]![0]).toMatchObject({ where: { id: ROW, eventType: { in: Object.keys(SECURITY_EVENTS) } } });
  });

  it('query validation: enums and UUIDs only; unknown keys rejected by the global pipe', async () => {
    const bad = [{ category: 'brute_force' }, { outcome: 'blocked' }, { actorType: 'RECIPIENT' }, { reference: 'abc' }, { accountId: 'a@b.c' }, { from: 'yesterday' }, { limit: 101 }, { tz: 'Mars/Base' }, { tz: '+05:30' }, { tz: "UTC'; DROP TABLE x" }];
    for (const body of bad) expect(await validate(q(body))).not.toHaveLength(0);
    expect(await validate(q({ category: 'mfa_failure', outcome: 'failed', actorType: 'SUPER_ADMIN', accountId: ADMIN, tz: 'Australia/Perth' }))).toHaveLength(0);
  });
});

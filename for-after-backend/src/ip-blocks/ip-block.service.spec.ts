import { BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { THROTTLER_LIMIT } from '@nestjs/throttler/dist/throttler.constants.js';
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { assertCanManageIpBlocks, RECENT_AUTH_MS } from '../admin/admin-access.service.js';
import { AdminIpBlocksController } from '../admin/admin.controller.js';
import { CreateIpBlockDto, IpBlockQueryDto } from '../admin/dto/admin.dto.js';
import { AuditActorType, UserRole } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { IpBlockMiddleware } from './ip-block.middleware.js';
import { IpBlockService, isBlockableAddress, IP_BLOCK_UNAVAILABLE, normalizeIp } from './ip-block.service.js';

const NOW = Date.parse('2026-11-05T00:00:00.000Z');
const IP = '203.0.113.7';
const actor = { type: AuditActorType.SUPER_ADMIN, userId: '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11', ip: '198.51.100.1' };
const input = { ip: IP, durationMinutes: 60, reason: 'Fictional reason' };

const setup = (env: Record<string, string> = { IP_ATTRIBUTION_VERIFIED_AT: '2026-01-01T00:00:00Z' }) => {
  const ipBlock = {
    findMany: vi.fn(async (_a: unknown): Promise<object[]> => []),
    count: vi.fn(async (_a: unknown) => 0),
    create: vi.fn(async ({ data }: { data: object }) => ({ id: 'b1', createdAt: new Date(NOW), revokedAt: null, revokedById: null, ...data })),
    updateMany: vi.fn(async (_a: unknown) => ({ count: 1 })),
    findUnique: vi.fn(async (_a: unknown) => null as object | null),
  };
  const auditLog = { create: vi.fn(async (_a: { data: { ipPrefix: unknown; metadata: unknown } }) => ({ id: 'a1' })) };
  const tx = { ipBlock, auditLog, $executeRaw: vi.fn(async () => 1) };
  const db = {
    ipBlock,
    user: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn((arg: unknown) => (typeof arg === 'function' ? (arg as (t: typeof tx) => unknown)(tx) : Promise.all(arg as unknown[]))),
  };
  const config = { get: (k: string) => env[k] } as unknown as ConfigService;
  return { service: new IpBlockService(db as unknown as PrismaService, config), ipBlock, auditLog, tx };
};
const withBlock = async (expiresAt = new Date(NOW + 3_600_000)) => {
  const s = setup();
  s.ipBlock.findMany.mockResolvedValue([{ ip: IP, expiresAt }]);
  await s.service.refresh();
  return s;
};

describe('address handling', () => {
  it('normalises IPv4, IPv6 and IPv4-mapped IPv6 to one form', () => {
    expect(normalizeIp(' 203.0.113.7 ')).toBe(IP);
    expect(normalizeIp('::ffff:203.0.113.7')).toBe(IP);
    expect(normalizeIp('::FFFF:CB00:7107')).toBe(IP);
    expect(normalizeIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1');
  });

  it('refuses anything but one complete address: masked prefixes, ranges, odd forms, zones', () => {
    for (const bad of ['203.0.113.0/24', '2001:db8::/48', '0:0:0::/48', '203.0.113', '0xcb.0.113.7', '127.1', 'fe80::1%eth0', 'x-forwarded-for: 1.2.3.4', '', null, undefined]) {
      expect(normalizeIp(bad)).toBeNull();
    }
  });

  it('only public addresses are blockable (documentation ranges are the fixture exception)', () => {
    for (const ok of ['8.8.8.8', '2606:4700::1', IP, '2001:db8::1']) expect(isBlockableAddress(ok)).toBe(true);
    for (const bad of ['127.0.0.1', '::1', '0.0.0.0', '::', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255', 'fe80::1', 'fc00::1', 'ff02::1', '240.0.0.1']) {
      expect(isBlockableAddress(bad)).toBe(false);
    }
  });
});

describe('IpBlockService', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('unverified attribution: nothing is created, enforced or polled', async () => {
    const { service, ipBlock } = setup({});
    await expect(service.create(input, actor, [])).rejects.toThrow(new ConflictException(IP_BLOCK_UNAVAILABLE));
    await service.onModuleInit();
    await service.refresh();
    expect(ipBlock.findMany).not.toHaveBeenCalled();
    expect(service.isBlocked(IP)).toBe(false);
  });

  it('a verification date in the future is not verified yet; an invalid one or a bad protected list refuses to start', () => {
    expect(setup({ IP_ATTRIBUTION_VERIFIED_AT: '2999-01-01T00:00:00Z' }).service.enforcing()).toBe(false);
    expect(() => setup({ IP_ATTRIBUTION_VERIFIED_AT: 'soon' })).toThrow(/ISO date/);
    expect(() => setup({ IP_BLOCK_PROTECTED_IPS: '10.0.0.0/8' })).toThrow(/exact IP/);
  });

  it('enforces exact addresses only, in any form; expiry applies even if no poll has run', async () => {
    const { service } = await withBlock();
    expect(service.isBlocked(IP, NOW)).toBe(true);
    expect(service.isBlocked(`::ffff:${IP}`, NOW)).toBe(true);
    expect(service.isBlocked('203.0.113.8', NOW)).toBe(false);
    expect(service.isBlocked(undefined, NOW)).toBe(false);
    expect(service.isBlocked(IP, NOW + 3_600_000)).toBe(false);
  });

  it('a failed poll keeps the last snapshot and is logged without detail', async () => {
    const { service, ipBlock } = await withBlock();
    ipBlock.findMany.mockRejectedValue(new Error('db down: secret-host'));
    await service.refresh();
    expect(service.isBlocked(IP, NOW)).toBe(true);
    expect(Logger.prototype.error).toHaveBeenCalledWith('ip_block_refresh_failed Error');
  });

  it('a poll picks up another instance’s revocation', async () => {
    const { service, ipBlock } = await withBlock();
    ipBlock.findMany.mockResolvedValue([]);
    await service.refresh();
    expect(service.isBlocked(IP, NOW)).toBe(false);
  });

  it('blocked requests are logged at most once a minute per address, masked', async () => {
    const { service } = await withBlock();
    for (let i = 0; i < 20; i++) service.isBlocked(IP, NOW + i);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith('ip_block_rejected network 203.0.113.0/24');
    service.isBlocked(IP, NOW + 60_000);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
  });

  it('refuses masked, private, operator, proxy and protected targets before touching the database', async () => {
    const { service, tx } = setup({ IP_ATTRIBUTION_VERIFIED_AT: '2026-01-01T00:00:00Z', IP_BLOCK_PROTECTED_IPS: '198.51.100.9' });
    const refused = async (ip: string, requestIps: string[] = []) =>
      expect(service.create({ ...input, ip }, actor, requestIps)).rejects.toThrow(BadRequestException);
    await refused('203.0.113.0/24');
    await refused('10.0.0.1');
    await refused('198.51.100.9');
    await refused(IP, [`::ffff:${IP}`]);
    await refused(IP, ['198.51.100.1', IP]);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('create: under the lock, refuses a duplicate; audit holds the masked network, never the address or reason', async () => {
    const { service, ipBlock, auditLog, tx } = setup();
    const made = await service.create({ ...input, ip: `::ffff:${IP}` }, actor, []);
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(made).toMatchObject({ ip: IP, status: 'active' });
    const audit = auditLog.create.mock.calls[0]![0].data;
    expect(audit).toMatchObject({ eventType: 'IP_BLOCK_CREATED', subjectType: 'IpBlock', subjectId: 'b1', ipPrefix: '198.51.100.0/24' });
    expect(audit.metadata).toEqual({ network: '203.0.113.0/24', durationMinutes: 60 });
    expect(JSON.stringify(audit)).not.toMatch(/203\.0\.113\.7|Fictional/);
    ipBlock.count.mockResolvedValueOnce(1);
    await expect(service.create(input, actor, [])).rejects.toThrow(/already has an active/);
    expect(ipBlock.create).toHaveBeenCalledOnce();
  });

  it('revoke: works with attribution unset; an ended block is a conflict with no audit row', async () => {
    const { service, ipBlock, auditLog } = setup({});
    const row = { id: 'b1', ip: IP, reason: 'r', createdById: actor.userId, createdAt: new Date(NOW), expiresAt: new Date(NOW), revokedAt: new Date(NOW), revokedById: actor.userId };
    ipBlock.findUnique.mockResolvedValue(row);
    await expect(service.revoke('b1', actor)).resolves.toMatchObject({ status: 'revoked' });
    expect(auditLog.create).toHaveBeenCalledOnce();
    ipBlock.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.revoke('b1', actor)).rejects.toThrow(ConflictException);
    expect(auditLog.create).toHaveBeenCalledOnce();
  });

  it('list: status is derived; other admins see the masked network only', async () => {
    const { service, ipBlock } = setup();
    const base = { ip: IP, reason: 'Fictional', createdById: actor.userId, createdAt: new Date(NOW), revokedById: null };
    ipBlock.findMany.mockResolvedValue([
      { ...base, id: 'a', expiresAt: new Date(NOW + 1000), revokedAt: null },
      { ...base, id: 'b', expiresAt: new Date(NOW - 1000), revokedAt: null },
      { ...base, id: 'c', expiresAt: new Date(NOW + 1000), revokedAt: new Date(NOW) },
    ]);
    const view = await service.list({ page: 1, limit: 25 }, { superAdmin: false, recentAuth: true }, new Date(NOW));
    expect(view.items.map((i) => i.status)).toEqual(['active', 'expired', 'revoked']);
    expect(view.items[0]).toMatchObject({ ip: null, reason: null, network: '203.0.113.0/24' });
    const root = await service.list({ page: 1, limit: 25 }, { superAdmin: true, recentAuth: true }, new Date(NOW));
    expect(root.items[0]).toMatchObject({ ip: IP, reason: 'Fictional' });
  });
});

describe('IpBlockMiddleware', () => {
  const run = (originalUrl: string, blocked = true) => {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    new IpBlockMiddleware({ isBlocked: () => blocked } as unknown as IpBlockService).use({ originalUrl, ip: IP } as never, res as never, next);
    return { next, res };
  };

  it('blocks app and API routes in any case; only health and the exact Stripe webhook are exempt', () => {
    for (const url of ['/api/v1/recipients', '/API/V1/RECIPIENTS', '/api/v1/auth/login?x=1', '/api/v1/webhooks/stripe/extra', '/healthy', '/api/v1/health', '/api/v1/recipients?x=/health']) {
      const { next, res } = run(url);
      expect(next, url).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
    for (const url of ['/health/live', '/HEALTH/ready', '/api/v1/webhooks/stripe', '/api/v1/webhooks/stripe?x=1']) {
      expect(run(url).next, url).toHaveBeenCalled();
    }
    expect(run('/api/v1/recipients', false).next).toHaveBeenCalled();
  });
});

describe('authorization and validation', () => {
  it('SUPER_ADMIN with two-factor in the last 15 minutes only', () => {
    expect(() => assertCanManageIpBlocks(UserRole.ADMIN, NOW, NOW)).toThrow(ForbiddenException);
    expect(() => assertCanManageIpBlocks(UserRole.SUPER_ADMIN, undefined, NOW)).toThrow(/sign in again/);
    expect(() => assertCanManageIpBlocks(UserRole.SUPER_ADMIN, NOW - RECENT_AUTH_MS - 1, NOW)).toThrow(/sign in again/);
    expect(() => assertCanManageIpBlocks(UserRole.SUPER_ADMIN, NOW - RECENT_AUTH_MS, NOW)).not.toThrow();
  });

  it('changes are rate limited', () => {
    for (const m of ['create', 'revoke'] as const) {
      expect(Reflect.getMetadata(`${THROTTLER_LIMIT}default`, AdminIpBlocksController.prototype[m])).toBe(30);
    }
  });

  it('only the listed durations, a required bounded reason, known statuses', async () => {
    const dto = (b: object) => plainToInstance(CreateIpBlockDto, { ...input, ...b });
    for (const b of [{ durationMinutes: 61 }, { durationMinutes: 0 }, { durationMinutes: 'forever' }, { reason: '   ' }, { reason: 'x'.repeat(501) }, { ip: '' }]) {
      expect(await validate(dto(b)), JSON.stringify(b)).not.toHaveLength(0);
    }
    for (const durationMinutes of [15, 60, 1440]) expect(await validate(dto({ durationMinutes }))).toHaveLength(0);
    expect(await validate(plainToInstance(IpBlockQueryDto, { status: 'spamming' }))).not.toHaveLength(0);
  });
});

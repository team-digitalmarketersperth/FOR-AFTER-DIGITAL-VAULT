import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';
import { type AuditActor, ipPrefix, paginate, writeAuditLog } from '../audit/audit-log.service.js';
import { AuditEventType, type Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const IP_BLOCK_DURATIONS = [15, 60, 1440] as const;
export const IP_BLOCK_STATUSES = ['active', 'expired', 'revoked'] as const;
export type IpBlockStatus = (typeof IP_BLOCK_STATUSES)[number];
export const IP_BLOCK_UNAVAILABLE = 'IP blocking is unavailable for this source.';
export const IP_BLOCK_REASON_MAX = 500;
export const IP_BLOCK_POLL_MS = 15_000;
export const IP_BLOCK_MAX_ACTIVE = 1000;
const LOG_EVERY_MS = 60_000;

// Reserved addresses that can never be a real client: harmless to allow, and they
// let fixtures exercise a block without ever touching a real address.
const DOCUMENTATION = ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24', '2001:db8::/32'].map((c) => ipaddr.parseCIDR(c));

/** One complete address in canonical form (::ffff:a.b.c.d → a.b.c.d), or null. Ranges, prefixes and zones are null. */
export const normalizeIp = (raw?: string | null): string | null => {
  const s = raw?.trim();
  return s && isIP(s) && !s.includes('%') ? ipaddr.process(s).toString() : null;
};

/** Public unicast only: never loopback, private, link-local, multicast or other special ranges. */
export const isBlockableAddress = (ip: string) => {
  const a = ipaddr.parse(ip);
  return (
    a.range() === 'unicast' ||
    DOCUMENTATION.some(([net, bits]) => net.kind() === a.kind() && (a as ipaddr.IPv4).match(net as ipaddr.IPv4, bits))
  );
};

const activeWhere = (now: Date): Prisma.IpBlockWhereInput => ({ revokedAt: null, expiresAt: { gt: now } });
const statusWhere = (status: IpBlockStatus, now: Date): Prisma.IpBlockWhereInput =>
  status === 'active' ? activeWhere(now) : status === 'revoked' ? { revokedAt: { not: null } } : { revokedAt: null, expiresAt: { lte: now } };

type Row = Prisma.IpBlockGetPayload<object>;
type Viewer = { superAdmin: boolean; recentAuth: boolean };

/**
 * Manual temporary exact-IP blocks (docs/admin.md §20a). Postgres is the source of
 * truth; each API instance enforces from an in-memory snapshot re-read every
 * IP_BLOCK_POLL_MS, so a request costs no I/O, a datastore outage keeps the last
 * snapshot, and expiry is checked per request whatever the poll is doing.
 */
@Injectable()
export class IpBlockService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IpBlockService.name);
  /** Rows recorded from this instant have a verified proxy chain; null = never verified. */
  readonly verifiedFrom: Date | null;
  private readonly protectedIps: Set<string>;
  private active = new Map<string, { expiresAt: number; loggedAt: number }>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const verified = config.get<string>('IP_ATTRIBUTION_VERIFIED_AT')?.trim();
    this.verifiedFrom = verified ? new Date(verified) : null;
    if (this.verifiedFrom && Number.isNaN(this.verifiedFrom.getTime())) {
      throw new Error('IP_ATTRIBUTION_VERIFIED_AT must be an ISO date.');
    }
    this.protectedIps = new Set(
      (config.get<string>('IP_BLOCK_PROTECTED_IPS') ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
        .map((v) => {
          const ip = normalizeIp(v);
          if (!ip) throw new Error('IP_BLOCK_PROTECTED_IPS must list exact IP addresses.');
          return ip;
        }),
    );
  }

  async onModuleInit() {
    if (!this.verifiedFrom) return;
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), IP_BLOCK_POLL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  enforcing(now = new Date()) {
    return !!this.verifiedFrom && this.verifiedFrom <= now;
  }

  /** A failed read keeps the previous snapshot; the next poll retries. */
  async refresh() {
    if (!this.verifiedFrom) return;
    try {
      const rows = await this.prisma.ipBlock.findMany({
        where: activeWhere(new Date()),
        select: { ip: true, expiresAt: true },
        take: IP_BLOCK_MAX_ACTIVE,
      });
      this.active = new Map(
        rows.map((r) => [r.ip, { expiresAt: r.expiresAt.getTime(), loggedAt: this.active.get(r.ip)?.loggedAt ?? 0 }]),
      );
    } catch (err) {
      this.logger.error(`ip_block_refresh_failed ${err instanceof Error ? err.name : 'unknown'}`);
    }
  }

  /** Per request: no I/O. Logs at most once a minute per blocked address, masked; never an audit row. */
  isBlocked(rawIp: string | undefined, now = Date.now()) {
    if (this.active.size === 0 || !this.enforcing(new Date(now))) return false;
    const ip = normalizeIp(rawIp);
    const entry = ip ? this.active.get(ip) : undefined;
    if (!entry || entry.expiresAt <= now) return false;
    if (now - entry.loggedAt >= LOG_EVERY_MS) {
      entry.loggedAt = now;
      this.logger.warn(`ip_block_rejected network ${ipPrefix(ip!)}`);
    }
    return true;
  }

  /** `requestIps`: the operator's own address and the peer in front of the API, never blockable. */
  async create(input: { ip: string; durationMinutes: number; reason: string }, actor: AuditActor, requestIps: (string | undefined)[]) {
    if (!this.enforcing()) throw new ConflictException(IP_BLOCK_UNAVAILABLE);
    const ip = normalizeIp(input.ip);
    if (!ip) throw new BadRequestException('Enter one complete IP address. Ranges and masked networks can’t be blocked.');
    if (!isBlockableAddress(ip)) throw new BadRequestException('This address is private, reserved or internal, so it can’t be blocked.');
    if (requestIps.some((r) => normalizeIp(r) === ip)) {
      throw new BadRequestException('This is your current address or the proxy in front of the API, so it can’t be blocked.');
    }
    if (this.protectedIps.has(ip)) throw new BadRequestException('This address is protected infrastructure, so it can’t be blocked.');

    const row = await this.prisma.$transaction(async (tx) => {
      // One lock for every create: serialises the duplicate and capacity checks. Low volume.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('ip-block'))`;
      const now = new Date();
      if (await tx.ipBlock.count({ where: { ...activeWhere(now), ip } })) {
        throw new ConflictException('This address already has an active temporary block.');
      }
      if ((await tx.ipBlock.count({ where: activeWhere(now) })) >= IP_BLOCK_MAX_ACTIVE) {
        throw new ConflictException('Too many active temporary blocks. Revoke one before adding another.');
      }
      const created = await tx.ipBlock.create({
        data: { ip, reason: input.reason, createdById: actor.userId, expiresAt: new Date(now.getTime() + input.durationMinutes * 60_000) },
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.IP_BLOCK_CREATED,
        actor,
        subjectType: 'IpBlock',
        subjectId: created.id,
        metadata: { network: ipPrefix(ip), durationMinutes: input.durationMinutes },
      });
      return created;
    });
    await this.refresh();
    return (await this.present([row], { superAdmin: true, recentAuth: true }))[0]!;
  }

  /** Always allowed, even with attribution unset: ending a block can only restore access. */
  async revoke(id: string, actor: AuditActor) {
    const row = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const { count } = await tx.ipBlock.updateMany({ where: { id, ...activeWhere(now) }, data: { revokedAt: now, revokedById: actor.userId } });
      const found = await tx.ipBlock.findUnique({ where: { id } });
      if (!found) throw new NotFoundException('Temporary block not found.');
      if (!count) throw new ConflictException('This temporary block has already ended.');
      await writeAuditLog(tx, {
        eventType: AuditEventType.IP_BLOCK_REVOKED,
        actor,
        subjectType: 'IpBlock',
        subjectId: id,
        metadata: { network: ipPrefix(found.ip) },
      });
      return found;
    });
    await this.refresh();
    return (await this.present([row], { superAdmin: true, recentAuth: true }))[0]!;
  }

  async list(q: { page: number; limit: number; status?: IpBlockStatus }, viewer: Viewer, now = new Date()) {
    const where = q.status ? statusWhere(q.status, now) : {};
    const [rows, total, activeCount] = await this.prisma.$transaction([
      this.prisma.ipBlock.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (q.page - 1) * q.limit, take: q.limit }),
      this.prisma.ipBlock.count({ where }),
      this.prisma.ipBlock.count({ where: activeWhere(now) }),
    ]);
    return {
      controls: {
        available: this.enforcing(now),
        superAdmin: viewer.superAdmin,
        recentAuth: viewer.recentAuth,
        activeCount,
      },
      items: await this.present(rows, viewer, now),
      pagination: paginate(q.page, q.limit, total),
    };
  }

  /** Exact address and reason for SUPER_ADMIN; other admins see only the masked network. */
  private async present(rows: Row[], viewer: Viewer, now = new Date()) {
    const ids = [...new Set(rows.flatMap((r) => (r.revokedById ? [r.createdById, r.revokedById] : [r.createdById])))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, firstName: true, lastName: true } });
    const name = (id: string | null) => {
      const u = users.find((x) => x.id === id);
      return u ? `${u.firstName} ${u.lastName ?? ''}`.trim() : null;
    };
    return rows.map((r) => ({
      id: r.id,
      ip: viewer.superAdmin ? r.ip : null,
      network: ipPrefix(r.ip),
      reason: viewer.superAdmin ? r.reason : null,
      createdByName: name(r.createdById),
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt?.toISOString() ?? null,
      revokedByName: name(r.revokedById),
      status: (r.revokedAt ? 'revoked' : r.expiresAt <= now ? 'expired' : 'active') as IpBlockStatus,
    }));
  }
}

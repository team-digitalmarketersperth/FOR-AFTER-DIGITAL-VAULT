import { Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { isIPv4, isIPv6 } from 'node:net';
import {
  AuditActorType,
  type AuditEventType,
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Who did it, from where. Raw IPs are never stored (see ipPrefix). */
export type AuditActor = {
  type: AuditActorType;
  userId: string;
  ip?: string;
  userAgent?: string;
};

// Scalars only, so a request body or object can never be copied in whole.
export type AuditMetadata = Record<string, string | number | boolean | null>;

export type AuditEntry = {
  eventType: AuditEventType;
  actor: AuditActor;
  subjectType?: string;
  subjectId?: string;
  metadata?: AuditMetadata;
};

// Defence in depth: keys that could carry a secret or private content are
// dropped even if a caller passes them.
const SENSITIVE_KEY =
  /pass|secret|token|code|otp|cookie|session|note|content|answer|url|key/i;

const sanitizeMetadata = (metadata?: AuditMetadata) => {
  if (!metadata) return undefined;
  const safe = Object.entries(metadata)
    .filter(([k]) => !SENSITIVE_KEY.test(k))
    .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 1000) : v]);
  return safe.length ? Object.fromEntries(safe) : undefined;
};

/**
 * IPv4 → /24 (203.0.113.0/24), IPv6 → /48. Enough to spot a network during an
 * incident, not enough to identify a household. ::ffff:a.b.c.d counts as IPv4.
 */
export const ipPrefix = (ip?: string): string | null => {
  const v4 = ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (v4 && isIPv4(v4)) return `${v4.split('.').slice(0, 3).join('.')}.0/24`;
  if (ip && isIPv6(ip)) {
    const [head, tail = ''] = ip.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = [
      ...left,
      ...Array<string>(8 - left.length - right.length).fill('0'),
      ...right,
    ];
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return null;
};

export const actorTypeFor = (role: UserRole): AuditActorType =>
  role === UserRole.SUPER_ADMIN
    ? AuditActorType.SUPER_ADMIN
    : AuditActorType.ADMIN;

/** The admin behind a guarded request (req.user is set by SessionAuthGuard). */
export const adminActor = (req: Request, user = req.user!): AuditActor => ({
  type: actorTypeFor(user.role),
  userId: user.id,
  ip: req.ip,
  userAgent: req.headers['user-agent'],
});

/**
 * Appends one AuditLog row, inside the caller's transaction when given one, so
 * the record commits (or rolls back) with the change it describes.
 */
export const writeAuditLog = (
  db: Prisma.TransactionClient,
  { eventType, actor, subjectType, subjectId, metadata }: AuditEntry,
) =>
  db.auditLog.create({
    data: {
      eventType,
      actorType: actor.type,
      actorUserId: actor.userId,
      subjectType: subjectType ?? null,
      subjectId: subjectId ?? null,
      ipPrefix: ipPrefix(actor.ip),
      userAgent: actor.userAgent?.slice(0, 256) ?? null,
      metadata: sanitizeMetadata(metadata),
    },
    select: { id: true },
  });

export const auditLogSelect = {
  id: true,
  eventType: true,
  actorType: true,
  actorUserId: true,
  subjectType: true,
  subjectId: true,
  ipPrefix: true,
  userAgent: true,
  metadata: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;

export type AuditLogQuery = {
  page: number;
  limit: number;
  eventType?: AuditEventType;
  actorUserId?: string;
  subjectType?: string;
  subjectId?: string;
  from?: string;
  to?: string;
};

export const paginate = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  pages: Math.ceil(total / limit),
});

/** Append-only: there is deliberately no update or delete here. */
@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  record(entry: AuditEntry, db: Prisma.TransactionClient = this.prisma) {
    return writeAuditLog(db, entry);
  }

  async list(q: AuditLogQuery) {
    const where: Prisma.AuditLogWhereInput = {
      eventType: q.eventType,
      actorUserId: q.actorUserId,
      subjectType: q.subjectType,
      subjectId: q.subjectId,
      createdAt:
        q.from || q.to
          ? {
              gte: q.from ? new Date(q.from) : undefined,
              lte: q.to ? new Date(q.to) : undefined,
            }
          : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: auditLogSelect,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, pagination: paginate(q.page, q.limit, total) };
  }

  async get(id: string) {
    const found = await this.prisma.auditLog.findUnique({
      where: { id },
      select: auditLogSelect,
    });
    if (!found) throw new NotFoundException('Audit log entry not found.');
    return found;
  }
}

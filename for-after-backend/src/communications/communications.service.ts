import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { writeAuditLog, type AuditActor, type SystemAuditActor } from '../audit/audit-log.service.js';
import { AuditActorType, AuditEventType, type Prisma, type SuppressionReason } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** sha256 of the lower-cased address: how suppressions and broadcast recipients refer to an address. */
export const emailHash = (email: string) => createHash('sha256').update(email.toLowerCase(), 'utf8').digest('hex');

// Bumped only if the consent wording in Account settings changes meaningfully.
export const CONSENT_WORDING = 'product-news-v1';
export const INVALID_UNSUBSCRIBE = 'This unsubscribe link is not valid. You can change email preferences in your Account settings.';

const unsubscribeKey = (secret: string) => createHmac('sha256', secret).update('announcement-unsubscribe/v1').digest();

/** A per-recipient link token: the account and the hash of the address the email went to. No expiry. */
export function signUnsubscribe(userId: string, hash: string, secret: string): string {
  const body = Buffer.from(JSON.stringify({ u: userId, h: hash })).toString('base64url');
  return `${body}.${createHmac('sha256', unsubscribeKey(secret)).update(body).digest('base64url')}`;
}

export function readUnsubscribe(token: string, secret: string): { u: string; h: string } | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', unsubscribeKey(secret)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { u?: unknown; h?: unknown };
    return typeof claims.u === 'string' && typeof claims.h === 'string' && /^[0-9a-f]{64}$/.test(claims.h) ? { u: claims.u, h: claims.h } : null;
  } catch {
    return null;
  }
}

// A stronger reason replaces a weaker one (an unsubscribed address that later bounces is recorded as bounced).
const STRENGTH: Record<SuppressionReason, number> = { UNSUBSCRIBED: 0, HARD_BOUNCE: 1, COMPLAINT: 2 };

/** Adds (or strengthens) a suppression with its audit row. Returns whether anything changed. Never stores the address. */
export async function suppress(
  db: Prisma.TransactionClient,
  input: { emailHash: string; reason: SuppressionReason; userId: string | null },
  actor: AuditActor | SystemAuditActor = { type: AuditActorType.SYSTEM, userId: null },
): Promise<boolean> {
  const existing = await db.emailSuppression.findUnique({ where: { emailHash: input.emailHash }, select: { id: true, reason: true } });
  if (existing && STRENGTH[existing.reason] >= STRENGTH[input.reason]) return false;
  const row = existing
    ? await db.emailSuppression.update({ where: { id: existing.id }, data: { reason: input.reason }, select: { id: true } })
    : await db.emailSuppression.create({ data: input, select: { id: true } });
  await writeAuditLog(db, {
    eventType: AuditEventType.EMAIL_SUPPRESSED,
    actor,
    subjectType: 'EmailSuppression',
    subjectId: row.id,
    metadata: { reason: input.reason, accountId: input.userId, previous: existing?.reason ?? null },
  });
  return true;
}

/**
 * Notification centre Step 7: a Customer's consent to optional product news,
 * and the public unsubscribe link. Registration never grants consent; only the
 * Customer can (Account settings). Withdrawing (settings or link) is immediate;
 * the link also suppresses the address it was sent to.
 */
@Injectable()
export class CommunicationsService {
  private readonly logger = new Logger(CommunicationsService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.secret = config.get<string>('SESSION_SECRET') ?? '';
  }

  async preferences(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { marketingConsentAt: true } });
    return { productNews: !!user.marketingConsentAt, since: user.marketingConsentAt };
  }

  async setProductNews(userId: string, productNews: boolean, actor: AuditActor) {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { marketingConsentAt: true, email: true } });
      if (!!user.marketingConsentAt === productNews) return; // no change, no audit row
      await tx.user.update({ where: { id: userId }, data: { marketingConsentAt: productNews ? new Date() : null }, select: { id: true } });
      // Opting in again lifts the Customer's own unsubscribe, never a bounce or complaint.
      if (productNews) await tx.emailSuppression.deleteMany({ where: { emailHash: emailHash(user.email), reason: 'UNSUBSCRIBED' } });
      await writeAuditLog(tx, {
        eventType: productNews ? AuditEventType.MARKETING_CONSENT_GRANTED : AuditEventType.MARKETING_CONSENT_WITHDRAWN,
        actor,
        subjectType: 'User',
        subjectId: userId,
        metadata: { source: 'account_settings', wording: CONSENT_WORDING },
      });
    });
    return this.preferences(userId);
  }

  /** Public, idempotent. Consent withdrawn and the emailed address suppressed, even if the account is gone. */
  async unsubscribe(token: string): Promise<{ unsubscribed: true }> {
    const claims = readUnsubscribe(token, this.secret);
    if (!claims) throw new BadRequestException(INVALID_UNSUBSCRIBE);
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: claims.u }, select: { id: true, marketingConsentAt: true } });
      if (user?.marketingConsentAt) {
        await tx.user.update({ where: { id: user.id }, data: { marketingConsentAt: null }, select: { id: true } });
        await writeAuditLog(tx, {
          eventType: AuditEventType.MARKETING_CONSENT_WITHDRAWN,
          actor: { type: AuditActorType.SYSTEM, userId: null },
          subjectType: 'User',
          subjectId: user.id,
          metadata: { source: 'unsubscribe_link', wording: CONSENT_WORDING },
        });
      }
      await suppress(tx, { emailHash: claims.h, reason: 'UNSUBSCRIBED', userId: user?.id ?? null });
    });
    this.logger.log(`announcement_unsubscribed account ${claims.u}`);
    return { unsubscribed: true };
  }
}

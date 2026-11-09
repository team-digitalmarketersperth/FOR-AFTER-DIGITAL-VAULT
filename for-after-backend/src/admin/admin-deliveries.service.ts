import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DeathVerificationCaseStatus,
  Prisma,
  ReleaseNotificationStatus,
} from '../generated/prisma/client.js';
import { paginate } from '../audit/audit-log.service.js';
import { notificationJobId } from '../release-notifications/release-notification-queue.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AdminQueuesService } from './admin-queues.service.js';
import type { DeliveryListQueryDto } from './dto/admin.dto.js';

/**
 * Admin delivery monitoring (docs/admin.md §17): read-only views over the two
 * delivery records that exist durably — release "message waiting" emails
 * (ReleaseNotification) and the death-verification safety notice (fields on
 * DeathVerificationCase). Ids, states, counts, times and safe categories only:
 * never an address, subject, body, link, token, payload or provider text.
 * Nothing here sends, queues, retries or changes anything.
 */

// Error categories the email providers emit (src/email). Anything else stored
// in lastErrorCode is a provider-defined name and is shown only as
// 'provider_error'; forbidden_<code> is shown as 'forbidden'.
export const ERROR_CATEGORIES = [
  'timeout',
  'network_error',
  'token_unavailable',
  'auth_rejected',
  'unauthorized',
  'rate_limit_exceeded',
  'mailbox_not_found',
  'email_disabled',
  'unknown_error',
  'forbidden',
  'provider_error',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
const KNOWN = ERROR_CATEGORIES.filter((c) => c !== 'forbidden' && c !== 'provider_error');

export const errorCategory = (code: string | null): ErrorCategory | null => {
  if (!code) return null;
  if ((KNOWN as readonly string[]).includes(code)) return code as ErrorCategory;
  return code.startsWith('forbidden_') ? 'forbidden' : 'provider_error';
};

/**
 * A destination for admin screens, masked here so the full address never
 * reaches the browser: ruth@gmail.com → r***@g***.com. One-character parts
 * become '*', and anything malformed becomes '***' (never echoed). Not the
 * log helper maskEmail, which keeps the whole domain and echoes malformed input.
 */
export const maskDestination = (email: string | null): string | null => {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const tld = domain.slice(dot + 1);
  if (at < 1 || dot < 1 || !/^[a-z]{2,24}$/i.test(tld)) return '***';
  const part = (s: string) => {
    const chars = Array.from(s);
    return chars.length < 2 ? '*' : `${chars[0]}***`;
  };
  return `${part(local)}@${part(domain.slice(0, dot))}.${tld}`;
};

// The request may have reached the provider: it may or may not have sent it.
const UNCERTAIN = ['timeout', 'network_error'];

/** Release email display status, from stored fields only. */
export const RELEASE_EMAIL_STATUSES = ['queued', 'retrying', 'provider_accepted', 'failed'] as const;
export type ReleaseEmailStatus = (typeof RELEASE_EMAIL_STATUSES)[number];
/** Shared with the Overview counts so both pages count the same rows. */
export const releaseEmailWhere: Record<ReleaseEmailStatus, Prisma.ReleaseNotificationWhereInput> = {
  queued: { status: ReleaseNotificationStatus.PENDING, attemptCount: 0 },
  retrying: { status: ReleaseNotificationStatus.PENDING, attemptCount: { gt: 0 } },
  provider_accepted: { status: ReleaseNotificationStatus.SENT },
  failed: { status: ReleaseNotificationStatus.FAILED },
};
export const uncertainWhere: Prisma.ReleaseNotificationWhereInput = {
  status: { not: ReleaseNotificationStatus.SENT },
  lastErrorCode: { in: UNCERTAIN },
};
const releaseEmailStatus = (r: { status: ReleaseNotificationStatus; attemptCount: number }): ReleaseEmailStatus =>
  r.status === ReleaseNotificationStatus.SENT
    ? 'provider_accepted'
    : r.status === ReleaseNotificationStatus.FAILED
      ? 'failed'
      : r.attemptCount > 0
        ? 'retrying'
        : 'queued';

const errorCategoryWhere = (c: ErrorCategory): Prisma.ReleaseNotificationWhereInput =>
  c === 'forbidden'
    ? { lastErrorCode: { startsWith: 'forbidden_' } }
    : c === 'provider_error'
      ? {
          AND: [
            { lastErrorCode: { not: null } },
            { lastErrorCode: { notIn: KNOWN as unknown as string[] } },
            { NOT: { lastErrorCode: { startsWith: 'forbidden_' } } },
          ],
        }
      : { lastErrorCode: c };

/** Safety notice display status, from the case's own fields. */
export const SAFETY_NOTICE_STATUSES = ['queued', 'attempted', 'provider_accepted', 'not_sent_case_closed'] as const;
export type SafetyNoticeStatus = (typeof SAFETY_NOTICE_STATUSES)[number];
const PENDING = DeathVerificationCaseStatus.PENDING_VERIFICATION;
const safetyNoticeWhere: Record<SafetyNoticeStatus, Prisma.DeathVerificationCaseWhereInput> = {
  queued: { safetyNoticeSentAt: null, status: PENDING, safetyNoticeAttemptCount: 0 },
  attempted: { safetyNoticeSentAt: null, status: PENDING, safetyNoticeAttemptCount: { gt: 0 } },
  provider_accepted: { safetyNoticeSentAt: { not: null } },
  not_sent_case_closed: { safetyNoticeSentAt: null, status: { not: PENDING } },
};
const safetyNoticeStatus = (c: {
  safetyNoticeSentAt: Date | null;
  status: DeathVerificationCaseStatus;
  safetyNoticeAttemptCount: number;
}): SafetyNoticeStatus =>
  c.safetyNoticeSentAt
    ? 'provider_accepted'
    : c.status !== PENDING
      ? 'not_sent_case_closed'
      : c.safetyNoticeAttemptCount > 0
        ? 'attempted'
        : 'queued';

const range = (q: DeliveryListQueryDto) => {
  if (q.createdFrom && q.createdTo && new Date(q.createdFrom) > new Date(q.createdTo)) {
    throw new BadRequestException('createdFrom must be before createdTo');
  }
  return q.createdFrom || q.createdTo
    ? {
        createdAt: {
          ...(q.createdFrom && { gte: new Date(q.createdFrom) }),
          ...(q.createdTo && { lte: new Date(q.createdTo) }),
        },
      }
    : {};
};

export const DELIVERY_NOT_FOUND = 'Delivery not found.';

@Injectable()
export class AdminDeliveriesService {
  private readonly logger = new Logger(AdminDeliveriesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: AdminQueuesService,
  ) {}

  /** One category per request: each is its own table, paged on its own (no cross-table union). */
  list(q: DeliveryListQueryDto, now = new Date()) {
    return q.category === 'safety_notice' ? this.safetyNotices(q, now) : this.releaseEmails(q, now);
  }

  private async releaseEmails(q: DeliveryListQueryDto, now: Date) {
    if (q.status && !(RELEASE_EMAIL_STATUSES as readonly string[]).includes(q.status)) {
      throw new BadRequestException(`status must be one of: ${RELEASE_EMAIL_STATUSES.join(', ')}`);
    }
    const where: Prisma.ReleaseNotificationWhereInput = {
      AND: [
        q.status ? releaseEmailWhere[q.status as ReleaseEmailStatus] : {},
        q.outcomeUncertain ? uncertainWhere : {},
        q.errorCategory ? errorCategoryWhere(q.errorCategory) : {},
        q.reference ? { id: q.reference } : {},
        q.releaseReference ? { grant: { messageId: q.releaseReference } } : {},
        range(q),
      ],
    };
    const dir = q.dir ?? 'desc';
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.releaseNotification.findMany({
        where,
        orderBy: [{ [q.sort ?? 'createdAt']: dir }, { id: dir }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: {
          id: true,
          status: true,
          attemptCount: true,
          lastErrorCode: true,
          sentAt: true,
          failedAt: true,
          createdAt: true,
          updatedAt: true,
          occurrenceId: true,
          // Masked below; the full address never leaves the API.
          grant: { select: { messageId: true, recipientId: true, recipientEmailNormalized: true } },
        },
      }),
      this.prisma.releaseNotification.count({ where }),
    ]);
    return {
      evaluatedAt: now.toISOString(),
      category: 'release_email' as const,
      items: rows.map((r) => ({
        reference: r.id,
        channel: 'EMAIL' as const,
        releaseReference: r.grant.messageId,
        // Opaque: tells similar rows apart without contact details.
        recipientReference: r.grant.recipientId,
        destination: maskDestination(r.grant.recipientEmailNormalized),
        yearlyOccurrence: r.occurrenceId !== null,
        status: releaseEmailStatus(r),
        lastAttemptUncertain: r.status !== ReleaseNotificationStatus.SENT && UNCERTAIN.includes(r.lastErrorCode ?? ''),
        attemptCount: r.attemptCount,
        errorCategory: errorCategory(r.lastErrorCode),
        acceptedAt: r.sentAt,
        failedAt: r.failedAt,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      pagination: paginate(q.page, q.limit, total),
    };
  }

  private async safetyNotices(q: DeliveryListQueryDto, now: Date) {
    if (q.status && !(SAFETY_NOTICE_STATUSES as readonly string[]).includes(q.status)) {
      throw new BadRequestException(`status must be one of: ${SAFETY_NOTICE_STATUSES.join(', ')}`);
    }
    if (q.outcomeUncertain || q.errorCategory || q.releaseReference) {
      throw new BadRequestException('Safety notices record no error category, uncertain flag or release.');
    }
    const where: Prisma.DeathVerificationCaseWhereInput = {
      AND: [
        q.status ? safetyNoticeWhere[q.status as SafetyNoticeStatus] : {},
        q.reference ? { id: q.reference } : {},
        range(q),
      ],
    };
    const dir = q.dir ?? 'desc';
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.deathVerificationCase.findMany({
        where,
        orderBy: [{ [q.sort ?? 'createdAt']: dir }, { id: dir }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: {
          id: true,
          ownerUserId: true,
          status: true,
          safetyNoticeAttemptCount: true,
          safetyNoticeLastAttemptAt: true,
          safetyNoticeSentAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.deathVerificationCase.count({ where }),
    ]);
    return {
      evaluatedAt: now.toISOString(),
      category: 'safety_notice' as const,
      items: rows.map((c) => ({
        reference: c.id,
        channel: 'EMAIL' as const,
        accountId: c.ownerUserId,
        caseStatus: c.status,
        status: safetyNoticeStatus(c),
        attemptCount: c.safetyNoticeAttemptCount,
        lastAttemptAt: c.safetyNoticeLastAttemptAt,
        acceptedAt: c.safetyNoticeSentAt,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      })),
      pagination: paginate(q.page, q.limit, total),
    };
  }

  /** Logged, not audited (same policy as release detail, docs/admin.md §16). */
  async releaseEmail(reference: string, adminId: string, now = new Date()) {
    const r = await this.prisma.releaseNotification.findUnique({
      where: { id: reference },
      select: {
        id: true,
        status: true,
        attemptCount: true,
        lastErrorCode: true,
        providerMessageId: true,
        sentAt: true,
        failedAt: true,
        createdAt: true,
        updatedAt: true,
        occurrence: { select: { id: true, occurrenceYear: true, dueAt: true } },
        grant: {
          select: { messageId: true, messageReleaseId: true, recipientId: true, recipientEmailNormalized: true },
        },
      },
    });
    if (!r) throw new NotFoundException(DELIVERY_NOT_FOUND);
    // Optional queue details (Redis): null when unreadable; the stored record stands alone.
    const [job, deadLetters] = await Promise.all([
      r.status === ReleaseNotificationStatus.SENT
        ? Promise.resolve(undefined)
        : this.queues.jobState('email-delivery', notificationJobId(r.id)),
      this.prisma.deadLetterJob.findMany({
        where: { entityType: 'ReleaseNotification', entityId: r.id },
        orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
        take: 10,
        select: { id: true, queueName: true, errorCode: true, failedAt: true, failureCount: true, status: true },
      }),
    ]);
    this.logger.log(`admin_delivery_viewed release_email ${r.id} admin ${adminId}`);
    const history = [
      { at: r.createdAt, event: 'intent_created' as const },
      r.sentAt && { at: r.sentAt, event: 'provider_accepted' as const },
      r.failedAt && { at: r.failedAt, event: 'failed_for_good' as const },
      ...deadLetters.map((d) => ({ at: d.failedAt, event: 'dead_lettered' as const })),
    ]
      .filter((e): e is { at: Date; event: 'intent_created' | 'provider_accepted' | 'failed_for_good' | 'dead_lettered' } => !!e)
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    return {
      evaluatedAt: now.toISOString(),
      reference: r.id,
      category: 'release_email' as const,
      channel: 'EMAIL' as const,
      status: releaseEmailStatus(r),
      lastAttemptUncertain: r.status !== ReleaseNotificationStatus.SENT && UNCERTAIN.includes(r.lastErrorCode ?? ''),
      attemptCount: r.attemptCount,
      errorCategory: errorCategory(r.lastErrorCode),
      // The provider's own id for an accepted email (not a delivery receipt).
      providerMessageId: r.providerMessageId,
      acceptedAt: r.sentAt,
      failedAt: r.failedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      releaseReference: r.grant.messageId,
      messageReleaseId: r.grant.messageReleaseId,
      recipientReference: r.grant.recipientId,
      destination: maskDestination(r.grant.recipientEmailNormalized),
      occurrence: r.occurrence,
      // undefined = not looked up (already accepted); null = Redis unavailable.
      queueJob: job === undefined ? undefined : job,
      deadLetters,
      history,
    };
  }

  async safetyNotice(reference: string, adminId: string, now = new Date()) {
    const c = await this.prisma.deathVerificationCase.findUnique({
      where: { id: reference },
      select: {
        id: true,
        ownerUserId: true,
        status: true,
        safetyNoticeAttemptCount: true,
        safetyNoticeLastAttemptAt: true,
        safetyNoticeSentAt: true,
        openedAt: true,
        createdAt: true,
        updatedAt: true,
        // The case's own SAFETY_NOTICE_SENT event(s), id and time only.
        auditEvents: {
          where: { eventType: 'SAFETY_NOTICE_SENT' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5,
          select: { id: true, createdAt: true },
        },
      },
    });
    if (!c) throw new NotFoundException(DELIVERY_NOT_FOUND);
    this.logger.log(`admin_delivery_viewed safety_notice ${c.id} admin ${adminId}`);
    const history = [
      { at: c.openedAt, event: 'case_opened' as const },
      c.safetyNoticeLastAttemptAt && { at: c.safetyNoticeLastAttemptAt, event: 'last_attempt_started' as const },
      c.safetyNoticeSentAt && { at: c.safetyNoticeSentAt, event: 'provider_accepted' as const },
    ]
      .filter((e): e is { at: Date; event: 'case_opened' | 'last_attempt_started' | 'provider_accepted' } => !!e)
      .sort((a, b) => b.at.getTime() - a.at.getTime());
    return {
      evaluatedAt: now.toISOString(),
      reference: c.id,
      category: 'safety_notice' as const,
      channel: 'EMAIL' as const,
      accountId: c.ownerUserId,
      caseStatus: c.status,
      status: safetyNoticeStatus(c),
      attemptCount: c.safetyNoticeAttemptCount,
      lastAttemptAt: c.safetyNoticeLastAttemptAt,
      acceptedAt: c.safetyNoticeSentAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      caseEvents: c.auditEvents,
      history,
    };
  }
}

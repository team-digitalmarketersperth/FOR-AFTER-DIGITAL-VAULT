import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { paginate, writeAuditLog, type AuditActor } from '../audit/audit-log.service.js';
import { emailSettings } from '../email/email-provider.js';
import { announcement } from '../email/email-templates.js';
import { AuditEventType, type Prisma, UserStatus } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnnouncementTestQueue } from './announcement-test-queue.service.js';
import {
  ANNOUNCEMENT_DESTINATIONS,
  type AnnouncementContentDto,
  type CreateAnnouncementDto,
  type CreateTestSendDto,
  type UpdateAnnouncementDto,
} from './announcements.dto.js';

export const DRAFT_NOT_FOUND = 'Announcement draft not found.';
export const SENT_LOCKED = 'This announcement has been queued for customers and can no longer be edited. Create a new announcement to send again.';
// Recipient outcomes that mean a finished run did not reach every customer's provider acceptance.
const ISSUE_STATES = ['FAILED', 'UNKNOWN', 'SKIPPED', 'CANCELLED'] as const;
export const DRAFT_CHANGED =
  'This draft was changed by someone else since you opened it. Your text is still here: copy it, reload the draft, then apply your changes again.';
export const CTA_PAIRED = 'Add both a button label and a destination, or neither.';
export const TEST_VERSION_CHANGED = 'The saved draft has changed since you opened it. Reload it, then send a test of the latest saved version.';
export const TEST_OPERATION_REUSED = 'This test request id was already used for a different draft or version. Start a new test.';
export const TEST_NOT_VERIFIED = 'Your account email is not verified, so a test email cannot be sent to it.';
export const TEST_WINDOW_MS = 10 * 60_000;
export const TEST_LIMIT_PER_ADMIN = 3;
// Shared across all super admins, so test traffic stays small next to real email.
export const TEST_LIMIT_GLOBAL = 20;
const SUBJECT_TYPE = 'EmailAnnouncement';
// The admin's view of a test: status and times only, never the snapshot or the address.
const testSelect = {
  id: true,
  status: true,
  announcementVersion: true,
  lastErrorCode: true,
  createdAt: true,
  acceptedAt: true,
  finishedAt: true,
} satisfies Prisma.AnnouncementTestSendSelect;
const FIELDS = ['name', 'subject', 'body', 'ctaLabel', 'ctaDestination'] as const;
const fieldSelect = Object.fromEntries(FIELDS.map((f) => [f, true])) as Record<(typeof FIELDS)[number], true>;

// Admins as the rest of the admin portal shows them: name and email, no other account data.
const adminSelect = { select: { id: true, firstName: true, lastName: true, email: true } } as const;
const draftSelect = {
  id: true,
  status: true,
  name: true,
  subject: true,
  body: true,
  ctaLabel: true,
  ctaDestination: true,
  version: true,
  audience: true,
  createdAt: true,
  updatedAt: true,
  createdBy: adminSelect,
  updatedBy: adminSelect,
} satisfies Prisma.EmailAnnouncementSelect;

/** The configured sender as shown to admins. Microsoft Graph sends as EMAIL_FROM; Resend as EMAIL_FROM_ADDRESS. */
export const senderOf = (config: ConfigService) => {
  const settings = emailSettings(config);
  const address = (settings.provider === 'microsoft' ? config.get<string>('EMAIL_FROM') : settings.fromAddress) || null;
  return { name: settings.fromName, address };
};

/** Both CTA fields or neither (null). */
function cta(dto: AnnouncementContentDto) {
  const ctaLabel = dto.ctaLabel ?? null;
  const ctaDestination = dto.ctaDestination ?? null;
  if (!ctaLabel !== !ctaDestination) throw new BadRequestException(CTA_PAIRED);
  return { ctaLabel, ctaDestination };
}
const content = (dto: CreateAnnouncementDto) => ({ name: dto.name, subject: dto.subject, body: dto.body, ...cta(dto) });

/**
 * Notification centre, Step 1: email announcement drafts (SUPER_ADMIN only, see
 * the controller). Drafts and previews only: nothing here resolves recipients,
 * queues a job or calls the email provider. Subjects and text are never logged
 * or audited; audit rows carry the id, version and changed field names.
 */
@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly testQueue: AnnouncementTestQueue,
  ) {}

  async list(page: number, limit: number) {
    const [items, total] = await this.prisma.$transaction([
      this.prisma.emailAnnouncement.findMany({
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          name: true,
          subject: true,
          version: true,
          createdAt: true,
          updatedAt: true,
          createdBy: adminSelect,
          // The draft and its customer run have separate lifecycles: the list shows the run's state (tests never count).
          sendRun: { select: { id: true, status: true, audience: true } },
        },
      }),
      this.prisma.emailAnnouncement.count(),
    ]);
    const runIds = items.flatMap((i) => (i.sendRun ? [i.sendRun.id] : []));
    const issues = runIds.length
      ? await this.prisma.announcementRunRecipient.groupBy({ by: ['runId'], where: { runId: { in: runIds }, status: { in: [...ISSUE_STATES] } }, _count: { _all: true } })
      : [];
    const issuesOf = new Map(issues.map((g) => [g.runId, g._count._all]));
    return {
      items: items.map(({ sendRun, ...i }) => ({ ...i, broadcast: sendRun ? { ...sendRun, issues: issuesOf.get(sendRun.id) ?? 0 } : null })),
      pagination: paginate(page, limit, total),
    };
  }

  /** latestTest: the requesting admin's own most recent test of this draft, if any. */
  async get(id: string, actorId: string) {
    const found = await this.prisma.emailAnnouncement.findUnique({
      where: { id },
      select: {
        ...draftSelect,
        testSends: { where: { requestedByUserId: actorId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1, select: testSelect },
        // Step 4: the one customer broadcast of this announcement, if any (details: GET :id/broadcasts/:runId).
        sendRun: { select: { id: true, status: true, announcementVersion: true } },
      },
    });
    if (!found) throw new NotFoundException(DRAFT_NOT_FOUND);
    const { testSends, sendRun, ...draft } = found;
    return { ...draft, latestTest: testSends[0] ?? null, broadcast: sendRun };
  }

  /** Where a test would go: the requester's own email, only when verified (null otherwise). */
  async testDestination(actorId: string) {
    const me = await this.prisma.user.findUnique({ where: { id: actorId }, select: { email: true, emailVerifiedAt: true } });
    return { email: me?.emailVerifiedAt ? me.email : null };
  }

  /** One test request's status, for the admin who made it only (another admin's is a 404). */
  async getTest(announcementId: string, testId: string, actorId: string) {
    const found = await this.prisma.announcementTestSend.findFirst({
      where: { id: testId, announcementId, requestedByUserId: actorId },
      select: testSelect,
    });
    if (!found) throw new NotFoundException('Test email not found.');
    return found;
  }

  /**
   * Step 2: accept one test email of the saved draft to the requester's own
   * verified address. One transaction under a single advisory lock (low volume):
   * idempotent replay, saved-version check, per-admin and shared limits, the
   * immutable snapshot and the audit row commit together. The job is queued
   * after commit; if that fails the row stays QUEUED and the reconciler sends it.
   */
  async requestTest(id: string, dto: CreateTestSendDto, actor: AuditActor) {
    const since = new Date(Date.now() - TEST_WINDOW_MS);
    const { row, created } = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('announcement-test-send'))`;
      const previous = await tx.announcementTestSend.findUnique({
        where: { requestedByUserId_clientOperationId: { requestedByUserId: actor.userId, clientOperationId: dto.clientOperationId } },
        select: { ...testSelect, announcementId: true },
      });
      if (previous) {
        const { announcementId, ...row } = previous;
        if (announcementId !== id || row.announcementVersion !== dto.expectedVersion) throw new ConflictException(TEST_OPERATION_REUSED);
        return { row, created: false };
      }
      const me = await tx.user.findUnique({ where: { id: actor.userId }, select: { email: true, emailVerifiedAt: true, status: true } });
      if (!me || me.status !== UserStatus.ACTIVE) throw new NotFoundException(DRAFT_NOT_FOUND);
      if (!me.emailVerifiedAt) throw new ConflictException(TEST_NOT_VERIFIED);
      const draft = await tx.emailAnnouncement.findUnique({ where: { id } });
      if (!draft) throw new NotFoundException(DRAFT_NOT_FOUND);
      if (draft.version !== dto.expectedVersion) throw new ConflictException(TEST_VERSION_CHANGED);
      const [mine, all] = await Promise.all([
        tx.announcementTestSend.count({ where: { requestedByUserId: actor.userId, createdAt: { gte: since } } }),
        tx.announcementTestSend.count({ where: { createdAt: { gte: since } } }),
      ]);
      if (mine >= TEST_LIMIT_PER_ADMIN) {
        throw new HttpException(
          `You can send up to ${TEST_LIMIT_PER_ADMIN} test emails every 10 minutes. Please wait and try again.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (all >= TEST_LIMIT_GLOBAL) {
        throw new HttpException('Too many test emails were requested recently. Please wait a few minutes and try again.', HttpStatus.TOO_MANY_REQUESTS);
      }
      const row = await tx.announcementTestSend.create({
        data: {
          announcementId: id,
          announcementVersion: draft.version,
          requestedByUserId: actor.userId,
          clientOperationId: dto.clientOperationId,
          toEmail: me.email,
          subject: draft.subject,
          body: draft.body,
          ctaLabel: draft.ctaLabel,
          ctaDestination: draft.ctaDestination,
        },
        select: testSelect,
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.ANNOUNCEMENT_TEST_REQUESTED,
        actor,
        subjectType: 'AnnouncementTestSend',
        subjectId: row.id,
        metadata: { announcementId: id, version: draft.version, operationId: dto.clientOperationId },
      });
      return { row, created: true };
    });
    // A replay re-queues too (same job id, so never a second job) in case the first enqueue was lost.
    if (row.status === 'QUEUED') await this.testQueue.enqueue(row.id);
    if (created) this.logger.log(`announcement_test_requested test ${row.id} admin ${actor.userId}`);
    return row;
  }

  create(dto: CreateAnnouncementDto, actor: AuditActor) {
    const data = content(dto);
    return this.prisma.$transaction(async (tx) => {
      const draft = await tx.emailAnnouncement.create({
        data: { ...data, createdByUserId: actor.userId, updatedByUserId: actor.userId },
        select: draftSelect,
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.ANNOUNCEMENT_DRAFT_CREATED,
        actor,
        subjectType: SUBJECT_TYPE,
        subjectId: draft.id,
        metadata: { version: draft.version, hasButton: !!data.ctaDestination },
      });
      return draft;
    });
  }

  update(id: string, dto: UpdateAnnouncementDto, actor: AuditActor) {
    const data = content(dto);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.emailAnnouncement.findUnique({ where: { id }, select: { version: true, ...fieldSelect } });
      if (!before) throw new NotFoundException(DRAFT_NOT_FOUND);
      if (before.version !== dto.expectedVersion) throw new ConflictException(DRAFT_CHANGED);
      // The queued version is the customer record; editing it would make the draft disagree with what was sent.
      if (await tx.announcementSendRun.findUnique({ where: { announcementId: id }, select: { id: true } })) throw new ConflictException(SENT_LOCKED);
      const changed = FIELDS.filter((f) => before[f] !== data[f]);
      // The version check again, atomically: a save that committed in between makes this match nothing.
      const { count } = await tx.emailAnnouncement.updateMany({
        where: { id, version: dto.expectedVersion },
        data: { ...data, updatedByUserId: actor.userId, version: { increment: 1 } },
      });
      if (!count) throw new ConflictException(DRAFT_CHANGED);
      await writeAuditLog(tx, {
        eventType: AuditEventType.ANNOUNCEMENT_DRAFT_UPDATED,
        actor,
        subjectType: SUBJECT_TYPE,
        subjectId: id,
        metadata: { version: dto.expectedVersion + 1, changedFields: changed.join(',') || null },
      });
      return tx.emailAnnouncement.findUniqueOrThrow({ where: { id }, select: draftSelect });
    });
  }

  /** The email as it would be rendered now, from unsaved content. No writes, no provider, no recipients. */
  preview(dto: AnnouncementContentDto) {
    const { ctaLabel, ctaDestination } = cta(dto);
    const settings = emailSettings(this.config);
    const rendered = announcement(
      {
        subject: dto.subject,
        body: dto.body,
        cta: ctaLabel && ctaDestination ? { label: ctaLabel, path: ANNOUNCEMENT_DESTINATIONS[ctaDestination] } : null,
      },
      settings.appBaseUrl,
    );
    return { from: senderOf(this.config), ...rendered };
  }
}

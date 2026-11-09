import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeAuditLog, type AuditActor } from '../audit/audit-log.service.js';
import { emailSettings } from '../email/email-provider.js';
import { announcement } from '../email/email-templates.js';
import { type AnnouncementAudience, AuditEventType, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnnouncementAudienceService, AnnouncementPolicy, type PolicyBlocker, PURPOSE, reasonSql } from './announcement-audience.service.js';
import { ACTIVE_RUN, AnnouncementBroadcastQueue, type BroadcastMode } from './announcement-broadcast-queue.service.js';
import { ANNOUNCEMENT_DESTINATIONS, type AnnouncementDestination, type CreateBroadcastDto } from './announcements.dto.js';
import { DRAFT_NOT_FOUND, senderOf } from './announcements.service.js';

/** A review is valid for this long; after it the admin reviews again (fresh counts and blockers). */
export const REVIEW_TTL_MS = 10 * 60_000;
// The audience may shrink a little between review and confirmation (e.g. a suspension), never grow.
const SHRINK_TOLERANCE = 0.9;

export const REVIEW_VERSION_CHANGED = 'The saved draft has changed. Reload it and review the latest saved version.';
export const REVIEW_EXPIRED = 'This review has expired or does not match the draft. Review and send again.';
export const AUDIENCE_CHANGED = 'The eligible audience changed since your review. Review and send again to see the new count.';
export const ALREADY_SENT = 'This announcement has already been queued for customers. Create a new announcement to send again.';
export const RUN_IN_PROGRESS = 'Another announcement is being sent. Wait until it finishes or stop it first.';
export const OPERATION_REUSED = 'This confirmation id was already used for a different announcement or version. Review and send again.';
export const RUN_FINISHED = 'This broadcast has already finished; there is nothing left to stop.';

const BROADCAST_DISABLED: PolicyBlocker = { code: 'broadcast_disabled', message: 'Customer broadcasting is turned off on this server.' };
const ALREADY_SENT_BLOCKER: PolicyBlocker = { code: 'already_sent', message: ALREADY_SENT };
const RUN_IN_PROGRESS_BLOCKER: PolicyBlocker = { code: 'run_in_progress', message: RUN_IN_PROGRESS };
const NO_RECIPIENTS: PolicyBlocker = { code: 'no_eligible_recipients', message: 'No customers are eligible to receive this announcement.' };
const PILOT_ONLY: PolicyBlocker = {
  code: 'pilot_only',
  message: 'This server only allows pilot sends. Choose the pilot group in the Audience step.',
};

/** Whether the gate lets this audience be sent at all. */
const gateAllows = (mode: BroadcastMode, audience: AnnouncementAudience) => mode === 'all' || (mode === 'pilot' && audience === 'PILOT');

/** The exact pilot member set a review covered ('' for all eligible). */
const memberHash = (ids: string[]) => (ids.length ? createHash('sha256').update([...ids].sort().join(',')).digest('base64url') : '');

/** Replaced per recipient at send time; run-specific, so draft text can never contain it. */
export const unsubscribePlaceholder = (runId: string) => `__FA_UNSUBSCRIBE_${runId.replaceAll('-', '')}__`;

/**
 * What a review token binds: announcement, version, admin, eligible count,
 * policy version, audience (s) and the exact pilot member set (m), expiry.
 */
type ReviewClaims = { a: string; v: number; u: string; n: number; p: string; s: AnnouncementAudience; m: string; exp: number };

const reviewKey = (secret: string) => createHmac('sha256', secret).update('announcement-broadcast-review/v1').digest();

export function signReview(claims: ReviewClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${createHmac('sha256', reviewKey(secret)).update(body).digest('base64url')}`;
}

/** The claims of a genuine, unexpired token; null otherwise (forged, altered, expired, malformed). */
export function readReview(token: string, secret: string, now = Date.now()): ReviewClaims | null {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = createHmac('sha256', reviewKey(secret)).update(body).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ReviewClaims;
    return typeof claims.exp === 'number' && claims.exp > now ? claims : null;
  } catch {
    return null;
  }
}

type Content = { subject: string; body: string; ctaLabel: string | null; ctaDestination: string | null };
const render = (d: Content, appBaseUrl: string, unsubscribeUrl?: string) => {
  const path = d.ctaDestination ? ANNOUNCEMENT_DESTINATIONS[d.ctaDestination as AnnouncementDestination] : null;
  return announcement({ subject: d.subject, body: d.body, cta: path && d.ctaLabel ? { label: d.ctaLabel, path } : null }, appBaseUrl, false, unsubscribeUrl);
};

const adminRef = { select: { id: true, firstName: true, lastName: true, email: true } } as const;
const STATUSES = ['QUEUED', 'PROCESSING', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'SKIPPED', 'CANCELLED'] as const;

/**
 * Notification centre Step 4: review, confirm, follow and stop a customer
 * broadcast (API side; the worker sends). Nothing here takes a recipient,
 * count or address from the client: confirmation re-runs the eligibility count
 * and re-checks the gate, policy, version and a server-signed review. The HTTP
 * request only records the run; the worker prepares the audience and sends.
 */
@Injectable()
export class AnnouncementBroadcastService {
  private readonly logger = new Logger(AnnouncementBroadcastService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audience: AnnouncementAudienceService,
    private readonly policy: AnnouncementPolicy,
    private readonly queue: AnnouncementBroadcastQueue,
  ) {
    // Validated at startup (app.setup.ts); the review key is derived from it, never the secret itself.
    this.secret = config.get<string>('SESSION_SECRET') ?? '';
  }

  /** Everything the confirmation dialog shows, from the SAVED draft. A token only when sending is possible. */
  async review(id: string, expectedVersion: number, actor: AuditActor) {
    const counts = await this.audience.review(id, actor); // 404 / 503; audited as an audience review
    const draft = await this.prisma.emailAnnouncement.findUnique({
      where: { id },
      select: {
        version: true,
        subject: true,
        body: true,
        ctaLabel: true,
        ctaDestination: true,
        audience: true,
        sendRun: { select: { id: true } },
        pilotMembers: { select: { userId: true } },
      },
    });
    if (!draft) throw new NotFoundException(DRAFT_NOT_FOUND);
    if (draft.version !== expectedVersion || counts.version !== expectedVersion || counts.audience !== draft.audience) {
      throw new ConflictException(REVIEW_VERSION_CHANGED);
    }
    const blockers: PolicyBlocker[] = [...counts.blockers];
    const mode = this.queue.settings.mode();
    if (mode === 'off') blockers.push(BROADCAST_DISABLED);
    else if (!gateAllows(mode, draft.audience)) blockers.push(PILOT_ONLY);
    if (draft.sendRun) blockers.push(ALREADY_SENT_BLOCKER);
    else if (await this.prisma.announcementSendRun.findFirst({ where: { status: { in: ACTIVE_RUN } }, select: { id: true } }))
      blockers.push(RUN_IN_PROGRESS_BLOCKER);
    if (counts.eligible === 0) blockers.push(NO_RECIPIENTS);
    const exp = Date.now() + REVIEW_TTL_MS;
    const sendable = !blockers.length && counts.eligible !== null;
    const rendered = render(draft, emailSettings(this.config).appBaseUrl);
    return {
      announcementId: id,
      version: draft.version,
      checkedAt: counts.checkedAt,
      from: senderOf(this.config),
      subject: rendered.subject,
      html: rendered.html,
      // Owner decision 2026-11-03: announcements are optional product news (consent + unsubscribe).
      purpose: PURPOSE,
      audience: draft.audience,
      candidates: counts.candidates,
      eligible: counts.eligible,
      excluded: counts.excluded,
      exclusions: counts.exclusions,
      blockers,
      reviewToken: sendable
        ? signReview(
            {
              a: id,
              v: draft.version,
              u: actor.userId,
              n: counts.eligible!,
              p: this.policy.version,
              s: draft.audience,
              m: draft.audience === 'PILOT' ? memberHash(draft.pilotMembers.map((m) => m.userId)) : '',
              exp,
            },
            this.secret,
          )
        : null,
      expiresAt: sendable ? new Date(exp).toISOString() : null,
    };
  }

  /**
   * Records the run (PREPARING) with its content snapshot and audit row in one
   * transaction under an advisory lock, then queues the first slice (best
   * effort: the reconciler starts a run whose job was lost). A replay of the
   * same clientOperationId returns the same run.
   */
  async confirm(id: string, dto: CreateBroadcastDto, actor: AuditActor) {
    const appBaseUrl = emailSettings(this.config).appBaseUrl;
    const { runId, created } = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('announcement-broadcast'))`;
        const replay = await tx.announcementSendRun.findUnique({
          where: { requestedByUserId_clientOperationId: { requestedByUserId: actor.userId, clientOperationId: dto.clientOperationId } },
          select: { id: true, announcementId: true, announcementVersion: true },
        });
        if (replay) {
          if (replay.announcementId !== id || replay.announcementVersion !== dto.expectedVersion) throw new ConflictException(OPERATION_REUSED);
          return { runId: replay.id, created: false };
        }
        const claims = readReview(dto.reviewToken, this.secret);
        if (!claims || claims.a !== id || claims.u !== actor.userId || claims.v !== dto.expectedVersion) throw new ConflictException(REVIEW_EXPIRED);
        if (this.policy.blockers.length || claims.p !== this.policy.version) {
          throw new ConflictException('Sending to customers is blocked by the communication policy. Review again for details.');
        }
        const draft = await tx.emailAnnouncement.findUnique({ where: { id }, include: { pilotMembers: { select: { userId: true } } } });
        if (!draft) throw new NotFoundException(DRAFT_NOT_FOUND);
        if (draft.version !== dto.expectedVersion) throw new ConflictException(REVIEW_VERSION_CHANGED);
        const mode = this.queue.settings.mode();
        if (mode === 'off') throw new ConflictException(BROADCAST_DISABLED.message);
        if (!gateAllows(mode, draft.audience)) throw new ConflictException(PILOT_ONLY.message);
        const pilot = draft.audience === 'PILOT';
        // The audience scope or pilot member set changed since the review: review again.
        if (claims.s !== draft.audience || claims.m !== (pilot ? memberHash(draft.pilotMembers.map((m) => m.userId)) : '')) {
          throw new ConflictException(AUDIENCE_CHANGED);
        }
        if (await tx.announcementSendRun.findUnique({ where: { announcementId: id }, select: { id: true } })) throw new ConflictException(ALREADY_SENT);
        if (await tx.announcementSendRun.findFirst({ where: { status: { in: ACTIVE_RUN } }, select: { id: true } })) {
          throw new ConflictException(RUN_IN_PROGRESS);
        }
        // Fresh count, never the client's: a larger (or much smaller) audience than reviewed needs a new review.
        // A pilot must match exactly; all-eligible may shrink a little, never grow.
        const { passing } = await this.audience.counts(pilot ? id : undefined);
        if (!passing || passing > claims.n || passing < (pilot ? claims.n : Math.floor(claims.n * SHRINK_TOLERANCE))) {
          throw new ConflictException(AUDIENCE_CHANGED);
        }
        const newRunId = randomUUID();
        const rendered = render(draft, appBaseUrl, unsubscribePlaceholder(newRunId));
        const run = await tx.announcementSendRun.create({
          data: {
            id: newRunId,
            audience: draft.audience,
            announcementId: id,
            announcementVersion: draft.version,
            requestedByUserId: actor.userId,
            clientOperationId: dto.clientOperationId,
            subject: rendered.subject,
            body: draft.body,
            ctaLabel: draft.ctaLabel,
            ctaDestination: draft.ctaDestination,
            html: rendered.html,
            text: rendered.text,
            policyVersion: this.policy.version,
            reviewedCount: passing,
            audienceBoundaryAt: new Date(),
          },
          select: { id: true },
        });
        await writeAuditLog(tx, {
          eventType: AuditEventType.ANNOUNCEMENT_BROADCAST_REQUESTED,
          actor,
          subjectType: 'AnnouncementSendRun',
          subjectId: run.id,
          metadata: {
            announcementId: id,
            version: draft.version,
            reviewed: passing,
            operationId: dto.clientOperationId,
            audience: draft.audience,
            state: 'preparing',
          },
        });
        if (pilot) await this.preparePilot(tx, run.id, id, draft.version, passing);
        return { runId: run.id, created: true };
      },
      { timeout: 15_000 },
    );
    // A replay re-queues too (a duplicate job only finds the lease taken).
    await this.queue.enqueue(runId);
    if (created) this.logger.log(`announcement_broadcast_requested run ${runId} admin ${actor.userId}`);
    return this.progress(id, runId);
  }

  /**
   * A pilot run is prepared at confirmation, in the same transaction: exactly
   * the pilot members that pass every rule now, so later edits to the pilot
   * group can never reach this run. The worker then only sends (rechecking each).
   */
  private async preparePilot(tx: Prisma.TransactionClient, runId: string, announcementId: string, version: number, reviewed: number) {
    // Session time zone is not UTC: timestamps go in as UTC text, never a JS Date.
    const nowIso = new Date().toISOString();
    const prepared = await tx.$executeRaw`
      INSERT INTO "AnnouncementRunRecipient" (id, "runId", "userId", "emailHash", "createdAt", "updatedAt")
      SELECT gen_random_uuid(), ${runId}::uuid, u.id, encode(sha256(convert_to(lower(u.email), 'UTF8')), 'hex'),
             ${nowIso}::timestamp, ${nowIso}::timestamp
      FROM "User" u
      WHERE u.role = 'CUSTOMER'
        AND u.id IN (SELECT m."userId" FROM "AnnouncementPilotMember" m WHERE m."announcementId" = ${announcementId}::uuid)
        AND ${reasonSql()} = 'pass'
      ON CONFLICT DO NOTHING`;
    await tx.announcementSendRun.update({ where: { id: runId }, data: { status: 'SENDING', preparedAt: new Date() }, select: { id: true } });
    await writeAuditLog(tx, {
      eventType: AuditEventType.ANNOUNCEMENT_BROADCAST_QUEUED,
      actor: { type: 'SYSTEM', userId: null },
      subjectType: 'AnnouncementSendRun',
      subjectId: runId,
      metadata: { announcementId, version, prepared, reviewed, audience: 'PILOT' },
    });
  }

  /** Aggregate state of one run from the database. Counts and safe reason codes only: no addresses or content. */
  async progress(announcementId: string, runId: string) {
    const run = await this.prisma.announcementSendRun.findFirst({
      where: { id: runId, announcementId },
      select: {
        id: true,
        announcementId: true,
        announcementVersion: true,
        subject: true,
        status: true,
        finishReason: true,
        reviewedCount: true,
        audience: true,
        createdAt: true,
        preparedAt: true,
        completedAt: true,
        cancelRequestedAt: true,
        updatedAt: true,
        leaseOwner: true,
        leaseUntil: true,
        requestedBy: adminRef,
        cancelledBy: adminRef,
      },
    });
    if (!run) throw new NotFoundException('Broadcast not found.');
    const [groups, latest] = await Promise.all([
      this.prisma.announcementRunRecipient.groupBy({ by: ['status', 'reasonCode'], where: { runId }, _count: { _all: true } }),
      this.prisma.announcementRunRecipient.aggregate({ where: { runId }, _max: { updatedAt: true } }),
    ]);
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
    // QUEUED with a code = waiting to retry after a provably-not-accepted failure (e.g. throttling).
    const reasons: Record<'QUEUED' | 'SKIPPED' | 'FAILED' | 'UNKNOWN', Record<string, number>> = { QUEUED: {}, SKIPPED: {}, FAILED: {}, UNKNOWN: {} };
    for (const g of groups) {
      counts[g.status] += g._count._all;
      if (g.status in reasons && g.reasonCode) {
        const bucket = reasons[g.status as keyof typeof reasons];
        bucket[g.reasonCode] = (bucket[g.reasonCode] ?? 0) + g._count._all;
      }
    }
    const lastUpdatedAt = [run.updatedAt, latest._max.updatedAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
    const { updatedAt: _updatedAt, leaseOwner, leaseUntil, ...rest } = run;
    const active = ACTIVE_RUN.includes(run.status);
    return {
      ...rest,
      // No driver and a lease in the future = paused on purpose (Retry-After, daily limit) until then.
      pausedUntil: active && !leaseOwner && leaseUntil && leaseUntil > new Date() ? leaseUntil : null,
      // Stop requested, worker still settling the rest.
      stopping: !!run.cancelRequestedAt && ACTIVE_RUN.includes(run.status),
      // The denominator only exists once the audience is fully prepared.
      prepared: Object.values(counts).reduce((a, b) => a + b, 0),
      audiencePrepared: !!run.preparedAt,
      counts,
      reasons,
      lastUpdatedAt,
    };
  }

  /**
   * Asks the worker to stop: never-attempted recipients become CANCELLED and no
   * new provider attempt starts. An email already handed to the provider (at
   * most one, in flight) keeps its real outcome; accepted emails cannot be recalled.
   */
  async cancel(announcementId: string, runId: string, actor: AuditActor) {
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.announcementSendRun.findFirst({ where: { id: runId, announcementId }, select: { status: true, announcementVersion: true } });
      if (!run) throw new NotFoundException('Broadcast not found.');
      if (!ACTIVE_RUN.includes(run.status)) throw new ConflictException(RUN_FINISHED);
      const { count } = await tx.announcementSendRun.updateMany({
        where: { id: runId, status: { in: ACTIVE_RUN }, cancelRequestedAt: null },
        data: { cancelRequestedAt: new Date(), cancelledByUserId: actor.userId },
      });
      // A repeated stop is a no-op (no second audit row).
      if (count) {
        await writeAuditLog(tx, {
          eventType: AuditEventType.ANNOUNCEMENT_BROADCAST_CANCEL_REQUESTED,
          actor,
          subjectType: 'AnnouncementSendRun',
          subjectId: runId,
          metadata: { announcementId, version: run.announcementVersion, state: run.status.toLowerCase() },
        });
      }
    });
    // Wake the run now so pending work is cancelled promptly (a paused run would otherwise wait).
    await this.prisma.announcementSendRun.updateMany({ where: { id: runId, leaseOwner: null }, data: { leaseUntil: null } });
    await this.queue.enqueue(runId);
    this.logger.log(`announcement_broadcast_cancel_requested run ${runId} admin ${actor.userId}`);
    return this.progress(announcementId, runId);
  }
}

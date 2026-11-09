import { ConflictException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { writeAuditLog, type AuditActor } from '../audit/audit-log.service.js';
import { emailKey } from '../auth/dto/register.dto.js';
import { OPEN_STATUSES } from '../death-verification/death-verification-workflow.service.js';
import { type AnnouncementAudience, AuditEventType, Prisma } from '../generated/prisma/client.js';
import { errorCode, PrismaService } from '../prisma/prisma.service.js';
import { DRAFT_NOT_FOUND } from './announcements.service.js';

export type PolicyBlocker = { readonly code: string; readonly message: string };

/**
 * Open communication-policy decisions; any entry blocks every review token and
 * every send. Empty since 2026-11-03: the owner decided (Step 7) that
 * announcements are OPTIONAL product news, needing marketing consent and an
 * unsubscribe link, never sent to suppressed addresses (unsubscribed, hard
 * bounce, complaint) or to Customers with an open, unverified death report — and
 * each rule is enforced below (reasonSql), in run preparation and in the
 * send-time recheck (skipReason). Add an entry back if a rule is ever removed.
 */
export const POLICY_BLOCKERS: readonly PolicyBlocker[] = [];

/** Every run stores this; a run confirmed under another version stops (BLOCKED) instead of sending. */
export const POLICY_VERSION = 'optional-consent-v1-2026-11-03';
export const PURPOSE = 'OPTIONAL_PRODUCT_NEWS' as const;
export const PILOT_MAX = 10;

/** The communication policy every review, confirmation and send checks (a provider so e2e can swap it). */
@Injectable()
export class AnnouncementPolicy {
  readonly blockers: readonly PolicyBlocker[] = POLICY_BLOCKERS;
  readonly version: string = POLICY_VERSION;
}

/**
 * ONE primary reason per Customer, checked in this order, so buckets add up:
 *   account_unavailable  deleted, or status not ACTIVE (suspended, passed, deleted)
 *   email_invalid        current email missing or not an address
 *   email_not_verified   no emailVerifiedAt (an email change sets it only when confirmed)
 *   open_death_report    an open, unverified death report (until it is resolved)
 *   suppressed           the address unsubscribed, hard-bounced or complained
 *   no_consent           no opt-in to optional product news (registration never grants it)
 *   pass
 * Billing (trial, paid, expired) is deliberately not a rule. Used by review
 * counts, pilot status and run preparation; skipReason mirrors it at send time.
 */
export const reasonSql = (u: Prisma.Sql = Prisma.raw('u')) => Prisma.sql`CASE
  WHEN ${u}."deletedAt" IS NOT NULL OR ${u}.status <> 'ACTIVE' THEN 'account_unavailable'
  WHEN ${u}.email IS NULL OR ${u}.email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' THEN 'email_invalid'
  WHEN ${u}."emailVerifiedAt" IS NULL THEN 'email_not_verified'
  WHEN EXISTS (SELECT 1 FROM "DeathVerificationCase" c WHERE c."ownerUserId" = ${u}.id AND c.status::text = ANY(${OPEN_STATUSES})) THEN 'open_death_report'
  WHEN EXISTS (SELECT 1 FROM "EmailSuppression" s WHERE s."emailHash" = encode(sha256(convert_to(lower(${u}.email), 'UTF8')), 'hex')) THEN 'suppressed'
  WHEN ${u}."marketingConsentAt" IS NULL THEN 'no_consent'
  ELSE 'pass'
END`;

/** Customers in one announcement's pilot group (an SQL condition on `u`). */
const inPilot = (announcementId: string) =>
  Prisma.sql`u.id IN (SELECT m."userId" FROM "AnnouncementPilotMember" m WHERE m."announcementId" = ${announcementId}::uuid)`;

export type AudienceCounts = {
  candidates: number;
  passing: number;
  account_unavailable: number;
  email_invalid: number;
  email_not_verified: number;
  open_death_report: number;
  suppressed: number;
  no_consent: number;
};

export const RUN_EXISTS = 'This announcement has already been queued; its audience can no longer change.';
const NO_CUSTOMER = 'No customer account uses this email address.';

/**
 * Notification centre: who an announcement could reach, as counts (review) or,
 * for the explicitly chosen pilot group, per member. One SQL statement per
 * check; no message content leaves the database. Any send re-runs these rules.
 */
@Injectable()
export class AnnouncementAudienceService {
  private readonly logger = new Logger(AnnouncementAudienceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: AnnouncementPolicy,
  ) {}

  /** Counts for every Customer, or only this announcement's pilot group. Throws 503 on failure (never zero). */
  async counts(pilotOf?: string): Promise<AudienceCounts> {
    try {
      const [row] = await this.prisma.$queryRaw<AudienceCounts[]>`
        SELECT
          count(*)::int AS candidates,
          count(*) FILTER (WHERE reason = 'pass')::int AS passing,
          count(*) FILTER (WHERE reason = 'account_unavailable')::int AS account_unavailable,
          count(*) FILTER (WHERE reason = 'email_invalid')::int AS email_invalid,
          count(*) FILTER (WHERE reason = 'email_not_verified')::int AS email_not_verified,
          count(*) FILTER (WHERE reason = 'open_death_report')::int AS open_death_report,
          count(*) FILTER (WHERE reason = 'suppressed')::int AS suppressed,
          count(*) FILTER (WHERE reason = 'no_consent')::int AS no_consent
        FROM (
          SELECT ${reasonSql()} AS reason
          FROM "User" u
          WHERE u.role = 'CUSTOMER' ${pilotOf ? Prisma.sql`AND ${inPilot(pilotOf)}` : Prisma.empty}
        ) t`;
      return row;
    } catch (err) {
      // Never a fake zero: the admin sees "unavailable".
      this.logger.error(`announcement_audience_review_failed (code: ${errorCode(err)})`);
      throw new ServiceUnavailableException('The audience review is unavailable right now. Please try again.');
    }
  }

  async review(announcementId: string, actor: AuditActor) {
    const draft = await this.prisma.emailAnnouncement.findUnique({ where: { id: announcementId }, select: { id: true, version: true, audience: true } });
    if (!draft) throw new NotFoundException(DRAFT_NOT_FOUND);
    const row = await this.counts(draft.audience === 'PILOT' ? draft.id : undefined);
    const blockers = this.policy.blockers;
    const excluded = row.candidates - row.passing;
    await writeAuditLog(this.prisma, {
      eventType: AuditEventType.ANNOUNCEMENT_AUDIENCE_REVIEWED,
      actor,
      subjectType: 'EmailAnnouncement',
      subjectId: draft.id,
      metadata: { version: draft.version, outcome: 'completed', audience: draft.audience },
    });
    return {
      announcementId: draft.id,
      version: draft.version,
      audience: draft.audience,
      purpose: PURPOSE,
      checkedAt: new Date().toISOString(),
      state: blockers.length ? ('ELIGIBILITY_NOT_CONFIRMED' as const) : ('CONFIRMED' as const),
      candidates: row.candidates,
      // Only a number while no policy decision is open; never a guess.
      eligible: blockers.length ? null : row.passing,
      excluded,
      exclusions: {
        accountUnavailable: row.account_unavailable,
        emailInvalid: row.email_invalid,
        emailNotVerified: row.email_not_verified,
        openDeathReport: row.open_death_report,
        suppressed: row.suppressed,
        noConsent: row.no_consent,
      },
      blockers,
    };
  }

  // ─── Audience scope and pilot group (SUPER_ADMIN, before a run exists) ─────

  /** The scope and each pilot member with the reason it would (not) receive the email. */
  async pilot(announcementId: string) {
    const draft = await this.prisma.emailAnnouncement.findUnique({ where: { id: announcementId }, select: { audience: true } });
    if (!draft) throw new NotFoundException(DRAFT_NOT_FOUND);
    const members = await this.prisma.$queryRaw<{ userId: string; email: string; firstName: string | null; lastName: string | null; status: string }[]>`
      SELECT u.id AS "userId", u.email, u."firstName", u."lastName", ${reasonSql()} AS status
      FROM "User" u
      WHERE u.role = 'CUSTOMER' AND ${inPilot(announcementId)}
      ORDER BY u.email`;
    return { audience: draft.audience, max: PILOT_MAX, members };
  }

  async setAudience(announcementId: string, audience: AnnouncementAudience, actor: AuditActor) {
    await this.change(announcementId, actor, { action: 'audience', audience }, async (tx) => {
      await tx.emailAnnouncement.update({ where: { id: announcementId }, data: { audience }, select: { id: true } });
    });
    return this.pilot(announcementId);
  }

  /** Customers only, found by exact address; at most PILOT_MAX. Eligibility is shown, not required to add. */
  async addPilot(announcementId: string, email: string, actor: AuditActor) {
    await this.change(announcementId, actor, null, async (tx) => {
      const user = await tx.user.findFirst({ where: { email: emailKey(email), role: 'CUSTOMER' }, select: { id: true } });
      if (!user) throw new NotFoundException(NO_CUSTOMER);
      if (await tx.announcementPilotMember.findUnique({ where: { announcementId_userId: { announcementId, userId: user.id } } })) return null;
      if ((await tx.announcementPilotMember.count({ where: { announcementId } })) >= PILOT_MAX) {
        throw new ConflictException(`A pilot group can have at most ${PILOT_MAX} customers.`);
      }
      await tx.announcementPilotMember.create({ data: { announcementId, userId: user.id, addedByUserId: actor.userId } });
      return { action: 'pilot_added', accountId: user.id };
    });
    return this.pilot(announcementId);
  }

  async removePilot(announcementId: string, userId: string, actor: AuditActor) {
    await this.change(announcementId, actor, null, async (tx) => {
      const { count } = await tx.announcementPilotMember.deleteMany({ where: { announcementId, userId } });
      return count ? { action: 'pilot_removed', accountId: userId } : null;
    });
    return this.pilot(announcementId);
  }

  /** One locked transaction: refuses once a run exists; audits only real changes (ids, never addresses). */
  private async change(
    announcementId: string,
    actor: AuditActor,
    fixed: Record<string, string> | null,
    apply: (tx: Prisma.TransactionClient) => Promise<Record<string, string> | null | void>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const [draft] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "EmailAnnouncement" WHERE id = ${announcementId}::uuid FOR UPDATE`;
      if (!draft) throw new NotFoundException(DRAFT_NOT_FOUND);
      if (await tx.announcementSendRun.findUnique({ where: { announcementId }, select: { id: true } })) throw new ConflictException(RUN_EXISTS);
      const metadata = (await apply(tx)) ?? fixed;
      if (!metadata) return;
      await writeAuditLog(tx, {
        eventType: AuditEventType.ANNOUNCEMENT_AUDIENCE_UPDATED,
        actor,
        subjectType: 'EmailAnnouncement',
        subjectId: announcementId,
        metadata,
      });
    });
  }
}

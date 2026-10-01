import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditEventType,
  DeathVerificationCaseStatus as Status,
  Prisma,
  type DeathVerificationCaseStatus,
  type TrustedContact,
  UserStatus,
} from '../generated/prisma/client.js';
import {
  type AuditActor,
  paginate,
  writeAuditLog,
} from '../audit/audit-log.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeathVerificationQueue } from './death-verification-queue.service.js';
import { audit, OPEN_STATUSES } from './death-verification-workflow.service.js';
import type { CreateDeathReportDto } from './dto/create-death-report.dto.js';
import type {
  RejectDeathCaseDto,
  VerifyDeathCaseDto,
} from './dto/death-verification-decision.dto.js';

export const REPORT_RECEIVED =
  'The report has been received and is pending verification.';
export const ALREADY_REPORTED =
  'A report has already been submitted for this account.';
export const NOT_ACCEPTING_REPORTS =
  'This account is not accepting new reports.';
export const CASE_NOT_FOUND = 'Death verification case not found.';
export const NO_OPEN_CASE = 'There is no death report for this account.';
export const CASE_CLOSED = 'This death verification case is already closed.';

/** The already-authorized relationship row a report is filed through. */
export type Reporter = Pick<
  TrustedContact,
  'id' | 'ownerUserId' | 'firstName' | 'lastName' | 'email' | 'mobile'
>;

export type DeathReportReceipt = {
  caseId: string;
  reportId: string;
  status: DeathVerificationCaseStatus;
  reportedAt: Date;
  message: string;
};

export type DeathVerificationStatus = {
  status: DeathVerificationCaseStatus | null;
  reportedByYou: boolean;
  openedAt: Date | null;
};

export type CustomerDeathVerificationStatus = {
  status: DeathVerificationCaseStatus | null;
  safeguardEndsAt: Date | null;
  canConfirmAlive: boolean;
};

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

// Explains a lost conditional update: unknown → 404, wrong state → 409.
const WRONG_STATE: Partial<Record<Status, string>> = {
  PENDING_VERIFICATION:
    'The safety notice has not been sent yet; the case cannot be decided.',
  SAFEGUARD_ACTIVE:
    'The safeguard period has not ended; the case cannot be decided yet.',
  VERIFIED: 'This case is already verified.',
  REJECTED: 'This case was rejected.',
  CANCELLED: 'This case was cancelled by the account holder.',
};

const displayName = (u: {
  firstName: string | null;
  lastName: string | null;
}) => [u.firstName, u.lastName].filter(Boolean).join(' ') || null;

/**
 * Death verification cases: Trusted Contact reports (Step 14), the Customer's
 * "I am alive" response, and the explicit admin decision (Step 15). Every
 * state change is a conditional update in a transaction, so exactly one of
 * confirm-alive / verify / reject can win; the loser gets 409. Only VERIFIED
 * activates death-triggered Messages; a report never does.
 */
@Injectable()
export class DeathVerificationService {
  private readonly logger = new Logger(DeathVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: DeathVerificationQueue,
  ) {}

  // ─── Trusted Contact (Step 14) ──────────────────────────────────────────

  async submitReport(
    reporter: Reporter,
    dto: CreateDeathReportDto,
  ): Promise<DeathReportReceipt> {
    let receipt: DeathReportReceipt;
    try {
      receipt = await this.prisma.$transaction(async (tx) => {
        // Race-safe find-or-create: INSERT ... ON CONFLICT DO NOTHING.
        await tx.deathVerificationCase.createMany({
          data: [{ ownerUserId: reporter.ownerUserId }],
          skipDuplicates: true,
        });
        const found = await tx.deathVerificationCase.findUniqueOrThrow({
          where: { ownerUserId: reporter.ownerUserId },
          select: { id: true, status: true },
        });
        // Further reports are supporting information while the case is open.
        // ponytail: one case per Customer, so a closed case (VERIFIED,
        // REJECTED, CANCELLED) accepts no reports until reopening is designed.
        if (!OPEN_STATUSES.includes(found.status)) {
          throw new ConflictException(NOT_ACCEPTING_REPORTS);
        }
        // The (case, trusted contact) unique index rejects a second report.
        const report = await tx.deathReport.create({
          data: {
            deathVerificationCaseId: found.id,
            reportedByTrustedContactId: reporter.id,
            reporterFirstNameSnapshot: reporter.firstName,
            reporterLastNameSnapshot: reporter.lastName,
            reporterEmailNormalized: reporter.email,
            reporterMobileNormalized: reporter.mobile?.trim() || null,
            reportedDateOfDeath: dto.reportedDateOfDeath
              ? new Date(dto.reportedDateOfDeath)
              : null,
            note: dto.note ?? null,
          },
          select: { id: true, createdAt: true },
        });
        await audit(tx, found.id, 'REPORT_RECEIVED', {
          type: 'TRUSTED_CONTACT',
          trustedContactId: reporter.id,
        });
        return {
          caseId: found.id,
          reportId: report.id,
          status: found.status,
          reportedAt: report.createdAt,
          message: REPORT_RECEIVED,
        };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        this.logger.warn(
          `death_report_duplicate trusted_contact ${reporter.id}`,
        );
        throw new ConflictException(ALREADY_REPORTED);
      }
      throw err;
    }
    // Ids only: never the note, names or contact details.
    this.logger.log(
      `death_report_submitted case ${receipt.caseId} report ${receipt.reportId} trusted_contact ${reporter.id}`,
    );
    // Safety notice + safeguard start. Never throws; the reconciler retries.
    if (receipt.status === Status.PENDING_VERIFICATION) {
      await this.queue.afterReport(receipt.caseId);
    }
    return receipt;
  }

  /** High-level status only: no other reporters, reports, counts or notes. */
  async getStatus(reporter: Reporter): Promise<DeathVerificationStatus> {
    const found = await this.prisma.deathVerificationCase.findUnique({
      where: { ownerUserId: reporter.ownerUserId },
      select: {
        status: true,
        openedAt: true,
        reports: {
          where: { reportedByTrustedContactId: reporter.id },
          select: { id: true },
          take: 1,
        },
      },
    });
    this.logger.log(
      `death_verification_status_viewed trusted_contact ${reporter.id}`,
    );
    return {
      status: found?.status ?? null,
      reportedByYou: (found?.reports.length ?? 0) > 0,
      openedAt: found?.openedAt ?? null,
    };
  }

  // ─── Customer (Step 15) ─────────────────────────────────────────────────

  /** The account holder's own case: status and deadline only. */
  async getCustomerStatus(
    ownerUserId: string,
  ): Promise<CustomerDeathVerificationStatus> {
    const found = await this.prisma.deathVerificationCase.findUnique({
      where: { ownerUserId },
      select: { status: true, safeguardEndsAt: true },
    });
    return {
      status: found?.status ?? null,
      safeguardEndsAt: found?.safeguardEndsAt ?? null,
      canConfirmAlive: !!found && OPEN_STATUSES.includes(found.status),
    };
  }

  /**
   * Open case → CANCELLED, atomically. Reports and history are kept. Loses
   * cleanly to a concurrent admin decision (409). Never reverses VERIFIED.
   */
  async confirmAlive(
    ownerUserId: string,
  ): Promise<CustomerDeathVerificationStatus> {
    const now = new Date();
    const caseId = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.deathVerificationCase.updateMany({
        where: { ownerUserId, status: { in: OPEN_STATUSES } },
        data: { status: Status.CANCELLED, cancelledAt: now, resolvedAt: now },
      });
      if (!count) return null;
      const { id } = await tx.deathVerificationCase.findUniqueOrThrow({
        where: { ownerUserId },
        select: { id: true },
      });
      await audit(tx, id, 'CUSTOMER_CONFIRMED_ALIVE', {
        type: 'CUSTOMER',
        userId: ownerUserId,
      });
      return id;
    });
    if (!caseId) {
      const found = await this.prisma.deathVerificationCase.findUnique({
        where: { ownerUserId },
        select: { status: true },
      });
      if (!found) throw new NotFoundException(NO_OPEN_CASE);
      throw new ConflictException(CASE_CLOSED);
    }
    this.logger.log(`death_customer_confirmed_alive case ${caseId}`);
    return this.getCustomerStatus(ownerUserId);
  }

  // ─── Admin (Step 15; paging + generic audit in Step 16) ───────────────────

  async listForAdmin(
    status: DeathVerificationCaseStatus | undefined,
    page: number,
    limit: number,
  ) {
    const where = status ? { status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.deathVerificationCase.findMany({
        where,
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          openedAt: true,
          safeguardEndsAt: true,
          _count: { select: { reports: true } },
          owner: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      }),
      this.prisma.deathVerificationCase.count({ where }),
    ]);
    const items = rows.map(({ id, _count, owner, ...rest }) => ({
      caseId: id,
      ...rest,
      reportCount: _count.reports,
      accountHolder: {
        userId: owner.id,
        email: owner.email,
        displayName: displayName(owner),
      },
    }));
    return { items, pagination: paginate(page, limit, total) };
  }

  /** GET detail: the same view, and the read itself is audited. */
  async viewForAdmin(caseId: string, actor: AuditActor) {
    const found = await this.getForAdmin(caseId);
    await writeAuditLog(this.prisma, {
      eventType: AuditEventType.ADMIN_VIEWED_DEATH_CASE,
      actor,
      subjectType: 'DeathVerificationCase',
      subjectId: caseId,
    });
    this.logger.log(`death_case_viewed case ${caseId} admin ${actor.userId}`);
    return found;
  }

  /**
   * Everything an admin needs to review: case timeline, account holder
   * identity, every report (snapshots + note), audit trail and activation
   * status. Never Message/Memory Vault/My Story/My Wishes content.
   */
  async getForAdmin(caseId: string) {
    const found = await this.prisma.deathVerificationCase.findUnique({
      where: { id: caseId },
      select: {
        id: true,
        status: true,
        openedAt: true,
        resolvedAt: true,
        safetyNoticeSentAt: true,
        safetyNoticeLastAttemptAt: true,
        safetyNoticeAttemptCount: true,
        safeguardStartedAt: true,
        safeguardEndsAt: true,
        verifiedAt: true,
        verifiedDeathAt: true,
        verifiedByUserId: true,
        rejectedAt: true,
        rejectedByUserId: true,
        cancelledAt: true,
        adminDecisionNote: true,
        deathTriggersActivatedAt: true,
        owner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
          },
        },
        reports: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            reportedByTrustedContactId: true,
            reporterFirstNameSnapshot: true,
            reporterLastNameSnapshot: true,
            reporterEmailNormalized: true,
            reporterMobileNormalized: true,
            reportedDateOfDeath: true,
            note: true,
            createdAt: true,
          },
        },
        auditEvents: {
          orderBy: { createdAt: 'asc' },
          select: {
            eventType: true,
            actorType: true,
            actorUserId: true,
            actorTrustedContactId: true,
            createdAt: true,
          },
        },
        activations: {
          orderBy: { dueAt: 'asc' },
          select: {
            messageId: true,
            triggerType: true,
            dueAt: true,
            message: { select: { status: true } },
          },
        },
      },
    });
    if (!found) throw new NotFoundException(CASE_NOT_FOUND);
    const { id, owner, reports, activations, ...rest } = found;
    return {
      caseId: id,
      ...rest,
      accountHolder: {
        userId: owner.id,
        email: owner.email,
        displayName: displayName(owner),
        accountStatus: owner.status,
      },
      reportCount: reports.length,
      reports: reports.map(({ reportedDateOfDeath, ...r }) => ({
        ...r,
        reportedDateOfDeath:
          reportedDateOfDeath?.toISOString().slice(0, 10) ?? null,
      })),
      activations: activations.map(({ message, ...a }) => ({
        ...a,
        messageStatus: message.status,
      })),
    };
  }

  /**
   * READY_FOR_REVIEW → VERIFIED, only after the safety notice was sent and the
   * safeguard ended; no override. In the same transaction the account holder
   * becomes PASSED (existing lifecycle field), which blocks their login and
   * every existing Customer session. Death triggers are activated after commit.
   */
  async verify(caseId: string, actor: AuditActor, dto: VerifyDeathCaseDto) {
    const adminUserId = actor.userId;
    const now = new Date();
    const verifiedDeathAt = new Date(dto.verifiedDeathAt);
    const won = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.deathVerificationCase.updateMany({
        where: {
          id: caseId,
          status: Status.READY_FOR_REVIEW,
          safetyNoticeSentAt: { not: null },
          safeguardEndsAt: { lte: now },
        },
        data: {
          status: Status.VERIFIED,
          verifiedAt: now,
          verifiedDeathAt,
          verifiedByUserId: adminUserId,
          adminDecisionNote: dto.decisionNote ?? null,
          resolvedAt: now,
        },
      });
      if (!count) return false;
      const { ownerUserId } = await tx.deathVerificationCase.findUniqueOrThrow({
        where: { id: caseId },
        select: { ownerUserId: true },
      });
      await tx.user.update({
        where: { id: ownerUserId },
        data: { status: UserStatus.PASSED, passedAt: verifiedDeathAt },
      });
      await audit(tx, caseId, 'ADMIN_VERIFIED', {
        type: 'ADMIN',
        userId: adminUserId,
      });
      await writeAuditLog(tx, {
        eventType: AuditEventType.DEATH_VERIFICATION_VERIFIED,
        actor,
        subjectType: 'DeathVerificationCase',
        subjectId: caseId,
        metadata: { accountHolderUserId: ownerUserId, newStatus: 'VERIFIED' },
      });
      return true;
    });
    if (!won) throw await this.decisionRefused(caseId);
    this.logger.log(`death_admin_verified case ${caseId} admin ${adminUserId}`);
    // Best effort; the reconciler completes activation if this fails.
    await this.queue.afterVerify(caseId);
    return this.getForAdmin(caseId);
  }

  /** READY_FOR_REVIEW → REJECTED. Nothing is released or activated. */
  async reject(caseId: string, actor: AuditActor, dto: RejectDeathCaseDto) {
    const adminUserId = actor.userId;
    const now = new Date();
    const won = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.deathVerificationCase.updateMany({
        where: { id: caseId, status: Status.READY_FOR_REVIEW },
        data: {
          status: Status.REJECTED,
          rejectedAt: now,
          rejectedByUserId: adminUserId,
          adminDecisionNote: dto.decisionNote ?? null,
          resolvedAt: now,
        },
      });
      if (count) {
        await audit(tx, caseId, 'ADMIN_REJECTED', {
          type: 'ADMIN',
          userId: adminUserId,
        });
        await writeAuditLog(tx, {
          eventType: AuditEventType.DEATH_VERIFICATION_REJECTED,
          actor,
          subjectType: 'DeathVerificationCase',
          subjectId: caseId,
          metadata: { newStatus: 'REJECTED' },
        });
      }
      return count > 0;
    });
    if (!won) throw await this.decisionRefused(caseId);
    this.logger.log(`death_admin_rejected case ${caseId} admin ${adminUserId}`);
    return this.getForAdmin(caseId);
  }

  private async decisionRefused(caseId: string) {
    const found = await this.prisma.deathVerificationCase.findUnique({
      where: { id: caseId },
      select: { status: true },
    });
    if (!found) return new NotFoundException(CASE_NOT_FOUND);
    return new ConflictException(
      WRONG_STATE[found.status] ??
        // READY_FOR_REVIEW but the stored safeguard has not ended (defensive).
        'The safeguard period has not ended; the case cannot be decided yet.',
    );
  }
}

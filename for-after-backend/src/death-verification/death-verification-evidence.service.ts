import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  type DeathVerificationCaseStatus,
  MediaAssetStatus,
  type Prisma,
} from '../generated/prisma/client.js';
import { MediaCleanup } from '../media/media-cleanup.service.js';
import {
  type AccessUrlResponse,
  checkUpload,
  expiresAt,
  mediaKey,
  mediaSettings,
  NOT_READY,
  NOT_UPLOADED,
  positiveInt,
  rejected,
  storedRefSelect,
  UPLOAD_FAILED,
  type UploadUrlResponse,
} from '../media/media.service.js';
import { MalwareScanner } from '../media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../media/storage/media-storage.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LATEST, type Reporter } from './death-verification.service.js';
import { audit, OPEN_STATUSES } from './death-verification-workflow.service.js';
import {
  type CreateEvidenceUploadDto,
  EVIDENCE_MIME_TYPES,
} from './dto/create-evidence-upload.dto.js';

export const EVIDENCE_NOT_FOUND = 'Evidence not found.';
export const EVIDENCE_CASE_CLOSED =
  'Evidence can only be added while the case is open.';
export const EVIDENCE_NEEDS_REPORT =
  'Submit a death report for this account before adding evidence.';
export const EVIDENCE_LIMIT = (max: number) =>
  `You can add up to ${max} files of evidence.`;

const MB = 1024 * 1024;

// What the uploader sees about their own files: no name, path or provider id.
const reporterSelect = {
  id: true,
  mimeType: true,
  sizeBytes: true,
  status: true,
  uploadedAt: true,
} satisfies Prisma.DeathVerificationEvidenceSelect;
export type ReporterEvidence = Prisma.DeathVerificationEvidenceGetPayload<{
  select: typeof reporterSelect;
}>;

const isOpen = (status: DeathVerificationCaseStatus) =>
  OPEN_STATUSES.includes(status);

/**
 * Phase 19A: supporting evidence (death certificate etc.) a reporter attaches
 * to their own DeathReport while the case is open. Same private storage,
 * direct upload, type checks and malware scan as every media file
 * (docs/media-storage.md). Evidence is supporting material only: nothing here
 * touches the case status, the account, Messages, schedules, releases or
 * grants. Not Customer content, so no storage quota is reserved.
 */
@Injectable()
export class DeathVerificationEvidenceService {
  private readonly logger = new Logger(DeathVerificationEvidenceService.name);
  private readonly settings: ReturnType<typeof mediaSettings>;
  private readonly maxBytes: number;
  private readonly maxFiles: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: MediaStorage,
    private readonly scanner: MalwareScanner,
    private readonly cleanup: MediaCleanup,
    config: ConfigService,
  ) {
    this.settings = mediaSettings(config);
    this.maxBytes = positiveInt(config, 'DEATH_EVIDENCE_MAX_BYTES', 20 * MB);
    this.maxFiles = positiveInt(config, 'DEATH_EVIDENCE_MAX_FILES', 5);
  }

  // The reporter's own file on this account; same 404 for anything else.
  private owned(reporter: Reporter, id: string) {
    return {
      id,
      deletedAt: null,
      deathReport: { reportedByTrustedContactId: reporter.id },
      deathVerificationCase: { ownerUserId: reporter.ownerUserId },
    } satisfies Prisma.DeathVerificationEvidenceWhereInput;
  }

  // ─── Trusted Contact (the reporter) ─────────────────────────────────────

  async createUploadUrl(
    reporter: Reporter,
    dto: CreateEvidenceUploadDto,
  ): Promise<UploadUrlResponse> {
    if (dto.sizeBytes > this.maxBytes) {
      throw new BadRequestException(
        `sizeBytes exceeds the evidence limit of ${this.maxBytes} bytes.`,
      );
    }
    const id = randomUUID();
    // Signing inside the transaction: no PENDING row survives a signing failure.
    const { caseId, upload } = await this.prisma.$transaction(async (tx) => {
      // The Customer's current case, share-locked: confirm-alive and admin
      // decisions wait for this transaction, so the status read here holds.
      const [current] = await tx.$queryRaw<
        { id: string; status: DeathVerificationCaseStatus }[]
      >`SELECT id, status FROM "DeathVerificationCase"
        WHERE "ownerUserId" = ${reporter.ownerUserId}::uuid
        ORDER BY "openedAt" DESC, id DESC LIMIT 1 FOR SHARE`;
      if (!current || !isOpen(current.status)) {
        throw new ConflictException(EVIDENCE_CASE_CLOSED);
      }
      // This contact's own report; locked so concurrent requests count right.
      const [report] = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "DeathReport"
        WHERE "deathVerificationCaseId" = ${current.id}::uuid
          AND "reportedByTrustedContactId" = ${reporter.id}::uuid
        FOR UPDATE`;
      if (!report) throw new ConflictException(EVIDENCE_NEEDS_REPORT);
      const inUse = await tx.deathVerificationEvidence.count({
        where: {
          deathReportId: report.id,
          deletedAt: null,
          status: {
            in: [MediaAssetStatus.PENDING_UPLOAD, MediaAssetStatus.READY],
          },
        },
      });
      if (inUse >= this.maxFiles) {
        throw new ConflictException(EVIDENCE_LIMIT(this.maxFiles));
      }
      // Server-chosen key from ids only: never the file name.
      const storageKey = mediaKey(
        reporter.ownerUserId,
        `death-verification/${current.id}`,
        'evidence',
        id,
        EVIDENCE_MIME_TYPES[dto.mimeType],
      );
      await tx.deathVerificationEvidence.create({
        data: {
          id,
          deathVerificationCaseId: current.id,
          deathReportId: report.id,
          storageKey,
          originalFileName: dto.originalFileName,
          mimeType: dto.mimeType,
          sizeBytes: dto.sizeBytes,
        },
        select: { id: true },
      });
      return {
        caseId: current.id,
        upload: await this.storage.createUpload(
          storageKey,
          dto.mimeType,
          dto.sizeBytes,
          this.settings.uploadTtl,
        ),
      };
    });
    this.logger.log(
      `death_evidence_upload_started case ${caseId} evidence ${id} trusted_contact ${reporter.id}`,
    );
    return {
      mediaAssetId: id,
      upload,
      expiresAt: expiresAt(this.settings.uploadTtl),
    };
  }

  /**
   * PENDING_UPLOAD → READY once the provider's file passes every check
   * (checkUpload: path, privacy, size, type, file signature, malware scan).
   * The case must still be open, checked before the scan and again, under a
   * share lock, in the transaction that marks it READY: an upload that
   * finishes after confirm-alive or an admin decision is discarded, never
   * attached. Idempotent: a READY file is returned as is.
   */
  async complete(
    reporter: Reporter,
    id: string,
    providerFileId: string,
  ): Promise<ReporterEvidence> {
    const row = await this.prisma.deathVerificationEvidence.findFirst({
      where: this.owned(reporter, id),
      select: {
        ...reporterSelect,
        storageKey: true,
        deathVerificationCaseId: true,
        deathVerificationCase: { select: { status: true } },
      },
    });
    if (!row) throw new NotFoundException(EVIDENCE_NOT_FOUND);
    const { storageKey, deathVerificationCaseId: caseId } = row;
    if (row.status === MediaAssetStatus.READY) return this.reporterView(id);
    if (row.status === MediaAssetStatus.FAILED) {
      throw new ConflictException(UPLOAD_FAILED);
    }
    if (!isOpen(row.deathVerificationCase.status)) {
      await this.discard(id);
      throw new ConflictException(EVIDENCE_CASE_CLOSED);
    }

    const check = await checkUpload(
      this.storage,
      this.scanner,
      { ...row, storageKey },
      providerFileId,
      this.settings.scanTimeoutMs,
    );
    if (check.status === 'missing') throw new ConflictException(NOT_UPLOADED);
    if (check.status !== 'ok') {
      const failed = await this.prisma.deathVerificationEvidence.update({
        where: { id },
        data: {
          status: MediaAssetStatus.FAILED,
          providerFileId: check.ref.providerFileId,
        },
        select: storedRefSelect,
      });
      await this.cleanup.purge('deathVerificationEvidence', [failed]);
      this.logger.warn(
        `death_evidence_rejected case ${caseId} evidence ${id} (${check.status})`,
      );
      throw rejected(check.status);
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      const [current] = await tx.$queryRaw<
        { status: DeathVerificationCaseStatus }[]
      >`SELECT status FROM "DeathVerificationCase" WHERE id = ${caseId}::uuid FOR SHARE`;
      if (!current || !isOpen(current.status)) return 'closed' as const;
      const { count } = await tx.deathVerificationEvidence.updateMany({
        where: {
          id,
          status: MediaAssetStatus.PENDING_UPLOAD,
          deletedAt: null,
        },
        data: {
          status: MediaAssetStatus.READY,
          uploadedAt: new Date(),
          providerFileId: check.ref.providerFileId,
        },
      });
      // A concurrent complete won (or the row went): nothing to record.
      if (!count) return 'raced' as const;
      await audit(tx, caseId, 'EVIDENCE_UPLOADED', {
        type: 'TRUSTED_CONTACT',
        trustedContactId: reporter.id,
      });
      return 'ready' as const;
    });
    if (outcome === 'closed') {
      // The verified file is ours (checkUpload matched it to this key).
      await this.discard(id, check.ref.providerFileId);
      throw new ConflictException(EVIDENCE_CASE_CLOSED);
    }
    const ready = await this.reporterView(id);
    if (outcome === 'raced' && ready.status !== MediaAssetStatus.READY) {
      throw new ConflictException(NOT_READY);
    }
    if (outcome === 'ready') {
      this.logger.log(
        `death_evidence_ready case ${caseId} evidence ${id} trusted_contact ${reporter.id}`,
      );
    }
    return ready;
  }

  /** The reporter's own READY files on the account holder's current case. */
  async listForReporter(reporter: Reporter): Promise<ReporterEvidence[]> {
    const current = await this.prisma.deathVerificationCase.findFirst({
      where: { ownerUserId: reporter.ownerUserId },
      orderBy: LATEST,
      select: { id: true },
    });
    if (!current) return [];
    return this.prisma.deathVerificationEvidence.findMany({
      where: {
        deathVerificationCaseId: current.id,
        deathReport: { reportedByTrustedContactId: reporter.id },
        status: MediaAssetStatus.READY,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      select: reporterSelect,
    });
  }

  // The uploader may re-view their own READY file. Never stored or logged.
  async reporterAccessUrl(
    reporter: Reporter,
    id: string,
  ): Promise<AccessUrlResponse> {
    const row = await this.prisma.deathVerificationEvidence.findFirst({
      where: this.owned(reporter, id),
      select: { status: true, ...storedRefSelect },
    });
    if (!row) throw new NotFoundException(EVIDENCE_NOT_FOUND);
    const access = await this.accessUrl(row);
    this.logger.log(
      `death_evidence_viewed evidence ${id} trusted_contact ${reporter.id}`,
    );
    return access;
  }

  // ─── Admin ──────────────────────────────────────────────────────────────

  /**
   * A short-lived signed URL for one READY file of this case. The view is
   * recorded on the case timeline before the URL is handed out; the URL is
   * never stored, logged or audited.
   */
  async adminAccessUrl(
    caseId: string,
    id: string,
    adminUserId: string,
  ): Promise<AccessUrlResponse> {
    const row = await this.prisma.deathVerificationEvidence.findFirst({
      where: { id, deathVerificationCaseId: caseId, deletedAt: null },
      select: { status: true, ...storedRefSelect },
    });
    if (!row) throw new NotFoundException(EVIDENCE_NOT_FOUND);
    if (row.status !== MediaAssetStatus.READY) {
      throw new ConflictException(NOT_READY);
    }
    await this.prisma.$transaction((tx) =>
      audit(tx, caseId, 'EVIDENCE_VIEWED_BY_ADMIN', {
        type: 'ADMIN',
        userId: adminUserId,
      }),
    );
    const access = await this.accessUrl(row);
    this.logger.log(
      `death_evidence_viewed case ${caseId} evidence ${id} admin ${adminUserId}`,
    );
    return access;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private reporterView(id: string) {
    return this.prisma.deathVerificationEvidence.findUniqueOrThrow({
      where: { id },
      select: reporterSelect,
    });
  }

  private async accessUrl(
    row: { status: MediaAssetStatus } & Parameters<MediaStorage['createAccessUrl']>[0],
  ): Promise<AccessUrlResponse> {
    if (row.status !== MediaAssetStatus.READY) {
      throw new ConflictException(NOT_READY);
    }
    return {
      url: await this.storage.createAccessUrl(row, this.settings.accessTtl),
      expiresAt: expiresAt(this.settings.accessTtl),
    };
  }

  /**
   * An upload for a case that closed meanwhile: soft-deleted, then its file
   * removed best effort (MediaCleanup retries). Only a verified provider id
   * is recorded; the browser's hint is never trusted for a delete.
   */
  private async discard(id: string, providerFileId?: string | null) {
    const gone = await this.prisma.deathVerificationEvidence.update({
      where: { id },
      data: { deletedAt: new Date(), ...(providerFileId && { providerFileId }) },
      select: storedRefSelect,
    });
    await this.cleanup.purge('deathVerificationEvidence', [gone]);
  }
}

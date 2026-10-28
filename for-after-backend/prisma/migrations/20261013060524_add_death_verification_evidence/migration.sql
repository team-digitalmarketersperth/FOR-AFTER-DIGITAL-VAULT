-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DeathVerificationAuditEventType" ADD VALUE 'EVIDENCE_UPLOADED';
ALTER TYPE "DeathVerificationAuditEventType" ADD VALUE 'EVIDENCE_VIEWED_BY_ADMIN';

-- CreateTable
CREATE TABLE "DeathVerificationEvidence" (
    "id" UUID NOT NULL,
    "deathVerificationCaseId" UUID NOT NULL,
    "deathReportId" UUID NOT NULL,
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storageKey" TEXT NOT NULL,
    "storageProvider" "MediaStorageProvider" NOT NULL DEFAULT 'IMAGEKIT',
    "providerFileId" TEXT,
    "storageDeletedAt" TIMESTAMP(3),
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DeathVerificationEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeathVerificationEvidence_storageKey_key" ON "DeathVerificationEvidence"("storageKey");

-- CreateIndex
CREATE INDEX "DeathVerificationEvidence_deathVerificationCaseId_status_idx" ON "DeathVerificationEvidence"("deathVerificationCaseId", "status");

-- CreateIndex
CREATE INDEX "DeathVerificationEvidence_deathReportId_status_idx" ON "DeathVerificationEvidence"("deathReportId", "status");

-- AddForeignKey
ALTER TABLE "DeathVerificationEvidence" ADD CONSTRAINT "DeathVerificationEvidence_deathVerificationCaseId_fkey" FOREIGN KEY ("deathVerificationCaseId") REFERENCES "DeathVerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathVerificationEvidence" ADD CONSTRAINT "DeathVerificationEvidence_deathReportId_fkey" FOREIGN KEY ("deathReportId") REFERENCES "DeathReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

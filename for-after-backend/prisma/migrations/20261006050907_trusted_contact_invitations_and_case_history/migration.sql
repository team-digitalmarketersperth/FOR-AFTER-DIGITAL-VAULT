-- CreateEnum
CREATE TYPE "TrustedContactInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AuditActorType" ADD VALUE 'TRUSTED_CONTACT';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'TRUSTED_CONTACT_INVITATION_SENT';
ALTER TYPE "AuditEventType" ADD VALUE 'TRUSTED_CONTACT_INVITATION_ACCEPTED';
ALTER TYPE "AuditEventType" ADD VALUE 'TRUSTED_CONTACT_INVITATION_DECLINED';

-- AlterEnum
ALTER TYPE "DeathVerificationAuditEventType" ADD VALUE 'CASE_REOPENED';

-- DropIndex
DROP INDEX "DeathVerificationCase_ownerUserId_key";

-- AlterTable
ALTER TABLE "DeathVerificationCase" ADD COLUMN     "reopenedFromCaseId" UUID;

-- CreateTable
CREATE TABLE "TrustedContactInvitation" (
    "id" UUID NOT NULL,
    "trustedContactId" UUID NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "TrustedContactInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustedContactInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrustedContactInvitation_tokenHash_key" ON "TrustedContactInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "TrustedContactInvitation_trustedContactId_createdAt_idx" ON "TrustedContactInvitation"("trustedContactId", "createdAt");

-- CreateIndex
CREATE INDEX "DeathVerificationCase_ownerUserId_openedAt_idx" ON "DeathVerificationCase"("ownerUserId", "openedAt");

-- AddForeignKey
ALTER TABLE "TrustedContactInvitation" ADD CONSTRAINT "TrustedContactInvitation_trustedContactId_fkey" FOREIGN KEY ("trustedContactId") REFERENCES "TrustedContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Phase 10: a Customer may have many death-verification cases over time, but
-- at most ONE that is open or VERIFIED. So two open cases can never coexist,
-- and no case can be opened next to a verified death. CANCELLED/REJECTED
-- cases are history and do not count. Existing data had at most one case per
-- Customer (the dropped unique index), so this always builds. Not expressible
-- in schema.prisma; submitReport also locks the Customer row.
CREATE UNIQUE INDEX "DeathVerificationCase_one_live_per_owner"
  ON "DeathVerificationCase" ("ownerUserId")
  WHERE "status" IN ('PENDING_VERIFICATION', 'SAFEGUARD_ACTIVE', 'READY_FOR_REVIEW', 'VERIFIED');

-- At most one PENDING invitation per Trusted Contact: a resend cancels the old
-- one in the same transaction (which also locks the Customer row).
CREATE UNIQUE INDEX "TrustedContactInvitation_one_pending_per_contact"
  ON "TrustedContactInvitation" ("trustedContactId")
  WHERE "status" = 'PENDING';

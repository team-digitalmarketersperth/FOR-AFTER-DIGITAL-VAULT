-- Notification centre, Step 7: marketing consent, email suppression list and pilot audience (additive only).

-- CreateEnum
CREATE TYPE "AnnouncementAudience" AS ENUM ('PILOT', 'ALL_ELIGIBLE');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'HARD_BOUNCE', 'COMPLAINT');

-- AlterEnum

ALTER TYPE "AuditEventType" ADD VALUE 'MARKETING_CONSENT_GRANTED';
ALTER TYPE "AuditEventType" ADD VALUE 'MARKETING_CONSENT_WITHDRAWN';
ALTER TYPE "AuditEventType" ADD VALUE 'EMAIL_SUPPRESSED';
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_AUDIENCE_UPDATED';

-- AlterTable
ALTER TABLE "AnnouncementSendRun" ADD COLUMN     "audience" "AnnouncementAudience" NOT NULL DEFAULT 'PILOT';

-- AlterTable
ALTER TABLE "EmailAnnouncement" ADD COLUMN     "audience" "AnnouncementAudience" NOT NULL DEFAULT 'PILOT';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "marketingConsentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AnnouncementPilotMember" (
    "announcementId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "addedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementPilotMember_pkey" PRIMARY KEY ("announcementId","userId")
);

-- CreateTable
CREATE TABLE "EmailSuppression" (
    "id" UUID NOT NULL,
    "emailHash" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailSuppression_emailHash_key" ON "EmailSuppression"("emailHash");

-- AddForeignKey
ALTER TABLE "AnnouncementPilotMember" ADD CONSTRAINT "AnnouncementPilotMember_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "EmailAnnouncement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementPilotMember" ADD CONSTRAINT "AnnouncementPilotMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementPilotMember" ADD CONSTRAINT "AnnouncementPilotMember_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailSuppression" ADD CONSTRAINT "EmailSuppression_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


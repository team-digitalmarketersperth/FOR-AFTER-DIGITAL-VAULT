-- Notification centre, Step 2: test emails to the requesting SUPER_ADMIN (additive only).

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_TEST_REQUESTED';
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_TEST_COMPLETED';

-- CreateEnum
CREATE TYPE "AnnouncementTestStatus" AS ENUM ('QUEUED', 'PROCESSING', 'ACCEPTED', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "AnnouncementTestSend" (
    "id" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "announcementVersion" INTEGER NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "clientOperationId" UUID NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaLabel" TEXT,
    "ctaDestination" TEXT,
    "status" "AnnouncementTestStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "providerMessageId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnouncementTestSend_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnnouncementTestSend_requestedByUserId_createdAt_idx" ON "AnnouncementTestSend"("requestedByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "AnnouncementTestSend_status_createdAt_idx" ON "AnnouncementTestSend"("status", "createdAt");

-- CreateIndex
CREATE INDEX "AnnouncementTestSend_announcementId_createdAt_idx" ON "AnnouncementTestSend"("announcementId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementTestSend_requestedByUserId_clientOperationId_key" ON "AnnouncementTestSend"("requestedByUserId", "clientOperationId");

-- AddForeignKey
ALTER TABLE "AnnouncementTestSend" ADD CONSTRAINT "AnnouncementTestSend_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "EmailAnnouncement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementTestSend" ADD CONSTRAINT "AnnouncementTestSend_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

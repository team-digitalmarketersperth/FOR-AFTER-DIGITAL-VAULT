-- Notification centre, Step 4: customer broadcast runs and per-recipient outcomes (additive only).
-- CreateEnum
CREATE TYPE "AnnouncementRunStatus" AS ENUM ('PREPARING', 'SENDING', 'COMPLETED', 'CANCELLED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "AnnouncementRecipientStatus" AS ENUM ('QUEUED', 'PROCESSING', 'ACCEPTED', 'FAILED', 'UNKNOWN', 'SKIPPED', 'CANCELLED');

-- AlterEnum

ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_BROADCAST_REQUESTED';
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_BROADCAST_QUEUED';
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_BROADCAST_CANCEL_REQUESTED';
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_BROADCAST_FINISHED';

-- CreateTable
CREATE TABLE "AnnouncementSendRun" (
    "id" UUID NOT NULL,
    "announcementId" UUID NOT NULL,
    "announcementVersion" INTEGER NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "clientOperationId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaLabel" TEXT,
    "ctaDestination" TEXT,
    "html" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "reviewedCount" INTEGER NOT NULL,
    "status" "AnnouncementRunStatus" NOT NULL DEFAULT 'PREPARING',
    "audienceBoundaryAt" TIMESTAMP(3) NOT NULL,
    "prepareCursor" UUID,
    "preparedAt" TIMESTAMP(3),
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "cancelRequestedAt" TIMESTAMP(3),
    "cancelledByUserId" UUID,
    "finishReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnouncementSendRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementRunRecipient" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "emailHash" TEXT NOT NULL,
    "status" "AnnouncementRecipientStatus" NOT NULL DEFAULT 'QUEUED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "attemptedAt" TIMESTAMP(3),
    "reasonCode" TEXT,
    "providerMessageId" TEXT,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnouncementRunRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementSendRun_announcementId_key" ON "AnnouncementSendRun"("announcementId");

-- CreateIndex
CREATE INDEX "AnnouncementSendRun_status_leaseUntil_idx" ON "AnnouncementSendRun"("status", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementSendRun_requestedByUserId_clientOperationId_key" ON "AnnouncementSendRun"("requestedByUserId", "clientOperationId");

-- CreateIndex
CREATE INDEX "AnnouncementRunRecipient_runId_status_id_idx" ON "AnnouncementRunRecipient"("runId", "status", "id");

-- CreateIndex
CREATE INDEX "AnnouncementRunRecipient_attemptedAt_idx" ON "AnnouncementRunRecipient"("attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementRunRecipient_runId_userId_key" ON "AnnouncementRunRecipient"("runId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementRunRecipient_runId_emailHash_key" ON "AnnouncementRunRecipient"("runId", "emailHash");

-- AddForeignKey
ALTER TABLE "AnnouncementSendRun" ADD CONSTRAINT "AnnouncementSendRun_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "EmailAnnouncement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementSendRun" ADD CONSTRAINT "AnnouncementSendRun_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementSendRun" ADD CONSTRAINT "AnnouncementSendRun_cancelledByUserId_fkey" FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRunRecipient" ADD CONSTRAINT "AnnouncementRunRecipient_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnnouncementSendRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRunRecipient" ADD CONSTRAINT "AnnouncementRunRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one broadcast in progress at a time (the configured rate is then global).
CREATE UNIQUE INDEX "AnnouncementSendRun_one_active_key" ON "AnnouncementSendRun" ((true)) WHERE "status" IN ('PREPARING', 'SENDING');

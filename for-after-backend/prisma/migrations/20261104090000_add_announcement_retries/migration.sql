-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_BROADCAST_RETRY_REQUESTED';

-- CreateTable
CREATE TABLE "AnnouncementRetry" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "requestedByUserId" UUID NOT NULL,
    "clientOperationId" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "setHash" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "previousRunStatus" "AnnouncementRunStatus" NOT NULL,
    "previousCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementRetry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementRetryItem" (
    "id" UUID NOT NULL,
    "retryId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "previousReasonCode" TEXT,
    "previousAttemptCount" INTEGER NOT NULL,
    "previousAttemptedAt" TIMESTAMP(3),
    "previousFinishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnouncementRetryItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnnouncementRetry_runId_createdAt_idx" ON "AnnouncementRetry"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementRetry_requestedByUserId_clientOperationId_key" ON "AnnouncementRetry"("requestedByUserId", "clientOperationId");

-- CreateIndex
CREATE INDEX "AnnouncementRetryItem_recipientId_idx" ON "AnnouncementRetryItem"("recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnouncementRetryItem_retryId_recipientId_key" ON "AnnouncementRetryItem"("retryId", "recipientId");

-- AddForeignKey
ALTER TABLE "AnnouncementRetry" ADD CONSTRAINT "AnnouncementRetry_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AnnouncementSendRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRetry" ADD CONSTRAINT "AnnouncementRetry_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRetryItem" ADD CONSTRAINT "AnnouncementRetryItem_retryId_fkey" FOREIGN KEY ("retryId") REFERENCES "AnnouncementRetry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnouncementRetryItem" ADD CONSTRAINT "AnnouncementRetryItem_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "AnnouncementRunRecipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;



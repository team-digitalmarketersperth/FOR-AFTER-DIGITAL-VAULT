-- CreateEnum
CREATE TYPE "DeadLetterStatus" AS ENUM ('OPEN', 'REQUEUED', 'RESOLVED');

-- CreateEnum
CREATE TYPE "OpsAlertStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'NOT_CONFIGURED');

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'DEAD_LETTER_RETRY_REQUESTED';

-- CreateTable
CREATE TABLE "DeadLetterJob" (
    "id" UUID NOT NULL,
    "queueName" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" UUID,
    "attemptsMade" INTEGER NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "failedAt" TIMESTAMP(3) NOT NULL,
    "failureCount" INTEGER NOT NULL DEFAULT 1,
    "status" "DeadLetterStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "requeuedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "alertStatus" "OpsAlertStatus" NOT NULL DEFAULT 'PENDING',
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeadLetterJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeadLetterJob_status_failedAt_idx" ON "DeadLetterJob"("status", "failedAt");

-- CreateIndex
CREATE INDEX "DeadLetterJob_queueName_failedAt_idx" ON "DeadLetterJob"("queueName", "failedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeadLetterJob_queueName_jobId_key" ON "DeadLetterJob"("queueName", "jobId");


-- CreateEnum
CREATE TYPE "DeathVerificationAuditEventType" AS ENUM ('REPORT_RECEIVED', 'SAFETY_NOTICE_SENT', 'SAFEGUARD_STARTED', 'SAFEGUARD_ELAPSED', 'CUSTOMER_CONFIRMED_ALIVE', 'ADMIN_VERIFIED', 'ADMIN_REJECTED', 'DEATH_TRIGGER_ACTIVATION_STARTED', 'DEATH_TRIGGER_ACTIVATION_COMPLETED');

-- CreateEnum
CREATE TYPE "DeathVerificationActorType" AS ENUM ('SYSTEM', 'CUSTOMER', 'TRUSTED_CONTACT', 'ADMIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "DeathVerificationCaseStatus" ADD VALUE 'SAFEGUARD_ACTIVE';
ALTER TYPE "DeathVerificationCaseStatus" ADD VALUE 'READY_FOR_REVIEW';

-- AlterTable
ALTER TABLE "DeathVerificationCase" ADD COLUMN     "adminDecisionNote" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "deathTriggersActivatedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedByUserId" UUID,
ADD COLUMN     "safeguardEndsAt" TIMESTAMP(3),
ADD COLUMN     "safeguardStartedAt" TIMESTAMP(3),
ADD COLUMN     "safetyNoticeAttemptCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "safetyNoticeLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "safetyNoticeSentAt" TIMESTAMP(3),
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedByUserId" UUID,
ADD COLUMN     "verifiedDeathAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeathVerificationAuditEvent" (
    "id" UUID NOT NULL,
    "deathVerificationCaseId" UUID NOT NULL,
    "eventType" "DeathVerificationAuditEventType" NOT NULL,
    "actorType" "DeathVerificationActorType" NOT NULL,
    "actorUserId" UUID,
    "actorTrustedContactId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeathVerificationAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeathTriggeredMessageActivation" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "deathVerificationCaseId" UUID NOT NULL,
    "triggerType" "ReleaseTriggerType" NOT NULL,
    "activatedAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeathTriggeredMessageActivation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeathVerificationAuditEvent_deathVerificationCaseId_created_idx" ON "DeathVerificationAuditEvent"("deathVerificationCaseId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeathTriggeredMessageActivation_messageId_key" ON "DeathTriggeredMessageActivation"("messageId");

-- CreateIndex
CREATE INDEX "DeathTriggeredMessageActivation_deathVerificationCaseId_idx" ON "DeathTriggeredMessageActivation"("deathVerificationCaseId");

-- CreateIndex
CREATE INDEX "DeathTriggeredMessageActivation_dueAt_idx" ON "DeathTriggeredMessageActivation"("dueAt");

-- CreateIndex
CREATE INDEX "DeathVerificationCase_status_idx" ON "DeathVerificationCase"("status");

-- AddForeignKey
ALTER TABLE "DeathVerificationAuditEvent" ADD CONSTRAINT "DeathVerificationAuditEvent_deathVerificationCaseId_fkey" FOREIGN KEY ("deathVerificationCaseId") REFERENCES "DeathVerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathTriggeredMessageActivation" ADD CONSTRAINT "DeathTriggeredMessageActivation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathTriggeredMessageActivation" ADD CONSTRAINT "DeathTriggeredMessageActivation_deathVerificationCaseId_fkey" FOREIGN KEY ("deathVerificationCaseId") REFERENCES "DeathVerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

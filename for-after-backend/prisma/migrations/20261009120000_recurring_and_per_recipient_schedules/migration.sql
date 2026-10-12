-- DropIndex
DROP INDEX "ReleaseNotification_grantId_key";

-- AlterTable
ALTER TABLE "MessageSchedule" ADD COLUMN     "annualDay" INTEGER,
ADD COLUMN     "annualMonth" INTEGER,
ADD COLUMN     "eventDate" DATE,
ADD COLUMN     "eventLabel" TEXT,
ADD COLUMN     "localTime" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "ReleaseNotification" ADD COLUMN     "occurrenceId" UUID;

-- CreateTable
CREATE TABLE "MessageRecipientRelease" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "occurrenceYear" INTEGER NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageRecipientRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageRecipientRelease_releasedAt_dueAt_idx" ON "MessageRecipientRelease"("releasedAt", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageRecipientRelease_messageId_recipientId_occurrenceYea_key" ON "MessageRecipientRelease"("messageId", "recipientId", "occurrenceYear");

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseNotification_occurrenceId_key" ON "ReleaseNotification"("occurrenceId");

-- CreateIndex
CREATE INDEX "ReleaseNotification_grantId_idx" ON "ReleaseNotification"("grantId");

-- AddForeignKey
ALTER TABLE "MessageRecipientRelease" ADD CONSTRAINT "MessageRecipientRelease_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRecipientRelease" ADD CONSTRAINT "MessageRecipientRelease_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReleaseNotification" ADD CONSTRAINT "ReleaseNotification_occurrenceId_fkey" FOREIGN KEY ("occurrenceId") REFERENCES "MessageRecipientRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written (Prisma schema cannot express these).
-- Whole-message releases keep exactly one email per grant; recurring
-- occurrences are keyed by occurrenceId (unique above).
CREATE UNIQUE INDEX "ReleaseNotification_grantId_whole_release_key" ON "ReleaseNotification"("grantId") WHERE "occurrenceId" IS NULL;

-- Widen the trigger CHECK on purpose: every trigger, each with exactly its own
-- fields. Existing FIXED_DATE / ON_DEATH / AFTER_DEATH rows still satisfy it
-- (the new columns are NULL for them).
ALTER TABLE "MessageSchedule" DROP CONSTRAINT "MessageSchedule_trigger_fields_check";
ALTER TABLE "MessageSchedule" ADD CONSTRAINT "MessageSchedule_trigger_fields_check" CHECK (
    ("triggerType" = 'FIXED_DATE' AND "scheduledFor" IS NOT NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NULL AND "localTime" IS NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" IN ('NOW', 'ON_DEATH') AND "scheduledFor" IS NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NULL AND "localTime" IS NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" = 'AFTER_DEATH' AND "scheduledFor" IS NULL AND "afterDeathDays" >= 0
        AND "timezone" IS NULL AND "localTime" IS NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" IN ('BIRTHDAY', 'ANNUAL_AFTER_DEATH') AND "scheduledFor" IS NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NOT NULL AND "localTime" IS NOT NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" = 'ANNIVERSARY' AND "scheduledFor" IS NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NOT NULL AND "localTime" IS NOT NULL
        AND "annualMonth" BETWEEN 1 AND 12 AND "annualDay" BETWEEN 1 AND 31
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" = 'CUSTOM_EVENT' AND "scheduledFor" IS NOT NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NOT NULL AND "localTime" IS NOT NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NOT NULL AND length("eventLabel") BETWEEN 1 AND 100)
);
ALTER TABLE "MessageSchedule" ADD CONSTRAINT "MessageSchedule_localTime_check" CHECK (
    "localTime" IS NULL OR "localTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
);

-- CreateEnum
CREATE TYPE "ReleaseTriggerType" AS ENUM ('NOW', 'FIXED_DATE', 'BIRTHDAY', 'ANNIVERSARY', 'CUSTOM_EVENT', 'ON_DEATH', 'AFTER_DEATH', 'ANNUAL_AFTER_DEATH');

-- CreateTable
CREATE TABLE "MessageSchedule" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "triggerType" "ReleaseTriggerType" NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "afterDeathDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageSchedule_messageId_key" ON "MessageSchedule"("messageId");

-- AddForeignKey
ALTER TABLE "MessageSchedule" ADD CONSTRAINT "MessageSchedule_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint (hand-written: Prisma schema cannot express CHECK)
-- Only the triggers the API supports, each with exactly its own fields.
-- A new trigger type needs a migration that widens this on purpose.
ALTER TABLE "MessageSchedule" ADD CONSTRAINT "MessageSchedule_trigger_fields_check" CHECK (
    ("triggerType" = 'FIXED_DATE' AND "scheduledFor" IS NOT NULL AND "afterDeathDays" IS NULL)
    OR ("triggerType" = 'ON_DEATH' AND "scheduledFor" IS NULL AND "afterDeathDays" IS NULL)
    OR ("triggerType" = 'AFTER_DEATH' AND "scheduledFor" IS NULL AND "afterDeathDays" >= 0)
);

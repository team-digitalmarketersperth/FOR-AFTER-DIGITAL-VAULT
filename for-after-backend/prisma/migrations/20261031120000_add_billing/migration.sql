-- AlterEnum
ALTER TYPE "AuditActorType" ADD VALUE 'SYSTEM';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'TRIAL_STARTED';
ALTER TYPE "AuditEventType" ADD VALUE 'SUBSCRIPTION_SYNCED';

-- CreateTable
CREATE TABLE "CustomerTrial" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerTrial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "stripeCustomerId" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "stripeSubscriptionId" TEXT,
    "plan" TEXT,
    "subscriptionStatus" TEXT,
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "currentPeriodEnd" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTrial_userId_key" ON "CustomerTrial"("userId");

-- CreateIndex
CREATE INDEX "CustomerTrial_endsAt_idx" ON "CustomerTrial"("endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_userId_key" ON "BillingAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_stripeCustomerId_key" ON "BillingAccount"("stripeCustomerId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_stripeSubscriptionId_key" ON "BillingAccount"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "BillingAccount_subscriptionStatus_currentPeriodEnd_idx" ON "BillingAccount"("subscriptionStatus", "currentPeriodEnd");

-- AddForeignKey
ALTER TABLE "CustomerTrial" ADD CONSTRAINT "CustomerTrial_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAccount" ADD CONSTRAINT "BillingAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


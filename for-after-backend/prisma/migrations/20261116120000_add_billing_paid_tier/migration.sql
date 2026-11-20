-- Updated Plans Step 2: product tier, separate from the billing interval ("plan"). Additive and nullable:
-- no existing row is changed or backfilled (no approved mapping for legacy subscriptions).

-- CreateEnum
CREATE TYPE "PaidTier" AS ENUM ('PREMIUM', 'COMPLETE');

-- AlterTable
ALTER TABLE "BillingAccount" ADD COLUMN "tier" "PaidTier";

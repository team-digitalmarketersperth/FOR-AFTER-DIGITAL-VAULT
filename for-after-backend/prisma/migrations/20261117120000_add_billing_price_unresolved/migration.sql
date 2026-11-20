-- Updated Plans Step 6: a subscription whose price matches no configured mapping. Additive with a false default:
-- no existing row changes meaning (existing unmapped subscriptions keep their access).

-- AlterTable
ALTER TABLE "BillingAccount" ADD COLUMN "priceUnresolved" BOOLEAN NOT NULL DEFAULT false;

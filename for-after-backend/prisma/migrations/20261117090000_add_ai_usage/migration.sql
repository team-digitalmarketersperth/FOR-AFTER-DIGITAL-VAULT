-- Updated Plans Step 5: AI companion allowance accounting (metadata only; no prompts or replies). Additive.

-- CreateEnum
CREATE TYPE "AiUsageStatus" AS ENUM ('RESERVED', 'USED', 'RELEASED');

-- CreateTable
CREATE TABLE "AiUsage" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "requestId" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "status" "AiUsageStatus" NOT NULL DEFAULT 'RESERVED',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiUsage_userId_requestId_key" ON "AiUsage"("userId", "requestId");

-- CreateIndex
CREATE INDEX "AiUsage_userId_period_status_idx" ON "AiUsage"("userId", "period", "status");

-- AddForeignKey
ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

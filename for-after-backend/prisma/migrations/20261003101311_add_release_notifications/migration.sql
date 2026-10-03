-- CreateEnum
CREATE TYPE "ReleaseNotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "ReleaseNotification" (
    "id" UUID NOT NULL,
    "grantId" UUID NOT NULL,
    "status" "ReleaseNotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReleaseNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReleaseNotification_grantId_key" ON "ReleaseNotification"("grantId");

-- CreateIndex
CREATE INDEX "ReleaseNotification_status_createdAt_idx" ON "ReleaseNotification"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "ReleaseNotification" ADD CONSTRAINT "ReleaseNotification_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "RecipientMessageAccessGrant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

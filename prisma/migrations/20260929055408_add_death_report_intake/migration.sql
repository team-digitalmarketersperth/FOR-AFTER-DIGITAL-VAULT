-- CreateEnum
CREATE TYPE "DeathVerificationCaseStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "DeathVerificationCase" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "status" "DeathVerificationCaseStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeathVerificationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeathReport" (
    "id" UUID NOT NULL,
    "deathVerificationCaseId" UUID NOT NULL,
    "reportedByTrustedContactId" UUID NOT NULL,
    "reporterFirstNameSnapshot" TEXT NOT NULL,
    "reporterLastNameSnapshot" TEXT,
    "reporterEmailNormalized" TEXT,
    "reporterMobileNormalized" TEXT,
    "reportedDateOfDeath" DATE,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeathReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeathVerificationCase_ownerUserId_key" ON "DeathVerificationCase"("ownerUserId");

-- CreateIndex
CREATE INDEX "DeathReport_reportedByTrustedContactId_idx" ON "DeathReport"("reportedByTrustedContactId");

-- CreateIndex
CREATE UNIQUE INDEX "DeathReport_deathVerificationCaseId_reportedByTrustedContac_key" ON "DeathReport"("deathVerificationCaseId", "reportedByTrustedContactId");

-- CreateIndex
CREATE INDEX "TrustedContact_email_idx" ON "TrustedContact"("email");

-- AddForeignKey
ALTER TABLE "DeathVerificationCase" ADD CONSTRAINT "DeathVerificationCase_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathReport" ADD CONSTRAINT "DeathReport_deathVerificationCaseId_fkey" FOREIGN KEY ("deathVerificationCaseId") REFERENCES "DeathVerificationCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeathReport" ADD CONSTRAINT "DeathReport_reportedByTrustedContactId_fkey" FOREIGN KEY ("reportedByTrustedContactId") REFERENCES "TrustedContact"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

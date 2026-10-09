-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'MY_WISHES_DISCLAIMER_ACKNOWLEDGED';

-- CreateTable
CREATE TABLE "MyWishesDisclaimerAcknowledgement" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "disclaimerVersion" INTEGER NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MyWishesDisclaimerAcknowledgement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MyWishesDisclaimerAcknowledgement_userId_disclaimerVersion_key" ON "MyWishesDisclaimerAcknowledgement"("userId", "disclaimerVersion");

-- AddForeignKey
ALTER TABLE "MyWishesDisclaimerAcknowledgement" ADD CONSTRAINT "MyWishesDisclaimerAcknowledgement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "TrustedContact" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "relationship" TEXT,
    "email" TEXT,
    "mobile" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "TrustedContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TrustedContact_ownerUserId_idx" ON "TrustedContact"("ownerUserId");

-- AddForeignKey
ALTER TABLE "TrustedContact" ADD CONSTRAINT "TrustedContact_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint (hand-written: Prisma schema cannot express CHECK)
-- A trusted contact must stay reachable for future verification.
ALTER TABLE "TrustedContact" ADD CONSTRAINT "TrustedContact_contact_method_check" CHECK ("email" IS NOT NULL OR "mobile" IS NOT NULL);

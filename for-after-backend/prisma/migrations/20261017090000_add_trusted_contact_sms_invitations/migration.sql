-- AlterTable
ALTER TABLE "TrustedContactInvitation" ALTER COLUMN "emailNormalized" DROP NOT NULL,
ADD COLUMN     "mobile" TEXT;

-- AddCheckConstraint (hand-written: Prisma schema cannot express CHECK)
ALTER TABLE "TrustedContactInvitation" ADD CONSTRAINT "TrustedContactInvitation_destination_check" CHECK (num_nonnulls("emailNormalized", "mobile") = 1);

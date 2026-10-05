-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'EMAIL_CHANGE_REQUESTED';
ALTER TYPE "AuditEventType" ADD VALUE 'EMAIL_CHANGED';

-- AlterEnum
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'EMAIL_CHANGE';

-- AlterTable
ALTER TABLE "AuthToken" ADD COLUMN     "newEmail" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailChangedAt" TIMESTAMP(3);

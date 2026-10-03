-- AlterEnum
ALTER TYPE "AuditActorType" ADD VALUE 'CUSTOMER';

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'PASSWORD_CHANGED';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordChangedAt" TIMESTAMP(3);

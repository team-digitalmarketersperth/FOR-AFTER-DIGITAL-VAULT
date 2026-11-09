-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'ADMIN_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'ADMIN_INVITATION_SENT';
ALTER TYPE "AuditEventType" ADD VALUE 'ADMIN_INVITATION_ACCEPTED';
ALTER TYPE "AuditEventType" ADD VALUE 'SUPER_ADMIN_BOOTSTRAPPED';

-- AlterEnum
ALTER TYPE "AuthTokenPurpose" ADD VALUE 'ADMIN_INVITATION';


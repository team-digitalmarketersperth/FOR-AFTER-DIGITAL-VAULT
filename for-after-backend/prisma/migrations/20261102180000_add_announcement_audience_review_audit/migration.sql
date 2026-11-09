-- Notification centre, Step 3: audit event for the read-only audience review (additive only).

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_AUDIENCE_REVIEWED';

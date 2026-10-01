-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('ADMIN_PASSWORD_AUTH_SUCCEEDED', 'ADMIN_MFA_SETUP_COMPLETED', 'ADMIN_MFA_VERIFIED', 'ADMIN_MFA_FAILED', 'ADMIN_RECOVERY_CODE_USED', 'ADMIN_LOGIN', 'ADMIN_LOGOUT', 'USER_SUSPENDED', 'USER_REACTIVATED', 'ADMIN_VIEWED_USER', 'ADMIN_VIEWED_DEATH_CASE', 'DEATH_VERIFICATION_VERIFIED', 'DEATH_VERIFICATION_REJECTED', 'FAILED_JOB_RETRIED');

-- CreateEnum
CREATE TYPE "AuditActorType" AS ENUM ('ADMIN', 'SUPER_ADMIN');

-- CreateTable
CREATE TABLE "AdminMfaCredential" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "totpSecretEncrypted" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "lastUsedTimeStep" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminMfaCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminMfaRecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "eventType" "AuditEventType" NOT NULL,
    "actorType" "AuditActorType" NOT NULL,
    "actorUserId" UUID,
    "subjectType" TEXT,
    "subjectId" TEXT,
    "ipPrefix" TEXT,
    "userAgent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminMfaCredential_userId_key" ON "AdminMfaCredential"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AdminMfaRecoveryCode_codeHash_key" ON "AdminMfaRecoveryCode"("codeHash");

-- CreateIndex
CREATE INDEX "AdminMfaRecoveryCode_userId_idx" ON "AdminMfaRecoveryCode"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_eventType_idx" ON "AuditLog"("eventType");

-- CreateIndex
CREATE INDEX "AuditLog_actorUserId_idx" ON "AuditLog"("actorUserId");

-- CreateIndex
CREATE INDEX "AuditLog_subjectType_subjectId_idx" ON "AuditLog"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "AdminMfaCredential" ADD CONSTRAINT "AdminMfaCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminMfaRecoveryCode" ADD CONSTRAINT "AdminMfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AuditLog is append-only: no API updates or deletes it, and the database
-- refuses to as well. (TRUNCATE by an operator is still possible.)
CREATE FUNCTION "audit_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog rows are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_append_only"();

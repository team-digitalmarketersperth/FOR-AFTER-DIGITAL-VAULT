-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'IP_BLOCK_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'IP_BLOCK_REVOKED';

-- CreateTable
CREATE TABLE "IpBlock" (
    "id" UUID NOT NULL,
    "ip" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,

    CONSTRAINT "IpBlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IpBlock_revokedAt_expiresAt_idx" ON "IpBlock"("revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "IpBlock_createdAt_idx" ON "IpBlock"("createdAt");

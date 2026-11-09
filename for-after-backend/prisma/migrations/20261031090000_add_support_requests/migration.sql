-- CreateEnum
CREATE TYPE "SupportCategory" AS ENUM ('ACCOUNT_ACCESS', 'MESSAGES_RECIPIENTS', 'UPLOADS_STORAGE', 'MY_STORY_WISHES', 'TECHNICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportAuthorRole" AS ENUM ('CUSTOMER', 'ADMIN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'SUPPORT_REQUEST_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'SUPPORT_REPLY_SENT';
ALTER TYPE "AuditEventType" ADD VALUE 'SUPPORT_NOTE_ADDED';
ALTER TYPE "AuditEventType" ADD VALUE 'SUPPORT_STATUS_CHANGED';

-- CreateTable
CREATE TABLE "SupportRequest" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "category" "SupportCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "SupportStatus" NOT NULL DEFAULT 'OPEN',
    "clientRequestId" UUID NOT NULL,
    "lastPublicActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" UUID NOT NULL,
    "supportRequestId" UUID NOT NULL,
    "authorRole" "SupportAuthorRole" NOT NULL,
    "authorUserId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "clientRequestId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportInternalNote" (
    "id" UUID NOT NULL,
    "supportRequestId" UUID NOT NULL,
    "authorUserId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "clientRequestId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportInternalNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupportRequest_ownerUserId_lastPublicActivityAt_idx" ON "SupportRequest"("ownerUserId", "lastPublicActivityAt");

-- CreateIndex
CREATE INDEX "SupportRequest_status_createdAt_idx" ON "SupportRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SupportRequest_createdAt_idx" ON "SupportRequest"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportRequest_ownerUserId_clientRequestId_key" ON "SupportRequest"("ownerUserId", "clientRequestId");

-- CreateIndex
CREATE INDEX "SupportMessage_supportRequestId_createdAt_idx" ON "SupportMessage"("supportRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportMessage_authorUserId_clientRequestId_key" ON "SupportMessage"("authorUserId", "clientRequestId");

-- CreateIndex
CREATE INDEX "SupportInternalNote_supportRequestId_createdAt_idx" ON "SupportInternalNote"("supportRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SupportInternalNote_authorUserId_clientRequestId_key" ON "SupportInternalNote"("authorUserId", "clientRequestId");

-- AddForeignKey
ALTER TABLE "SupportRequest" ADD CONSTRAINT "SupportRequest_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportInternalNote" ADD CONSTRAINT "SupportInternalNote_supportRequestId_fkey" FOREIGN KEY ("supportRequestId") REFERENCES "SupportRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;


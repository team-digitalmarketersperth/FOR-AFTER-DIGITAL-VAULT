-- Notification centre, Step 1: email announcement drafts (additive only).

-- AlterEnum
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_DRAFT_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'ANNOUNCEMENT_DRAFT_UPDATED';

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT');

-- CreateTable
CREATE TABLE "EmailAnnouncement" (
    "id" UUID NOT NULL,
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ctaLabel" TEXT,
    "ctaDestination" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdByUserId" UUID NOT NULL,
    "updatedByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailAnnouncement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailAnnouncement_updatedAt_id_idx" ON "EmailAnnouncement"("updatedAt", "id");

-- AddForeignKey
ALTER TABLE "EmailAnnouncement" ADD CONSTRAINT "EmailAnnouncement_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAnnouncement" ADD CONSTRAINT "EmailAnnouncement_updatedByUserId_fkey" FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

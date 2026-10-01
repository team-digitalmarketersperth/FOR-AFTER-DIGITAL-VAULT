-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('PHOTO', 'AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "MediaAssetStatus" AS ENUM ('PENDING_UPLOAD', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storageKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_ownerUserId_idx" ON "MediaAsset"("ownerUserId");

-- CreateIndex
CREATE INDEX "MediaAsset_messageId_status_idx" ON "MediaAsset"("messageId", "status");

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint (hand-written: Prisma schema cannot express CHECK)
-- VIDEO needs a streaming pipeline first; widen this on purpose when it exists.
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_kind_size_check" CHECK ("kind" IN ('PHOTO', 'AUDIO') AND "sizeBytes" > 0);

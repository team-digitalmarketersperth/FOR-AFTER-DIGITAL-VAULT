-- AlterTable
ALTER TABLE "MyWishResponse" ALTER COLUMN "textContent" DROP NOT NULL;

-- CreateTable
CREATE TABLE "MyWishMediaAsset" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "myWishResponseId" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storageKey" TEXT NOT NULL,
    "storageProvider" "MediaStorageProvider" NOT NULL DEFAULT 'IMAGEKIT',
    "providerFileId" TEXT,
    "storageDeletedAt" TIMESTAMP(3),
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MyWishMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MyWishMediaAsset_storageKey_key" ON "MyWishMediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MyWishMediaAsset_ownerUserId_idx" ON "MyWishMediaAsset"("ownerUserId");

-- CreateIndex
CREATE INDEX "MyWishMediaAsset_myWishResponseId_status_idx" ON "MyWishMediaAsset"("myWishResponseId", "status");

-- AddForeignKey
ALTER TABLE "MyWishMediaAsset" ADD CONSTRAINT "MyWishMediaAsset_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MyWishMediaAsset" ADD CONSTRAINT "MyWishMediaAsset_myWishResponseId_fkey" FOREIGN KEY ("myWishResponseId") REFERENCES "MyWishResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express CHECK), like MyStoryMediaAsset:
-- My Wishes takes photos, audio and video.
ALTER TABLE "MyWishMediaAsset" ADD CONSTRAINT "MyWishMediaAsset_kind_size_check" CHECK ("kind" IN ('PHOTO', 'AUDIO', 'VIDEO') AND "sizeBytes" > 0);

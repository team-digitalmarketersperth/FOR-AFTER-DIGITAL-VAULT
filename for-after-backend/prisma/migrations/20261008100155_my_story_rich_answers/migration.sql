-- AlterTable
ALTER TABLE "MyStoryResponse" ALTER COLUMN "textContent" DROP NOT NULL;

-- CreateTable
CREATE TABLE "MyStoryMediaAsset" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "myStoryResponseId" UUID NOT NULL,
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

    CONSTRAINT "MyStoryMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MyStoryMemoryLink" (
    "myStoryResponseId" UUID NOT NULL,
    "memoryVaultItemId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MyStoryMemoryLink_pkey" PRIMARY KEY ("myStoryResponseId","memoryVaultItemId")
);

-- CreateIndex
CREATE UNIQUE INDEX "MyStoryMediaAsset_storageKey_key" ON "MyStoryMediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MyStoryMediaAsset_ownerUserId_idx" ON "MyStoryMediaAsset"("ownerUserId");

-- CreateIndex
CREATE INDEX "MyStoryMediaAsset_myStoryResponseId_status_idx" ON "MyStoryMediaAsset"("myStoryResponseId", "status");

-- CreateIndex
CREATE INDEX "MyStoryMemoryLink_memoryVaultItemId_idx" ON "MyStoryMemoryLink"("memoryVaultItemId");

-- AddForeignKey
ALTER TABLE "MyStoryMediaAsset" ADD CONSTRAINT "MyStoryMediaAsset_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MyStoryMediaAsset" ADD CONSTRAINT "MyStoryMediaAsset_myStoryResponseId_fkey" FOREIGN KEY ("myStoryResponseId") REFERENCES "MyStoryResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MyStoryMemoryLink" ADD CONSTRAINT "MyStoryMemoryLink_myStoryResponseId_fkey" FOREIGN KEY ("myStoryResponseId") REFERENCES "MyStoryResponse"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MyStoryMemoryLink" ADD CONSTRAINT "MyStoryMemoryLink_memoryVaultItemId_fkey" FOREIGN KEY ("memoryVaultItemId") REFERENCES "MemoryVaultItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Hand-written (Prisma cannot express CHECK), like MediaAsset and
-- MemoryVaultMediaAsset: My Story takes photos, audio and video.
ALTER TABLE "MyStoryMediaAsset" ADD CONSTRAINT "MyStoryMediaAsset_kind_size_check" CHECK ("kind" IN ('PHOTO', 'AUDIO', 'VIDEO') AND "sizeBytes" > 0);

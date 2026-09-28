-- CreateEnum
CREATE TYPE "MemoryVaultCategory" AS ENUM ('FAMILY', 'TRAVEL', 'CHILDHOOD', 'FUNNY_STORIES', 'LIFE_LESSONS', 'RECIPES', 'LOVE_STORIES', 'OTHER');

-- CreateTable
CREATE TABLE "MemoryVaultItem" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "category" "MemoryVaultCategory" NOT NULL,
    "textContent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryVaultItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryVaultMediaAsset" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "memoryVaultItemId" UUID NOT NULL,
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

    CONSTRAINT "MemoryVaultMediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MemoryVaultItem_ownerUserId_idx" ON "MemoryVaultItem"("ownerUserId");

-- CreateIndex
CREATE INDEX "MemoryVaultItem_ownerUserId_category_idx" ON "MemoryVaultItem"("ownerUserId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryVaultMediaAsset_storageKey_key" ON "MemoryVaultMediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MemoryVaultMediaAsset_ownerUserId_idx" ON "MemoryVaultMediaAsset"("ownerUserId");

-- CreateIndex
CREATE INDEX "MemoryVaultMediaAsset_memoryVaultItemId_status_idx" ON "MemoryVaultMediaAsset"("memoryVaultItemId", "status");

-- AddForeignKey
ALTER TABLE "MemoryVaultItem" ADD CONSTRAINT "MemoryVaultItem_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryVaultMediaAsset" ADD CONSTRAINT "MemoryVaultMediaAsset_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryVaultMediaAsset" ADD CONSTRAINT "MemoryVaultMediaAsset_memoryVaultItemId_fkey" FOREIGN KEY ("memoryVaultItemId") REFERENCES "MemoryVaultItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddCheckConstraint (hand-written: Prisma schema cannot express CHECK)
-- Same rule as MediaAsset: VIDEO needs a streaming pipeline first.
ALTER TABLE "MemoryVaultMediaAsset" ADD CONSTRAINT "MemoryVaultMediaAsset_kind_size_check" CHECK ("kind" IN ('PHOTO', 'AUDIO') AND "sizeBytes" > 0);

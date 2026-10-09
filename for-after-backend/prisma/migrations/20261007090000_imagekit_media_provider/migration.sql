-- Phase 12: ImageKit becomes the media provider; VIDEO message media.
-- Additive only. Every existing row was uploaded to Backblaze B2, so the new
-- column is added with DEFAULT 'B2' (filling existing rows) and only then
-- switched to 'IMAGEKIT' for new rows. No row, key or object is changed.

-- CreateEnum
CREATE TYPE "MediaStorageProvider" AS ENUM ('B2', 'IMAGEKIT');

-- AlterTable
ALTER TABLE "MediaAsset"
  ADD COLUMN "storageProvider" "MediaStorageProvider" NOT NULL DEFAULT 'B2',
  ADD COLUMN "providerFileId" TEXT,
  ADD COLUMN "storageDeletedAt" TIMESTAMP(3);
ALTER TABLE "MediaAsset" ALTER COLUMN "storageProvider" SET DEFAULT 'IMAGEKIT';

ALTER TABLE "MemoryVaultMediaAsset"
  ADD COLUMN "storageProvider" "MediaStorageProvider" NOT NULL DEFAULT 'B2',
  ADD COLUMN "providerFileId" TEXT,
  ADD COLUMN "storageDeletedAt" TIMESTAMP(3);
ALTER TABLE "MemoryVaultMediaAsset" ALTER COLUMN "storageProvider" SET DEFAULT 'IMAGEKIT';

ALTER TABLE "RecipientPhoto"
  ADD COLUMN "storageProvider" "MediaStorageProvider" NOT NULL DEFAULT 'B2',
  ADD COLUMN "providerFileId" TEXT,
  ADD COLUMN "storageDeletedAt" TIMESTAMP(3);
ALTER TABLE "RecipientPhoto" ALTER COLUMN "storageProvider" SET DEFAULT 'IMAGEKIT';

-- Message media may now be VIDEO (hand-written: Prisma cannot express CHECK).
-- Memory Vault media stays PHOTO/AUDIO.
ALTER TABLE "MediaAsset" DROP CONSTRAINT "MediaAsset_kind_size_check";
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_kind_size_check" CHECK ("kind" IN ('PHOTO', 'AUDIO', 'VIDEO') AND "sizeBytes" > 0);

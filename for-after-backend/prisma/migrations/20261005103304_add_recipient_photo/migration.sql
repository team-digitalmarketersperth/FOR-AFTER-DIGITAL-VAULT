-- CreateTable
CREATE TABLE "RecipientPhoto" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL DEFAULT 'PHOTO',
    "status" "MediaAssetStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "storageKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "uploadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "RecipientPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RecipientPhoto_storageKey_key" ON "RecipientPhoto"("storageKey");

-- CreateIndex
CREATE INDEX "RecipientPhoto_ownerUserId_idx" ON "RecipientPhoto"("ownerUserId");

-- CreateIndex
CREATE INDEX "RecipientPhoto_recipientId_status_idx" ON "RecipientPhoto"("recipientId", "status");

-- AddForeignKey
ALTER TABLE "RecipientPhoto" ADD CONSTRAINT "RecipientPhoto_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientPhoto" ADD CONSTRAINT "RecipientPhoto_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one current photo per Recipient: one READY, non-deleted row. Not
-- expressible in schema.prisma; completion also locks the Recipient row.
CREATE UNIQUE INDEX "RecipientPhoto_one_current_per_recipient"
  ON "RecipientPhoto" ("recipientId")
  WHERE "status" = 'READY' AND "deletedAt" IS NULL;

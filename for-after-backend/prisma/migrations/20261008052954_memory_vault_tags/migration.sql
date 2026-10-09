-- CreateTable
CREATE TABLE "MemoryVaultTag" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryVaultTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryVaultItemTag" (
    "memoryVaultItemId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "MemoryVaultItemTag_pkey" PRIMARY KEY ("memoryVaultItemId","tagId")
);

-- CreateIndex
CREATE UNIQUE INDEX "MemoryVaultTag_ownerUserId_normalizedName_key" ON "MemoryVaultTag"("ownerUserId", "normalizedName");

-- CreateIndex
CREATE INDEX "MemoryVaultItemTag_tagId_idx" ON "MemoryVaultItemTag"("tagId");

-- AddForeignKey
ALTER TABLE "MemoryVaultTag" ADD CONSTRAINT "MemoryVaultTag_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryVaultItemTag" ADD CONSTRAINT "MemoryVaultItemTag_memoryVaultItemId_fkey" FOREIGN KEY ("memoryVaultItemId") REFERENCES "MemoryVaultItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryVaultItemTag" ADD CONSTRAINT "MemoryVaultItemTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "MemoryVaultTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

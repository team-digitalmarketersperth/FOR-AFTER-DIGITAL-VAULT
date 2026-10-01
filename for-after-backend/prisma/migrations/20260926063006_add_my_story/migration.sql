-- CreateTable
CREATE TABLE "MyStoryResponse" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "promptKey" TEXT NOT NULL,
    "promptTextSnapshot" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "textContent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MyStoryResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MyStoryResponse_ownerUserId_promptKey_key" ON "MyStoryResponse"("ownerUserId", "promptKey");

-- AddForeignKey
ALTER TABLE "MyStoryResponse" ADD CONSTRAINT "MyStoryResponse_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

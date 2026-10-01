-- CreateTable
CREATE TABLE "MyWishResponse" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "promptKey" TEXT NOT NULL,
    "promptTextSnapshot" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "textContent" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MyWishResponse_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MyWishResponse_ownerUserId_promptKey_key" ON "MyWishResponse"("ownerUserId", "promptKey");

-- AddForeignKey
ALTER TABLE "MyWishResponse" ADD CONSTRAINT "MyWishResponse_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

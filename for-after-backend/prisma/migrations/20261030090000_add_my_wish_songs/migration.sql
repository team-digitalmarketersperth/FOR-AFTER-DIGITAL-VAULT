-- CreateEnum
CREATE TYPE "MyWishSongMoment" AS ENUM ('ARRIVAL', 'REFLECTION', 'FAREWELL', 'OTHER');

-- CreateTable
CREATE TABLE "MyWishSong" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "link" TEXT,
    "moment" "MyWishSongMoment",
    "momentOther" TEXT,
    "note" TEXT,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MyWishSong_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MyWishSong_ownerUserId_position_idx" ON "MyWishSong"("ownerUserId", "position");

-- AddForeignKey
ALTER TABLE "MyWishSong" ADD CONSTRAINT "MyWishSong_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

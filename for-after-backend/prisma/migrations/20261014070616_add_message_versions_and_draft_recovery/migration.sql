-- CreateEnum
CREATE TYPE "MessageVersionReason" AS ENUM ('CREATED', 'EDITED', 'RESTORED');

-- CreateEnum
CREATE TYPE "DraftRecoveryType" AS ENUM ('MESSAGE', 'NEW_MESSAGE', 'MY_STORY', 'MY_WISHES');

-- AlterEnum
ALTER TYPE "CustomerActivityType" ADD VALUE 'MESSAGE_VERSION_RESTORED';

-- CreateTable
CREATE TABLE "MessageVersion" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "reason" "MessageVersionReason" NOT NULL,
    "title" TEXT NOT NULL,
    "contentType" "MessageContentType" NOT NULL,
    "textContent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftRecovery" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" "DraftRecoveryType" NOT NULL,
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "baseRevision" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DraftRecovery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageVersion_messageId_version_key" ON "MessageVersion"("messageId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DraftRecovery_userId_type_key_key" ON "DraftRecovery"("userId", "type", "key");

-- AddForeignKey
ALTER TABLE "MessageVersion" ADD CONSTRAINT "MessageVersion_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DraftRecovery" ADD CONSTRAINT "DraftRecovery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

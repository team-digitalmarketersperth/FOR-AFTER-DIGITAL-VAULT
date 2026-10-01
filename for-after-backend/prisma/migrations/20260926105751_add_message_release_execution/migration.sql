-- CreateTable
CREATE TABLE "MessageRelease" (
    "id" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "triggerType" "ReleaseTriggerType" NOT NULL,
    "scheduledFor" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageRelease_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MessageRelease_messageId_key" ON "MessageRelease"("messageId");

-- AddForeignKey
ALTER TABLE "MessageRelease" ADD CONSTRAINT "MessageRelease_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

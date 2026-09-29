-- CreateTable
CREATE TABLE "RecipientMessageAccessGrant" (
    "id" UUID NOT NULL,
    "messageReleaseId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "recipientEmailNormalized" TEXT,
    "recipientMobileNormalized" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecipientMessageAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecipientMessageAccessGrant_messageId_idx" ON "RecipientMessageAccessGrant"("messageId");

-- CreateIndex
CREATE INDEX "RecipientMessageAccessGrant_recipientId_idx" ON "RecipientMessageAccessGrant"("recipientId");

-- CreateIndex
CREATE INDEX "RecipientMessageAccessGrant_recipientEmailNormalized_idx" ON "RecipientMessageAccessGrant"("recipientEmailNormalized");

-- CreateIndex
CREATE INDEX "RecipientMessageAccessGrant_recipientMobileNormalized_idx" ON "RecipientMessageAccessGrant"("recipientMobileNormalized");

-- CreateIndex
CREATE UNIQUE INDEX "RecipientMessageAccessGrant_messageReleaseId_recipientId_key" ON "RecipientMessageAccessGrant"("messageReleaseId", "recipientId");

-- AddForeignKey
ALTER TABLE "RecipientMessageAccessGrant" ADD CONSTRAINT "RecipientMessageAccessGrant_messageReleaseId_fkey" FOREIGN KEY ("messageReleaseId") REFERENCES "MessageRelease"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientMessageAccessGrant" ADD CONSTRAINT "RecipientMessageAccessGrant_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecipientMessageAccessGrant" ADD CONSTRAINT "RecipientMessageAccessGrant_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

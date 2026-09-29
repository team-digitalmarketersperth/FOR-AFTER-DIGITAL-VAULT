-- DropForeignKey
ALTER TABLE "RecipientMessageAccessGrant" DROP CONSTRAINT "RecipientMessageAccessGrant_recipientId_fkey";

-- AddForeignKey
ALTER TABLE "RecipientMessageAccessGrant" ADD CONSTRAINT "RecipientMessageAccessGrant_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "DeathReport" DROP CONSTRAINT "DeathReport_reportedByTrustedContactId_fkey";

-- AddForeignKey
ALTER TABLE "DeathReport" ADD CONSTRAINT "DeathReport_reportedByTrustedContactId_fkey" FOREIGN KEY ("reportedByTrustedContactId") REFERENCES "TrustedContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

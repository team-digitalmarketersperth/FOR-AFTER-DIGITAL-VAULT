-- Phase 19B: distinct Trusted Contact confirmations admin verify requires,
-- snapshotted when a case opens. Additive: one nullable column + a CHECK.

-- AlterTable
ALTER TABLE "DeathVerificationCase" ADD COLUMN     "requiredConfirmations" INTEGER;

-- The product limit is two Trusted Contacts: never 0, negative or more than 2.
ALTER TABLE "DeathVerificationCase" ADD CONSTRAINT "DeathVerificationCase_requiredConfirmations_check"
  CHECK ("requiredConfirmations" IS NULL OR "requiredConfirmations" IN (1, 2));

-- Approved backfill (2026-10-13), OPEN cases only: the distinct emails of the
-- Trusted Contacts that existed when the case opened (created before it and
-- not removed before it), plus the first reporter's snapshot email (the
-- reporter always counts), capped at 2. Uses stored rows and timestamps only.
-- Closed cases (VERIFIED/REJECTED/CANCELLED) stay NULL: they are never
-- verified again. A NULL open case is refused by verify; it never means 1.
UPDATE "DeathVerificationCase" c
-- NULLIF: an open case the reconstruction cannot size (no email at all) stays
-- NULL rather than guessed; the CHECK above would reject a 0.
SET "requiredConfirmations" = NULLIF(LEAST(2, (
  SELECT count(DISTINCT e.email)
  FROM (
    SELECT t.email
    FROM "TrustedContact" t
    WHERE t."ownerUserId" = c."ownerUserId"
      AND t.email IS NOT NULL
      AND t."createdAt" <= c."openedAt"
      AND (t."deletedAt" IS NULL OR t."deletedAt" > c."openedAt")
    UNION
    SELECT first_report."reporterEmailNormalized"
    FROM (
      SELECT r."reporterEmailNormalized"
      FROM "DeathReport" r
      WHERE r."deathVerificationCaseId" = c.id
      ORDER BY r."createdAt" ASC, r.id ASC
      LIMIT 1
    ) first_report
    WHERE first_report."reporterEmailNormalized" IS NOT NULL
  ) e
)), 0)
WHERE c.status IN ('PENDING_VERIFICATION', 'SAFEGUARD_ACTIVE', 'READY_FOR_REVIEW');


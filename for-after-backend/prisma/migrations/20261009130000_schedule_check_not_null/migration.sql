-- Hand-written. A CHECK passes when it evaluates to NULL, so "BETWEEN" and
-- length() on a NULL column let incomplete ANNIVERSARY / CUSTOM_EVENT rows
-- through. Same rules as before, with explicit IS NOT NULL.
ALTER TABLE "MessageSchedule" DROP CONSTRAINT "MessageSchedule_trigger_fields_check";
ALTER TABLE "MessageSchedule" ADD CONSTRAINT "MessageSchedule_trigger_fields_check" CHECK (
    ("triggerType" = 'FIXED_DATE' AND "scheduledFor" IS NOT NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NULL AND "localTime" IS NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" IN ('NOW', 'ON_DEATH') AND "scheduledFor" IS NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NULL AND "localTime" IS NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" = 'AFTER_DEATH' AND "scheduledFor" IS NULL
        AND "afterDeathDays" IS NOT NULL AND "afterDeathDays" >= 0
        AND "timezone" IS NULL AND "localTime" IS NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" IN ('BIRTHDAY', 'ANNUAL_AFTER_DEATH') AND "scheduledFor" IS NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NOT NULL AND "localTime" IS NOT NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" = 'ANNIVERSARY' AND "scheduledFor" IS NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NOT NULL AND "localTime" IS NOT NULL
        AND "annualMonth" IS NOT NULL AND "annualMonth" BETWEEN 1 AND 12
        AND "annualDay" IS NOT NULL AND "annualDay" BETWEEN 1 AND 31
        AND "eventDate" IS NULL AND "eventLabel" IS NULL)
    OR ("triggerType" = 'CUSTOM_EVENT' AND "scheduledFor" IS NOT NULL AND "afterDeathDays" IS NULL
        AND "timezone" IS NOT NULL AND "localTime" IS NOT NULL AND "annualMonth" IS NULL AND "annualDay" IS NULL
        AND "eventDate" IS NOT NULL
        AND "eventLabel" IS NOT NULL AND length("eventLabel") BETWEEN 1 AND 100)
);

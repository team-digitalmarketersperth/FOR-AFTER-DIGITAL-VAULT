# Updated Plans Step 5: durable AI usage allowances (2026-11-17)

**Status: complete (local).** Tiers and usage are synthetic in every test (set directly on `BillingAccount.tier` and
`AiUsage` rows). Nothing assigns a tier from Stripe yet, so no real account is metered by tier.

Nothing was staged, committed, pushed or deployed. No environment settings, customer data, Stripe objects or live
providers were touched; the AI provider was faked in every test and browser run. Evidence:
[`evidence/updated-plans-step-5/`](evidence/updated-plans-step-5/). Policy, counting rules, lifecycle and API:
[`billing.md`](billing.md) §9 Step 5 (not repeated here).

## What changed

**Backend**
- `prisma/schema.prisma` + migration `20261117090000_add_ai_usage`: `AiUsage`, enum `AiUsageStatus`
  (`RESERVED` / `USED` / `RELEASED`), unique `(userId, requestId)`. Metadata only.
- `src/billing/billing-access.ts`: `aiMeter()` picks the bucket (`trial:<id>` or `month:YYYY-MM`) and the allowance
  from `PLAN_DEFINITIONS.*.aiRequests`. It returns "not metered" for billing-off, grandfathered and unmapped paid
  accounts, and for accounts without access.
- `src/assistant/ai-usage.service.ts` (new): reserve under the User row lock, conditional settle, idempotent release,
  expiry-based recovery, and `GET /assistant/usage`.
- `src/assistant/assistant.service.ts`:
  - order of checks: hourly limit, then the request-id claim, then the reservation, then the in-flight cap;
  - settle on a complete reply;
  - release on a failed, empty, cancelled or truncated reply;
  - `503 AI_USAGE_UNRECORDED` when the provider succeeded but settling failed;
  - `GUIDE` facts updated.
- `src/assistant/assistant.module.ts`: optional `requestId` (UUID) on `POST /assistant/reply`; `GET /assistant/usage`.
- `src/assistant/assistant-metrics.ts`: outcomes `allowance_exhausted`, `duplicate_request` and `usage_unrecorded`.

**Frontend:** companion usage line, exhaustion message, fresh `requestId` per Send, typed text kept on failure. See
`for-after-frontend/docs/tasks.md` (Updated plans Step 5).

## Tests

`test/ai-allowance.e2e-spec.ts` (new, 12 tests):
- trial 5 / 6;
- Premium 50 / 51 (annual billing, monthly allowance);
- Complete 200 / 201;
- failed, empty and truncated replies;
- concurrency with one slot left;
- reused ids and cross-account ids;
- tier changes in both directions;
- trial → paid;
- unmapped and expired accounts;
- abandoned reservations and a late settle;
- the exact UTC month boundary;
- metadata-only rows.

Unit tests in `assistant.service.spec.ts` cover:
- settlement failure after provider success (no release, no second call);
- cancellation;
- a complete reply settling exactly once;
- the hourly 429 versus the allowance 409.

## Results (fresh, after the final code change)

| Check | Result |
|---|---|
| Backend `tsc --noEmit` | exit 0 |
| Backend oxlint (type-aware) | exit 0 |
| Backend unit | 77 files, 1645/1645 |
| Isolated e2e, one combined run (13 files) | 162/162, exit 0, 0 skipped, 0 worker-start failures |
| Frontend vitest (companion, admin, shared, lib) | 30 files, 365/365 |
| Frontend eslint (changed files) + source typecheck | clean |
| Isolated production build (`D:\for-after-p7-buildcheck`) | exit 0, 62/62 pages |
| Isolated browser (1280 and 390 px) | 7/7 |

The 13 e2e files were `ai-allowance`, `assistant`, `admin`, `plan-tiers`, `plan-limits`, `plan-media`, `billing`,
`trial-expired`, `trial-step7`, `trial-people`, `trial-questions`, `trial-media` and `trial-storage`.

**Assertion failures:** none. **Infrastructure:** the browser run was first blocked because Docker Desktop and the
isolated Redis (:6390) had stopped. They were restarted, the Redis marker was set again with `isolated-env.mjs setup`
(isolated DB only, "No pending migrations"), and the run then passed. The `ExceptionsHandler` line in the e2e log is
an expected error from a `billing.e2e` test, not a failure.

**Browser checks (7):**
- desktop: trial "3 of 5" becomes "4 of 5" after a reply;
- phone: the trial layout fits;
- Premium exhausted, desktop and phone: its own message with the reset date, no Try again, typed text kept;
- Premium exhausted, desktop and phone: manual editing still works;
- phone: unmapped paid shows no usage line and no "unlimited", and a reply arrives.

The synthetic rows were removed afterwards (3 users).

**Not run:** real provider calls (out of scope); Stripe-driven tiers (Step 5 has no Stripe mapping).

## Development migrations

`npx prisma migrate status` against the development database (`for_after`, read only) reports **up to date: 50
migrations, none pending**. `_prisma_migrations` shows `20261116120000_add_billing_paid_tier` and
`20261117090000_add_ai_usage` applied on 2026-11-16 (13:46 and 16:17 IST). No Claude session ran a migration against
the development database, so they were applied outside these sessions. For any other environment the command is
`npx prisma migrate deploy` from `for-after-backend/`; it applies **every** pending migration, not only this one.

## Docs updated

- `billing.md` §9 Step 5, plus its verification block. "AI period anchor" and "which AI actions count / truncated"
  were removed from Pending decisions, because Step 5 decided them.
- `assistant.md`: allowance errors and `GET /assistant/usage`.
- `docs/task.md` (backend tracker, 2026-11-17 row).
- `for-after-frontend/docs/tasks.md` (Updated plans Step 5 section).

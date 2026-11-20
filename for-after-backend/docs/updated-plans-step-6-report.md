# Updated Plans Step 6: Stripe tier mapping and Checkout (2026-11-17, with close-out)

| Part | Status |
|---|---|
| Implementation | **Complete** (local) |
| Local verification (fake Stripe adapter, isolated DB/Redis, isolated build, browser) | **Complete**; backend typecheck clean again after the Prisma dependency correction (below) |
| Real sandbox verification (hosted Checkout → signed webhook → entitlement → UI) | **Blocked**: no sandbox prices, no app credentials, Stripe CLI not logged in |
| Business decisions | **Open**; see the end |

**None of the evidence below is payment evidence.**
- Every Stripe interaction was a fake adapter.
- The browser run's "Checkout" returned straight to the app's success URL, with no Stripe page, payment or webhook.

**Boundaries kept:**
- Nothing was staged, committed, pushed or deployed.
- No live-mode Stripe operations were made, and no Stripe objects were created or changed. The sandbox was read only:
  products and prices were listed.
- No environment settings were changed. No customer data was changed, and nothing was backfilled.

Policy and rules: [`billing.md`](billing.md) §9 Step 6. Evidence: [`evidence/updated-plans-step-6/`](evidence/updated-plans-step-6/).

## What changed

**Backend**
- `src/billing/stripe-prices.ts` (new):
  - `PriceCatalog`: the four tier settings plus the two legacy ones; validated at start-up (duplicates and malformed
    ids fail); price → tier/interval; resolving a subscription's items (mapped / legacy / unknown / ambiguous).
  - `priceProblem()`: the Checkout price checks.
- `src/billing/billing.service.ts`:
  - Checkout by `{ tier, interval }`, with a Stripe price check;
  - sync stores `tier`, `plan` and `priceUnresolved`;
  - diagnostics and audit metadata;
  - `GET /billing` adds `checkoutOptions` and `subscription.mapping`;
  - admin items carry `tier` and `priceUnresolved`.
- `src/billing/billing-access.ts`: access state `plan_unresolved`, kept in step across the resolver, its SQL, the
  admin filter, `ADMIN_BILLING_FILTERS` and the 402 code `PLAN_UNRESOLVED`.
- `src/billing/billing-access.interceptor.ts` (close-out): a `plan_unresolved` 402 now says "We couldn't match your
  subscription to a plan yet, so creating and editing are paused. Please contact support." It never says "choose a
  plan". Every other state keeps the existing message.
- `src/billing/stripe-gateway.ts`: `retrievePrice` (Checkout only). `src/billing/billing.dto.ts`: `CheckoutDto`.
- `prisma/schema.prisma` + migration `20261117120000_add_billing_price_unresolved`.
- `.env.example`: the new settings.

**Frontend:**
- Plan page: tier rows, intervals on sale, "not available yet", the tier name for a mapped subscription, the
  unresolved note.
- Labels and admin filters.
- Close-out: an unresolved account is sent to **Contact support**, never "View plans" or "Choose a plan", in three
  places:
  - the lock dialogs (`PLAN_LOCK_COPY.plan_unresolved.action`, used by `ProDialog` and `UpgradeDialog`);
  - a refused save (`FormError` on code `PLAN_UNRESOLVED`);
  - the plan page (the generic "Choose a plan to keep adding…" note is hidden for this state).

**Tests:**
- `test/stripe-tiers.e2e-spec.ts` (new, 12 tests).
- Updated: `billing.e2e-spec.ts` (new Checkout body; unresolved rows in the every-combination check),
  `trial-expired.e2e-spec.ts` (Checkout body) and `admin-onboarding.e2e-spec.ts` (pins billing off).
- `src/billing/stripe-prices.spec.ts` (new).
- Frontend: `plan.test.tsx` (updated, plus 2 tests) and `plan-unresolved.test.tsx` (new, 3 tests).

## Unresolved-price handling (close-out verification)

Interim policy (as instructed):
- A new unknown or ambiguous subscription never grants Premium or Complete.
- Existing legacy or unmapped subscriptions keep their compatibility.
- A previously mapped subscription that meets an unknown price is flagged unresolved, and no tier is guessed.

| Requirement | Evidence (`stripe-tiers.e2e-spec.ts` unless noted) |
|---|---|
| New unknown price grants nothing | "unknown price on a new subscription…": `plan_unresolved`, `hasAccess` false, tier null, 402 `PLAN_UNRESOLVED`, second Checkout 409 |
| Several items, or a quantity other than 1 | "several items or another quantity…": unresolved; the stored COMPLETE is kept, not in force |
| Held legacy/unmapped subscription keeps access | "the unmapped subscription an account already held…": `paid_active`, writes 201; its replacement on an unknown price is unresolved |
| Legacy price | "a legacy price keeps the existing unmapped behaviour": interval only, configured storage, AI not metered |
| **A retained COMPLETE tier cannot bypass PLAN_UNRESOLVED** | "close-out: a retained COMPLETE tier…" (below) |
| Reads, delete, billing, support, account and sign-out stay open | the same test, and the next one (sign-out) |
| **Transient failure is not stored as unknown** | "close-out: a transient Stripe failure…" (below) |
| **Recovery** | same test, and the unknown-price test |
| UI explains the state and offers support, never "buy again" | `plan-unresolved.test.tsx` (3), `plan.test.tsx`, browser checks 8–10 |

"A retained COMPLETE tier cannot bypass PLAN_UNRESOLVED" covers:
- storage limit = the configured default (not 5 GB);
- AI `no_access`;
- recipient create, recipient photo upload, message media upload (VIDEO), assistant reply and recipient edit: all 402
  `PLAN_UNRESOLVED`, with the new message;
- nothing created.

It holds because every content-write controller carries `@RequiresPlan()`, and the gate runs before validation or any
tier check. `entitledPaidTier` is null outside paid states.

The rest of that test checks what stays open:
- `GET /recipients` and `GET /users/me/storage` (200);
- the billing portal (200);
- a new support request (201);
- `PATCH /users/me` (200);
- `DELETE /recipients/:id`.

"A transient Stripe failure is not stored as unknown" covers:
- A failed subscription list → 500; the event isn't recorded and the row is unchanged (Stripe retries).
- A mapped account during an outage (a list failure, then a failed direct read) → 500 twice. Its tier, plan, flag and
  `syncedAt` are untouched.
- An answer Stripe did return with a malformed item (no price) *is* stored as unresolved. Only received data is ever
  treated as proof.

"Recovery": the retried event with a configured price clears `priceUnresolved`. Complete is back in force:
`paid_active`, 5 GB, AI 200, writes 201, `mapping: mapped`.

GET /billing for an unresolved account still reports `features.mediaKinds` as all kinds. That is existing behaviour
for every account without access (a tier only narrows kinds while it is in force). It grants nothing: every write is
402 at the gate, and the UI locks on `hasAccess`.

## Results (final runs, after the last code change)

| Check | Result | Evidence |
|---|---|---|
| Isolated e2e, one combined run of all 15 files | **181/181 passed**, exit 0, 0 skipped, 0 worker-start failures | `e2e-combined.log`; per-file counts from `e2e-list.json` |
| Backend unit | **78 files, 1651/1651** | `backend-unit.log` |
| Backend oxlint (type-aware, `src/` + `test/`) | exit 0; 5 warnings, all in `ip-blocks` files this step didn't touch | `backend-oxlint.log` |
| Backend `tsc --noEmit` | exit 2 at the time: 1 error, in `prisma.config.ts` only (the Prisma 8 RC CLI). **Resolved: exit 0 after the correction below.** | `backend-tsc.log`, `backend-tsc-after-prisma-fix.log` |
| Frontend vitest (account, admin, shared, layout, lib, hooks) | **36 files, 440/440**, 0 worker-start failures | `frontend-vitest.log` |
| Frontend eslint (13 changed files) / source typecheck | exit 0 / exit 0 | — |
| Isolated production build (`D:\for-after-p7-buildcheck`) | exit 0; compiled; TypeScript passed; 62/62 pages | `next-build.log` |
| Isolated browser, 1280 and 390 px | **10/10** | `browser-run.jsonl` |

Per-file e2e counts:

| File | Tests | File | Tests | File | Tests |
|---|---|---|---|---|---|
| `admin` | 37 | `billing` | 15 | `plan-media` | 13 |
| `stripe-tiers` | 12 | `ai-allowance` | 12 | `trial-questions` | 12 |
| `trial-step7` | 12 | `assistant` | 11 | `trial-media` | 11 |
| `plan-limits` | 10 | `trial-people` | 9 | `trial-expired` | 8 |
| `admin-onboarding` | 7 | `trial-storage` | 7 | `plan-tiers` | 5 |

The table above is the **previous** close-out run (11:42–11:59 IST). Its `tsc` failure is resolved below. The fresh
results after the dependency correction are in the next section.

## Prisma dependency correction (2026-11-17)

**Diagnosis:**
- **At HEAD:** `prisma` (CLI) `^7.10.0`, `@prisma/client` `^7.10.0`, `@prisma/adapter-pg` `^7.10.0`. The lockfile
  resolved all three to 7.10.0.
- **Working tree before the fix:**
  - `package.json`: `prisma` `^8.0.0-rc.34` (the client and adapter were still `^7.10.0`). The only other
    `package.json` change was the unrelated `storage:reconcile-report` script, which is kept.
  - `package-lock.json`: 151 packages added, 98 removed and 23 changed. All follow from that one root change: the
    Prisma 8 RC toolchain came in (`@prisma/orm-toolchain`, `@prisma/composer`, `effect` 4, a newer `rolldown`, and
    so on), and the Prisma 7 CLI's engines, config and Studio packages went out. No other root dependency differed
    from HEAD.
  - `node_modules`: `prisma` 8.0.0-rc.34, installed 11:32 IST; the manifests were written 11:37 IST.
- **Requirement:** none identifiable.
  - No documentation, config or commit mentions Prisma 8.
  - None of the Claude sessions for this project ran the install.
  - The npm debug logs kept for that day start at 06:08 UTC (11:38 IST), after the change.
  - Prisma's own CLI banner had been suggesting `npm i --save-dev prisma@latest`. That may be the origin, but this
    is not confirmed.
- **The breakage:** a Prisma 8 CLI next to a 7.10 client and adapter is not a supported pair. Prisma 8's
  `prisma/config` has no `defineConfig`, so `prisma.config.ts` failed `tsc` with 1 error.

**Correction:** the smallest change that restores the project's Prisma 7 setup.
- `package.json`: `"prisma": "^8.0.0-rc.34"` → `"^7.10.0"` (that line only).
- `package-lock.json`: restored to HEAD's lockfile. With the root dependencies identical to HEAD again, it is the
  matching lock, and `npm install` left it unchanged (verified: identical to HEAD).
- `npm install --no-audit --no-fund` synced `node_modules`: `prisma`, `@prisma/client`, `@prisma/adapter-pg`,
  `@prisma/engines` and `@prisma/config` are all 7.10.0, and the schema engine binary is present.
- npm 11.20 skipped install scripts not covered by `allowScripts`, including `@prisma/engines` postinstall and the
  argon2 rebuild. Nothing was missing as a result: the engine binary and the argon2 prebuilds are in place.
- The RC versions of both files are saved, if needed, at
  `C:\Users\DELL\AppData\Local\Temp\claude\49e87fd4d08ed1b2\e026b915-7443-4a87-be68-074106ee98f6\scratchpad\prisma8-rc-backup\`
  (scratchpad, not durable).
- No schema change and no migration. The database wasn't touched.

**Verification after the correction (fresh):**

| Check | Result | Evidence |
|---|---|---|
| `npx prisma generate` (the repo's usual command) | Prisma Client 7.10.0. The generated output is **byte-identical** to before (same tree hash), so no runtime code changed. | — |
| `npx prisma validate` | schema valid | — |
| Backend `tsc --noEmit -p tsconfig.json` (the full project, `prisma.config.ts` included, nothing excluded) | **exit 0, 0 errors** | `backend-tsc-after-prisma-fix.log` |
| Backend oxlint (type-aware, `src/` + `test/` + `prisma.config.ts`) | exit 0; the same 5 `ip-blocks` warnings as before | `backend-oxlint-after-prisma-fix.log` |
| Backend unit | **78 files, 1651/1651** | `backend-unit-after-prisma-fix.log` |
| Isolated e2e, combined (15 files), first run after the correction | 180/181: **1 assertion failure**, not Prisma-related (below) | `e2e-combined-after-prisma-fix.log` |
| Isolated e2e, combined (15 files), after the test fix (the final run) | **181/181**, exit 0, 0 skipped, 0 worker-start failures | `e2e-combined-final.log` |

The e2e assertion failure was in `billing.e2e` ("admin filters … every combination"). The check that the admin read
writes no audit rows counted **every** audit row in the shared test database. Another e2e file running in parallel
wrote one row during the read (8777 vs 8776). The count is now scoped to this test's admin readers and fixture
accounts. It still catches the case it guards (an audit written by the admin read, whose actor is the root admin).
This was a test-isolation flaw that predates Step 6; Step 6's extra parallel webhook tests made it more likely.

Not rerun, because nothing they depend on changed (the frontend package and the backend's runtime client are
untouched):
- frontend tests (36 files, 440/440);
- the isolated build (62/62);
- the browser checks (10/10).

Their results above are from the previous run. The previous backend unit and e2e runs (11:50–11:54 IST) ran while the
RC CLI was installed. They used the same 7.10.0 client at runtime, and both have now been rerun fresh.

**Failures during the step, separated:**
- **Assertions (all fixed):**
  - `admin-onboarding` ×2 in the first combined run: it read `BILLING_ENABLED` from the developer `.env` (already
    there before Step 6). It now pins billing off.
  - In the close-out, the new bypass test first used a wrong route (`/media/upload-url`, 404) and was corrected to
    `/messages/:id/media/upload-url`. No application bug was involved.
- **Typecheck:** the first close-out build caught a frontend type error (the lock copy's fallback lacked the optional
  action). Fixed; then the build, source typecheck and tests passed.
- **Worker-start failures:** an earlier frontend run had 3 files fail to start (`trial-expired`, `trial-step7`,
  `kept-draft`) while the backend suite ran alongside. There were none in the final run.

**Browser checks** (local evidence: isolated build on :3001; isolated API on :4001 booted from `dist` with a fake
Stripe gateway, `api-fake-stripe.mjs`; synthetic accounts from `browser-seed.mjs`, removed afterwards: 4 users):
1. Desktop: Complete Monthly and Annual are buttons; Premium shows "Monthly / Annual: not available yet" with no
   button; no price is shown.
2. Phone: the same, and the layout fits.
3. Desktop, keyboard: Tab to Complete Annual and press Enter. The API receives exactly
   `{ tier: 'COMPLETE', interval: 'annual' }` (the log shows the fake session for the Complete annual price). The
   return shows "Confirming…", not success. `GET /billing` is still `trial_expired`, `hasAccess` false, no tier.
4. Phone: `?checkout=success` typed directly unlocks nothing; the pending note fits.
5. Phone: `?checkout=cancelled` shows "Nothing was charged", and the options are still offered.
6. Desktop, legacy/unmapped: "Subscribed", interval "Monthly", no tier name, no Choose a plan.
7. Phone, mapped: "For After Complete, annual"; the layout fits.
8–9. Desktop and phone, unresolved: "Plan being checked" and the explanation. Contact support → `/support/new`,
   reachable by Tab. No plan choices and no "choose a plan" or "purchase" prompt.
10. Phone, unresolved: a save is refused with 402 `PLAN_UNRESOLVED`, and the message never says "choose a plan".

## Real sandbox check: blocked

Readiness, checked read-only (no values printed):

| Item | Finding |
|---|---|
| Sandbox account | The Stripe MCP sees exactly one account: "for after sandbox", test mode. This matches the intended sandbox. |
| Products / prices | **None.** `GET /v1/products` and `GET /v1/prices` (active and inactive) are both empty. The authorised Complete prices (AUD 99 monthly, AUD 999 annual) have **not** been created. Premium has none, by design (undecided). |
| App credentials (`for-after-backend/.env`) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and all four `STRIPE_PRICE_PREMIUM/COMPLETE_*`: **missing**. `BILLING_ENABLED` and `BILLING_ENFORCE_FROM` are present. |
| Stripe CLI | v1.55.11 installed; **not logged in** (no account or test-mode key in its config), so `stripe listen` can't forward signed webhooks. |

Checkout → signed webhook → entitlement → UI is therefore **not verified**. No placeholder configuration was made. To
unblock (this needs actions this close-out was not permitted to take):
1. Create the two Complete sandbox prices (AUD 99 / month and AUD 999 / year, recurring).
2. Put the sandbox `sk_test_…` and both price ids into an isolated env (`STRIPE_PRICE_COMPLETE_MONTHLY` /
   `_ANNUAL`).
3. Run `stripe login` and choose "for after sandbox".
4. Run `stripe listen --forward-to localhost:<api>/api/v1/webhooks/stripe` and use its `whsec_…` as
   `STRIPE_WEBHOOK_SECRET`.
5. Run hosted Checkout with a test card as a synthetic customer.

## Development migrations

Checked read-only on `for_after` (nothing applied or reversed):
- `prisma migrate status`: **51 migrations, schema up to date, none pending.**
- `_prisma_migrations` (applied steps 1 each; none rolled back):

  | Migration | Applied (IST) |
  |---|---|
  | `20261116120000_add_billing_paid_tier` | 2026-11-16 13:46:23 |
  | `20261117090000_add_ai_usage` | 2026-11-16 16:17:03 |
  | `20261117120000_add_billing_price_unresolved` | 2026-11-17 10:34:56 |

- The last one was applied about 10 minutes after the isolated DB. None of this session's commands targeted the
  development DB, and who applied it is not known. The local dev stack (watch API, worker, Next dev, Prisma Studio)
  was running by then.
- **Schema compatibility:**
  - `BillingAccount.priceUnresolved` is `boolean NOT NULL DEFAULT false`; `tier` is a nullable enum.
  - Every existing row reads `priceUnresolved = false`, so none changed meaning.
  - The watch API compiled the Step 6 code against it.
- For any other environment: `npx prisma migrate deploy` from `for-after-backend/` applies every pending migration.

## Not run

- The real sandbox Checkout flow (blocked, above).
- A browser check of the lock dialogs on content pages. They are covered by component tests
  (`plan-unresolved.test.tsx`); the browser covered the plan page and a refused write.
- No full frontend suite (61 files); the 36 billing-relevant files were run.
- No backend e2e beyond the 15 affected files.

## Remaining business decisions

- **Premium pricing:** undecided; Premium stays unavailable.
- **Unresolved prices:** confirm the interim fail-closed policy (a paying customer is read-only until support fixes the
  price), or choose another treatment.
- **Legacy subscriptions:** which tier, if any, existing `monthly` / `annual` subscriptions get. Not backfilled.
- **Tier switching:** proration, Checkout versus Customer Portal, and the Portal's product configuration. Not built;
  Checkout refuses a second subscription.
- Whether a grandfathered account that subscribes gets its tier.
- **Prisma 8:** reverted to the declared 7.10 pairing because there was no documented requirement. If a move to Prisma
  8 is wanted, plan it as a deliberate upgrade:
  - CLI and client together, on a stable release rather than an RC;
  - a `prisma.config.ts` rewrite;
  - `prisma generate` and the full test suite.

The unresolved-price rule is an **interim** policy applied as instructed. It is not a final business approval.

Step 7 was not started.

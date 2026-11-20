# Updated Plans Step 8: final integration verification and review (2026-11-19)

**Status: complete (local).** Steps 2–7 were verified end to end on isolated services with fake providers. Two defects
were found and fixed, with regression tests. The account-management split is done.

> **This is not payment verification and not production readiness.** Every payment path ran against a fake Stripe
> gateway with locally signed webhooks. Real sandbox Checkout → signed webhook → persisted entitlement → UI unlocking
> remains **BLOCKED** (below).

Nothing was staged, committed, pushed or deployed. Billing was not enabled in any other environment. No Stripe objects,
credentials or CLI login were created or changed. No customer data was touched: every account was synthetic, in the
isolated database `for_after_p24`, and removed afterwards. No row was edited to stand in for a payment.

Evidence: [`evidence/updated-plans-step-8/`](evidence/updated-plans-step-8/). Policy: [`billing.md`](billing.md) §9.

## 1. Account-management separation

**Requirement:** Settings → Plan holds only the account's status, usage and management actions. Purchase controls live
on a separate authenticated route.

| | Settings → Plan (`/settings/plan`) | Purchase route (`/settings/plan/choose`, new) |
|---|---|---|
| Shows | Plan + access badge, dates, state notes; usage meters; Start free trial (eligible); Manage billing (subscribers); checkout-return messages | One panel per tier on sale: tier name, Monthly/Annual radios (configured only), "Continue to secure checkout" |
| Purchase controls | **none** (no cards, comparison, radios or checkout button) | yes, only when billing is on, no subscription is held and an offering is configured |
| Navigation | one internal **"Choose a plan"** button, shown only when buying is possible | "Your plan" back link |
| No offering, no access | "Plans can't be bought online just yet" + Contact support | the same |
| Subscriber (paid, payment issue, cancelling, payment pending) | Manage billing where allowed; no Choose a plan | "You already have a subscription… Changing plans isn't available online yet" + Contact support; no controls |
| Unresolved | support note + Contact support | "couldn't match it to one of our plans" + Contact support; no controls |
| Billing off | "Your current access" | "Plans aren't available yet" |
| External comparison | none | **"Compare plans on our website"** (external icon), only when `NEXT_PUBLIC_PLANS_URL` is an https URL. **Unset: no verified URL, so no link.** |

- Checkout still sends only `{ tier, interval }`; the server picks the configured price and refuses anything else.
  Return URLs are unchanged (`/settings/plan?checkout=…`), so the bounded "Confirming…" wait still runs there and
  never grants access from the URL.
- Lock dialogs keep "View plans" → `/settings/plan`, which carries the Choose a plan button when buying is possible.
  The dashboard's locked banner is hidden on both plan routes (it pointed back to the plan page).
- Prices, entitlements, offerings and the subscription-switching policy are unchanged.

Files: `src/components/account/plan.tsx` (`PlanActions`, `ChoosePlanPage`, shared `purchase()` decision),
`src/app/(dashboard)/settings/plan/choose/page.tsx` (new), `src/components/layout/dashboard-shell.tsx` (banner on both
plan routes), `plan.test.tsx`.

## 2. Bugs found and fixed

| # | Defect (confirmed) | Fix | Regression |
|---|---|---|---|
| 1 | **Second Checkout while the first payment was unconfirmed.** `POST /billing/checkout` refused paid, cancelling, payment-issue and unresolved accounts but **not `payment_pending`** (Stripe `incomplete`). Both sessions could be paid (double charge). The plan page already treated this state as "holds a subscription" and said the API refuses it; the API didn't. | `billing.service.ts`: `payment_pending` added to the refused states (409, before any Stripe call). The Customer finishes or fixes the payment through Manage billing, or it expires. | `stripe-tiers.e2e`: 409 while pending and `createCheckout` not called |
| 2 | **Stale usage meters after a plan change.** After Start free trial, the plan page still showed the old storage limit ("0 KB of 5.0 GB") and "AI: Available again with an active plan". The same applied to a confirmed checkout or a webhook tier change seen without a reload. Found by browser journey 1 (run 1). | `query-client.ts`: one cache subscription. When `GET /billing`'s state, access or tier changes, storage and AI usage are re-read. Usage counts are never reset (the server keeps the month). | `plan.test.tsx` "Step 8 regression…"; browser journey 1 |

Review findings that needed no change: see §6.

## 3. Requirement coverage matrix

Declared product features are separated from implemented capabilities. "e2e" = backend e2e on the isolated DB; "unit"
= backend unit; "FE" = frontend vitest; "browser" = this step's journeys (`journeys.browser.mjs`).

| Requirement | Implementation | Evidence | Gap |
|---|---|---|---|
| Explicit 7-day trial | `POST /billing/trial` (server dates, one per account, never by GET) | e2e `billing` (7 days, concurrency, retries), `trial-storage`; browser 1 (start → 7.000 days) | — |
| Storage 100 MB / 2 GB / 5 GB | `PLAN_DEFINITIONS.storageBytes`; quota under User lock | e2e `trial-storage`, `plan-limits` (exact boundaries, parallel reservations), `storage-quota`, `storage-lifecycle`; browser 1 (100 MB meter) | — |
| Recipients 1 / 10 / 50 | `recipientLimit()` in the create transaction (User lock) | e2e `trial-people`, `plan-limits` (10th/11th, parallel to exactly 50); browser 2/3 | — |
| Trusted contacts 1 / 2 / 2 | trial cap; `MAX_TRUSTED_CONTACTS = 2` (User lock) | e2e `trial-people` (pending invites count, concurrency), `trusted-contacts` | — |
| 4 combined trial questions; 1 trial text memory | `lockAnswerEntitlements`, memory cap (User lock) | e2e `trial-questions` (both sections, concurrency), `trial-step7` (8 concurrent → 1) | — |
| Trial media restriction; recipient-photo exception | `PaidFeatures.assertMedia` on every upload/format/conversion; recipient photos are not content media | e2e `trial-media`, `trial-storage` (recipient photos within 100 MB); browser 2 (Photos "Premium", Video "Complete") | `trial-storage` comment still calls the photo policy "undecided" (approved 2026-11-14): stale comment |
| Premium photo/audio; Complete video | `allowedMediaKinds`; `TIER_REQUIRED` for Premium video | e2e `plan-media` (uploads, formats, restore, conversions, mid-upload downgrade); browser 3 (Premium Video locked, Complete open) | — |
| Existing content kept after downgrade | caps refuse only new rows/bytes | e2e `plan-limits` "downgrade excess", `plan-media` (existing video kept), `trial-step7` excess | — |
| Expired: read / download / delete | 402 gate on writes only | e2e `trial-expired` (reads, signed download URLs, deletes, other account 404); browser 5 (read + delete a memory, people listed) | Download not browser-tested (needs real stored files on a real provider) |
| AI 5 per trial; 50 / 200 per UTC month | `AiUsageService` (`aiMeter`) | e2e `ai-allowance` (6th refused, 51st, 201st, UTC month edge); browser 3 (12 of 50 → 12 of 200) | — |
| Concurrency, idempotency, AI reservation recovery | User-row locks; unique `(userId, requestId)`; reserve → settle/release; expiry frees abandoned slots | e2e `ai-allowance` (one slot, two requests → one charge; reused id → one call; abandoned reservation expires; late settle refused), cap concurrency tests above | — |
| Stripe tier/interval mapping; unresolved prices | `StripePrices`; webhook re-reads subscriptions, version guard on `syncedAt` | e2e `stripe-tiers` (tampered input, unpriced, stale event, ambiguous, transient failure, recovery), `billing` (forged/foreign events, out-of-order); browser 5–6 (fake signed webhook → confirmed; unresolved → recovered) | Real Stripe not exercised (§5) |
| Legacy, grandfathered, billing-off | unmapped interval-only; exemptions | e2e `plan-tiers`, `stripe-tiers` (legacy price), `billing` (rollout rule), `plan-limits`; FE plan tests | Legacy tier and grandfathered-subscriber policy undecided |
| Current-plan page, purchase route, badges, dialogs, counters | §1; `trial-cap.tsx` | FE `plan.test.tsx` (23), `plan-locks`, `people`, `plan-media`, `trial-*`; browser 2–3, 5–6 at 1280/820/390/200% | Screen-reader software not tried |
| Account isolation; temporary unsaved drafts | `resetPrivateCache` + `clearLocalDrafts`; account-keyed tab copies | FE plan "Account isolation", kept-draft tests; e2e `draft-recovery`; browser 4 (expiry mid-form keeps text + tab copy; log out clears it; next account sees only its own plan and an empty form) | — |
| Pending / cancelled / success return | URL only changes the message; bounded re-checks | e2e `billing`, `trial-expired`; FE checkout-return tests; browser 5 (cancel → nothing charged; success URL → still locked; webhook → confirmed) | — |
| **Declared only, not implemented** | `support: 'priority'` (Complete), Memory Vault video (never; memories hold no video on any plan), QR codes, transcription | none: not advertised (copy tests forbid "priority support", "QR", "transcri") | Need separate approval and build; not added in this review |

## 4. Fresh checks (2026-11-19, after the last code change unless stated)

| Check | Command (scope) | Result | Evidence |
|---|---|---|---|
| Backend unit, full | `npx vitest run` (for-after-backend) | Combined run: 77 of 78 files started, **1611 passed, 1 timed out** (`auth.service.spec` change-email, 20 s, under load), and **1 worker-start failure** (`recipient-auth.service.spec`). Rerun alone: **2 files, 68/68**. All 78 files and **1651/1651** pass. | `backend-unit-final.log`, `backend-unit-rerun.log` (first run before fix 1: `backend-unit.log`, 78 / 1651) |
| Backend typecheck / lint | `npx tsc --noEmit`; `npm run lint` (oxlint type-aware) | exit 0 / exit 0 (only the existing `ip-blocks` warnings) | `backend-tsc.log`, `backend-lint.log`, `backend-oxlint.log` |
| Backend e2e, one combined run (after fix 1) | `node scripts/phase24/isolated-env.mjs -- npx vitest run --config ./vitest.config.e2e.ts <27 files>` | **27 files, 342/342**, exit 0, 0 skipped, 0 worker-start failures | `e2e-combined.log`, `e2e-files.txt` |
| Frontend unit, full | `npx vitest run --maxWorkers=2` (for-after-frontend) | **64 files, 918/918**, exit 0, 0 skipped, no worker-start failures (rerun after fix 2; the run before it: 64 / 917) | `frontend-vitest-full.log` |
| Frontend typecheck / eslint (changed files) | `npx tsc --noEmit`; `npx eslint …` | exit 0 / exit 0 | `frontend-tsc.log`, `frontend-eslint.log` |
| Backend production build | `npm run build` (no dev API running; checked first) | exit 0; `dist` contains fix 1 | `backend-build.log` |
| Frontend isolated production build (copy at `D:\for-after-p7-buildcheck`, synced; `NEXT_PUBLIC_PLANS_URL` unset) | `npx next build` | exit 0; TypeScript passed; **63/63** pages (new `/settings/plan/choose`); rebuilt after fix 2: exit 0, 63/63 | `next-build.log`, `next-build-2.log` |
| Browser journeys (isolated `next start` :3001 + fake-Stripe API :4001 with `EMAIL_PROVIDER=console`, `SMS_VERIFY_PROVIDER=console`, fake keys/prices; 7 synthetic accounts, removed) | `isolated-env.mjs -- node journeys.browser.mjs` | Run 1: 13/17 (below). **Final run: 17/17** on fresh fixtures | `browser-run-1.jsonl`, `browser-run.jsonl`, `api.log` |

The e2e set: billing, plan-tiers, plan-limits, plan-media, stripe-tiers, ai-allowance, assistant, trial-expired,
trial-media, trial-people, trial-questions, trial-step7, trial-storage, admin, admin-onboarding, storage-lifecycle,
storage-manager, storage-quota, media, recipients, trusted-contacts, memory-vault, memory-to-message, draft-recovery,
my-story-rich, my-wishes-rich, message-composition.

**Browser run 1 failures, separated:**
- **App defect (fixed, fix 2):** journey 1, stale storage and AI meters after Start free trial.
- **Script timing (not an app defect):** journey 4 read `sessionStorage` before the 500 ms tab-copy write; the check
  now waits for it. The typed text and "Not saved to your account" already passed.
- **Environment (throttle working as designed):** the account-switch sign-in was the 6th login in a minute from one
  IP ("Too many attempts", 5/min). The script now waits out the window once (logged as a note); the API limit was not
  changed.
- **Selector too strict:** after a successful delete, a non-visible node still matched the title; the check now counts
  visible matches only (the list showed the empty state).
- Run 1's failure screenshots were removed before the final run; its JSONL is kept.

**Browser journeys (final run):** new customer → explicit trial (7.000 days, 0 of 1, 0 of 5, 100 MB) · people cap →
Premium dialog (focus trapped, Escape returns focus) → View plans → plan page → Choose a plan → purchase route ·
trial/Premium/Complete media capabilities · plan page and purchase route at 1280, 820, 390 and 200% zoom (no page
scroll) · keyboard to Choose a plan (visible focus) and interval by arrows · Premium refused a second subscription ·
Premium → Complete by signed fake webhook with AI 12 of 200 (month kept) and 3 of 50 people · trial ends mid-form:
text kept, "Not saved to your account", tab copy written · log out clears it; next account sees only its own plan and
an empty form · expired: read + delete a memory, people listed · Checkout cancelled → nothing charged · Checkout by
keyboard sends `{ COMPLETE, annual }`, success URL alone locked, signed fake webhook → "Your subscription is
confirmed" · unresolved → Contact support → `/support/new`, purchase route refuses, valid fake sync recovers to
Complete.

**Final screenshots** (`evidence/updated-plans-step-8/screens/`, synthetic data):
- current-plan page: `plan-trial-desktop`, `plan-trial-tablet`, `plan-trial-phone`, `plan-trial-zoom200`,
  `plan-premium-desktop`, `plan-unresolved-desktop`;
- purchase route: `choose-trial-desktop`, `choose-trial-tablet`, `choose-trial-phone`, `choose-trial-zoom200`;
- checkout return before confirmation: `checkout-pending-desktop`.

**Not run / skipped:**
- **Repository Playwright suite (`for-after-frontend/e2e`): not run.** It can't safely target isolated services: its
  `webServer` starts `next dev` and `npm run build` in the real frontend directory, the `account` project is fixed to
  `:3000`, and the vault/people/portals specs upload to the **development ImageKit account** (a real provider). It
  has no billing specs. Alternative: the dedicated journey script above (same Playwright, isolated build and API).
- **Screen-reader software:** not tried (NVDA/VoiceOver). Roles, labels, `aria-valuetext` and live regions are
  asserted in tests only.
- Download while locked: e2e only (signed URLs), not in the browser.
- Backend e2e files outside the 27 (death verification, announcements, portals, …): not rerun; unchanged areas.
- No tests skipped in any run (0 skipped reported).

## 5. Stripe sandbox: BLOCKED

Read-only readiness (no values printed, nothing changed):

| Item | Finding |
|---|---|
| `BILLING_ENABLED`, `BILLING_ENFORCE_FROM` (backend `.env`) | set |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | **missing** |
| `STRIPE_PRICE_PREMIUM_*`, `STRIPE_PRICE_COMPLETE_*`, legacy `STRIPE_PRICE_*` | **missing** |
| Stripe CLI | installed; **no stored API keys (not logged in)** |
| `NEXT_PUBLIC_PLANS_URL` (frontend) | not set (no verified marketing URL) |

Hosted Checkout → signed webhook → persisted entitlement → UI unlocking was **not exercised** and stays blocked until
sandbox prices, app credentials and a webhook endpoint exist.

## 6. Review of the subscription diff

| Area | Finding |
|---|---|
| Authorization / cross-account | All billing, usage and AI reads use the session user only; admin billing is SUPER_ADMIN only; ownership 404s covered (`trial-expired`, `trial-people`, `trial-step7`). No issue. |
| Concurrent caps | Recipients, trusted contacts, questions, the trial memory, storage and AI reservations all count and insert under a `User … FOR UPDATE` lock; parallel e2e tests pass. No issue. |
| Duplicate subscription / payment | **Fixed (bug 1).** Checkout idempotency key per account/tier/interval/hour; one Stripe customer per account (unique). |
| Stale / old-subscription webhooks | Every event re-reads the customer's subscriptions; best-ranked wins; `syncedAt` optimistic version; superseded events recorded without changes; event ids unique. Covered by `billing`, `stripe-tiers`. No issue. |
| Media copy / restore / completion bypass | Uploads, completion, format changes, version restore and memory/story/wish → message snapshots all call `PaidFeatures.assertMedia`; completion re-checks after mid-upload downgrade. Covered by `plan-media`, `trial-media`. No issue. |
| AI settlement / duplicate provider calls | Request id claimed (Redis NX) and reserved (unique) before the provider call; settle only while unexpired; a failed settle keeps the slot (no reply shown, no retry); failures release. No issue. |
| Truthful UI | **Fixed (bug 2).** No prices, no "unlimited", no priority support/QR/transcription claims; no access from return URLs. |
| Migrations / dependencies | Development DB (`for_after`), read-only `prisma migrate status`: **51 migrations, schema up to date** (Step 3's pending `migrate deploy` is no longer pending). Backend lockfile: no version changes. Prisma CLI 7.10.0 (8.0.0-rc.34 offered, not taken). |

**Unrelated findings (not changed):**
- Frontend `package.json` adds `libphonenumber-js` (used by `src/lib/phone.ts`; locked and installed): phone work,
  not this workstream.
- `test/trial-storage.e2e-spec.ts` comment calls the trial recipient-photo policy "undecided"; it was approved on
  2026-11-14.
- The repository Playwright config can't target an isolated API/build without real ImageKit uploads (see §4).

## 7. Outstanding decisions and launch blockers (retained)

- **Real sandbox payment verification** (blocked, §5).
- **Confirmed marketing pricing URL** for `NEXT_PUBLIC_PLANS_URL`, and the marketing-site → app connection (WordPress
  login/signup, Phase 25).
- **Premium pricing** and approved live prices (and a pricing contract before any price appears in the app).
- **Legacy-tier migration** for existing `monthly` / `annual` subscriptions (still unmapped; no backfill).
- **Grandfathered subscription policy** (whether a grandfathered account that subscribes gets its tier).
- **Tier switching and proration** (Checkout vs Customer Portal; Portal product configuration).
- **Final approval of the unresolved-price interim policy** (fail closed; held unmapped subscriptions keep access).
- Also open: what "priority support" means operationally; final badge and dialog copy; subscription-after-death
  behaviour; production infrastructure (Phase 27).

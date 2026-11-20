# Updated Plans Step 7: customer plans and usage experience (2026-11-17, refined 2026-11-19)

**Status: complete (local), including the 2026-11-19 refinement (sales cards removed; see the next section).**
- Local evidence only: fake Stripe adapter, isolated database, Redis and build, synthetic accounts.
- **Real payments are not verified.** Sandbox Checkout → signed webhook → entitlement → UI is still blocked, as in
  Step 6 (no sandbox prices, no app credentials, Stripe CLI not logged in).
- This is not production-ready billing.

Nothing was staged, committed, pushed or deployed. No Stripe objects or environment settings were changed, no
development migration was applied, no live provider was contacted, and no customer data was touched. The
unresolved-price rule is still the **interim** Step 6 policy, not a final business approval.

Policy: [`billing.md`](billing.md) §9 Step 7. Evidence: [`evidence/updated-plans-step-7/`](evidence/updated-plans-step-7/).

## Refinement (2026-11-19): plan page without sales cards

**Approved requirement:** Settings → Plan shows the current plan and access, usage and the supported billing actions.
The three sales cards and the expandable comparison go (pricing and comparisons belong on the marketing site). One
secondary Compare plans / View plans link, to a verified URL only. Keep a separate authenticated Checkout entry, the
trial, expired, legacy, exempt and unresolved states, and the shared Premium/Complete badges.

**What the 2026-11-19 10:53 edit of `plan.tsx` actually was.** The timestamp alone wasn't trusted. Evidence:
- VS Code local history holds three snapshots of `plan.tsx`. The 10:53:30 one is byte-identical to the file as found.
- That file is also byte-identical to the copy used for the Step 7 isolated build (`D:\for-after-p7-buildcheck`, 11-17
  14:03).
- Its differences from the 11-17 13:15 snapshot are all Step 7 fixes this report already lists (focus ring, "Adding
  people needs an active plan", the can't-buy note without a matrix, the Free Trial card wording for subscribers).
- **Conclusion:** the save changed no content. It did not start the refinement, was not incomplete work, and contained
  no unrelated work. What it was for (probably an editor save) can't be established. The rest of the ~212 uncommitted
  paths were not attributed to this task and were left alone.

**Changes made:**
- `src/components/account/plan.tsx`:
  - Removed the Free Trial / Premium / Complete cards, the `<details>` comparison, the trial-card footer and their
    helpers.
  - New **Choose a plan** section. It shows only when billing is on, the account holds no subscription and Stripe has
    at least one `{ tier, interval }` configured. One small panel per tier on sale holds the tier name, the existing
    interval radio group and "Continue to secure checkout" (logic kept as it was, now `TierCheckout`). Tiers not on
    sale are not shown.
  - The Step 6 "can't be bought online just yet" note is kept for accounts with no access when nothing is configured.
  - Header copy: "Your plan, what you're using, and your billing options."
- `src/lib/env.ts` + `.env.example`: `plansUrl()` reads `NEXT_PUBLIC_PLANS_URL` and accepts https only. **Unset by
  default.** Only then is the single "Compare plans" link shown, inside the purchase area, for billing-on accounts.
- `src/components/companion/companion.tsx`: the allowance-exhaustion link "Compare plans" → **"View plans"**. It still
  goes to `/settings/plan`, which no longer compares plans; this matches the lock dialogs.
- `src/components/shared/trial-cap.tsx`: a comment only. No badge or dialog change.
- Tests: `plan.test.tsx` (card and comparison assertions replaced; 2 new tests for the link gate and for no purchase
  section when nothing is on sale; 21 tests), `companion.test.tsx` (link name).
- **Unchanged:** backend, API, enforcement, `planDefinitions` (still used by the lock dialogs), lock badges, account
  isolation, draft recovery.

**Current customer-visible layout** (top to bottom): the summary (plan, access badge, dates, Start free trial or
Manage billing, state notes) → What you're using (meters) → **Choose a plan** (only where buying is allowed and
configured).

| Account | Purchase area |
|---|---|
| Active trial / expired trial | Choose a plan: For After Complete, Monthly/Annual, Continue to secure checkout (Premium unpriced, so not shown) |
| Expired, nothing configured | "Plans can't be bought online just yet" + Contact support |
| Premium, Complete, legacy/unmapped, payment pending, payment issue, cancellation scheduled | none (Manage billing in the summary where allowed) |
| Unresolved | none; the summary's Contact support note |
| Billing off / grandfathered | none; "Your current access" sentences |

**Checkout entry:** the cards held the only authenticated Checkout entry. It is preserved as Choose a plan with the
same eligibility (billing on, no subscription held) and the same payload. Every lock's "View plans" and the companion
link still go to `/settings/plan`. Verified in the browser: the trial-cap dialog → View plans → the plan page with
Checkout.

**Marketing link: missing destination.** No pricing URL is configured or documented anywhere (the docs name only the
marketing domain, with no pricing path). None was guessed, so **no Compare plans link ships**. Set
`NEXT_PUBLIC_PLANS_URL=https://…` at build time once the real page is confirmed.

**Fresh checks (2026-11-19, after the last code change):**

| Check | Result | Evidence (`evidence/updated-plans-step-7/refinement/`) |
|---|---|---|
| Frontend vitest, the same 12 directories (53 files), one run | **53/53 files, 746/746**, exit 0, no timeouts or worker-start failures | `frontend-vitest.log` |
| Source typecheck / eslint (the 6 changed files) | exit 0 / exit 0 | `frontend-tsc.log`, `frontend-eslint.log` |
| Isolated production build (copy synced, `NEXT_PUBLIC_PLANS_URL` unset) | exit 0; compiled; TypeScript passed; 62/62 pages | `next-build.log` |
| Isolated browser, desktop 1280 + phone 390 (`next start` :3001, fake-Stripe API :4001, `EMAIL_PROVIDER=console`, `SMS_VERIFY_PROVIDER=console`, 5 synthetic accounts, removed afterwards) | **9/9** | `browser-run.jsonl`, `plans-refined.browser.mjs`, `api.log`, `screens/r01–r08` |

Browser checks: no cards, table, comparison or link in any state; trial and expired show Complete Checkout; the arrow
key picks Annual; Tab + Enter sends exactly `{ COMPLETE, annual }` (API log: a fake checkout for the annual Complete
price); the return shows "Confirming" while `GET /billing` stays `trial_expired` with no access; the lock → View plans
navigation; Premium, Complete and unresolved show no purchase; no horizontal scroll on phone.

**What the earlier results still cover:**
- The original Step 7 frontend, build and browser results (below) describe the card layout and are **superseded for
  the plan page**.
- The backend results (unit 1651/1651, e2e 183/183, tsc, oxlint) still stand. No backend file changed, and the
  isolated API ran from the existing `dist`, which is newer than every backend source file.
- **Not rerun today:** backend suites (no backend change), the 820 px and 200% zoom widths, screen-reader software,
  and the 8 frontend directories outside the 12.

**Blockers (unchanged):** real Stripe sandbox Checkout, webhook and entitlement (no sandbox prices, no app
credentials, CLI not logged in); the verified marketing pricing URL; the pricing contract. No Stripe objects or
credentials were created or changed.

## Refinement 2 (2026-11-20): Settings → Plan as an account page

**Starting point.** Most of the request was already in place from refinement 1 and Step 8. No cards or comparison;
purchase controls on the separate authenticated `/settings/plan/choose`; every state handled; failures shown with
retry. This refinement changed only what was still missing.

**Changes (frontend only; no backend, API, pricing or entitlement change):**
- `src/components/account/plan.tsx`:
  - Concise dates. One format, each date shown once: "27 Nov 2026, 9:44 am (UTC+5:30)", in the viewer's timezone
    with its offset. It replaces "Thursday 19 November 2026 at 12:41 pm (India Standard Time (UTC+5:30)) to …".
  - Trial row only for trial states: "Trial ends" / "Trial ended", with the end date only. A paid account no longer
    shows its old trial range. Renewal rows: "Renews" / "Paid until" / "Access ends", from `currentPeriodEnd` only.
  - The read-only notice (expired trial, ended paid access) ends with **"View plans"** → `/settings/plan/choose`
    when something is on sale. Those accounts get no second button.
  - Plan actions moved into the summary card: "Choose a plan" (accounts that can buy and still have access) and an
    optional small external **"Compare plans"** link. That link uses the plain `NEXT_PUBLIC_PLANS_URL`, with nothing
    about the account added. It never appears for subscribers, unresolved accounts or billing off.
  - Usage grid: one column on phones, two from 640 px, three from 1280 px.
- `plan.test.tsx`: two assertions updated (date label; "View plans" in the notice). New tests: concise dates (one
  offset, no long zone name, no range, no trial row for a subscriber) and Compare-plans eligibility across trial,
  Premium, cancelling, unresolved and billing off. 25 tests.

**What remains on Settings → Plan:** the summary card (plan name, access badge, billing interval, one date row, state
notes, Start free trial / Manage billing / Choose a plan / optional Compare plans / Contact support where they apply),
then "What you're using" (storage, People I Love, trusted contacts, AI with reset, the trial's questions and memory).
There are no cards, comparison, interval selectors or checkout buttons.

**Purchase entry:** `/settings/plan/choose`. It requires the signed-in customer and offers only server-configured
`{ tier, interval }` options (unconfigured ones disabled). The API refuses anything else and refuses a second
subscription (paid, cancelling, payment issue, payment pending, unresolved). Checkout returns to
`/settings/plan?checkout=…`, which grants nothing from the URL and waits for the backend.

**Marketing pricing URL: missing.** No URL is configured or documented (`NEXT_PUBLIC_PLANS_URL` unset in
`.env.example` and `.env.local`), so no Compare plans link ships.

**Marketing → app integration contract (not wired; the journey is not complete):**
- The marketing site links to `https://app.forafter.com.au/settings/plan/choose` (no query parameters, no account
  data). With the shared `.forafter.com.au` session cookie, a signed-in visitor lands on the purchase route.
- **Gap:** there is no post-sign-in return path. A signed-out visitor is sent to `/login` and then to `/dashboard`,
  not back to the purchase route. Needs a validated same-origin return parameter (app work) or a marketing-side
  "sign in, then choose a plan" flow. Also open: WordPress login/signup integration (Phase 25).
- The app needs `NEXT_PUBLIC_PLANS_URL` set to the confirmed https pricing page at build time.

**Fresh checks (2026-11-19/20):**

| Check | Result | Evidence (`evidence/updated-plans-step-7/refinement-2/`) |
|---|---|---|
| Frontend typecheck / eslint (`plan.tsx`, `plan.test.tsx`) | exit 0 / exit 0 | `frontend-tsc.log`, `frontend-eslint.log` |
| Frontend vitest, 12 directories (53 files), one run | exit 1: 47 files, 639/639 passed; **6 files failed to start a worker** (no assertion failures) | `frontend-vitest.log` |
| The 6 files rerun alone | 6 files, 111/111, exit 0 | `frontend-vitest-rerun.log` |
| Combined | **all 53 files, 750/750 pass** | |
| Isolated production build (copy synced, `NEXT_PUBLIC_PLANS_URL` unset) | exit 0; TypeScript passed; 63/63 pages | `next-build.log` |
| Isolated browser, desktop 1280×900 + phone 390×844 + keyboard (`next start` :3001; fake-Stripe API :4001 with console email/SMS; 10 synthetic accounts, removed) | Run 1: 15/16. **Final run (fresh fixtures): 16/16** | `browser-run-1.jsonl`, `browser-run.jsonl`, `api.log`, `plan-page.browser.mjs` |
| Backend | not run: no backend code or contract changed | |

- **Browser run 1 failure (script, not app):** the exempt check expected no "Choose a plan". Exempt accounts have
  always been offered Checkout (refinement 1 and Step 8, accepted by the API); the requirement is only that no
  purchased plan is invented. The check now asserts that and records the button. **Open decision:**
  grandfathered-subscription policy.
- **Browser coverage:**
  - Active trial (concise single date, 3 usage columns at 1280, Choose a plan, no sales content).
  - Keyboard to Choose a plan with visible focus.
  - Storage/AI request failures (Not available + Try again, never 0, recovery) and the plan read failure (error + Try
    again, no assumed plan).
  - Phone with 1 column and no overflow.
  - Expired: Trial ended, View plans reached by keyboard → purchase route.
  - Checkout entry by keyboard (`{ COMPLETE, annual }`) and return ("Confirming", no access; cancelled → nothing
    charged).
  - Typed text kept when the trial ends mid-form.
  - Premium: concise Renews; Manage billing works (fake portal returns); no Choose/Compare. Premium on phone.
  - Complete; cancelling ("Access ends", access still on); ended paid access (View plans).
  - Legacy ("4 added", "Not counted", never unlimited); exempt (no invented plan); unresolved (Contact support,
    no purchase prompt).
  - The login throttle (5/min per IP) was hit twice; the script waited and retried as designed.
- **Screenshots** (`refinement-2/screens/`, synthetic data): `r2-01-trial-desktop`, `r2-02-trial-phone`,
  `r2-03-expired-desktop`, `r2-04-premium-desktop`, `r2-05-premium-phone`, `r2-06-cancelling-desktop`,
  `r2-07-legacy-desktop`, `r2-08-unresolved-desktop`, `r2-09-exempt-desktop`.
- **Not run / blocked:**
  - Tablet and 200% zoom (not requested this time; Step 8 covered the earlier layout at 820 px and 200%).
  - Screen-reader software.
  - The full 64-file frontend suite (the 12 affected directories ran).
  - The repository Playwright suite (real ImageKit uploads).
  - **Real Stripe sandbox Checkout: blocked** (no keys, prices or CLI login).

> The sections below are the original 2026-11-17 Step 7 record. Where they describe "3. Plans" (cards, the
> comparison, the Free Trial card), the refinement above replaces them.

## What changed

**Backend (additive API only; no schema or migration):**
- `src/billing/billing.service.ts`, `GET /billing`:
  - `people.recipients { used, limit, limitSource }`: the live count, and the limit the create route enforces through
    the same `recipientLimit()`. `limitSource` is `trial`, `plan` or `null` (no count limit).
  - `people.trustedContacts { used, limit, limitSource }`: the trial's 1, or the two-contact maximum (`maximum`).
  - `planDefinitions`: the server's `PLAN_DEFINITIONS`.
  - Cost: two indexed counts per read. No Stripe call. Account-scoped (session user only).
- Tests:
  - `plan-limits.e2e`: `people` for Premium, Complete, unmapped, grandfathered and ended accounts, including after a
    tier change.
  - `trial-people.e2e`: trial caps and counts.
  - `plan-tiers.e2e`: `planDefinitions` equals the server matrix.

**Frontend:**
- `src/components/account/plan.tsx`: Settings → Plan, rebuilt as three sections.
  1. **Summary.**
     - The plan comes from `productTier.tier`, so a stored tier never shows while it isn't in force.
     - The Access badge is separate.
     - Trial, renewal, end or "paid until" dates.
     - Start free trial (eligible accounts only).
     - Manage billing (Stripe portal; no tier-change promise).
     - Payment issue, pending, unresolved, cancellation and read-only notes are kept.
     - Legacy/unmapped: "Subscription · Monthly/Annual". Exempt: "Your current access".
  2. **Usage.**
     - Storage, People I Love, trusted contacts and AI replies, plus the trial's questions and memory when they apply.
     - Bars use `role=progressbar` and are visually capped at 100%; `aria-valuetext` and the text keep the real value.
     - An over-limit row says everything is kept.
     - A failed read says "Not available right now" with Try again, per source. Never 0.
     - With no count limit: "no set limit", or "Adding people needs an active plan" without access. Never "unlimited".
  3. **Plans.**
     - Free Trial, For After Premium and For After Complete cards, worded from `planDefinitions`.
     - A native `<details>` holds the full comparison (13 rows, only supported features).
     - Purchase: a radio interval selector with only configured options; others are disabled and say "not available
       yet". "Continue to secure checkout" sends `{ tier, interval }`.
     - Unconfigured tier: "Not available to buy yet".
     - Already holding a subscription (paid, pending, unresolved): "Changing plans isn't available online yet" and
       Contact support. No upgrade button.
     - The trial card never restarts a trial.
- `src/components/shared/trial-cap.tsx`:
  - `useCapCopy()` builds the lock wording from the server's limit, its source and the tier.
  - `capFor()`: People I Love now locks at the paid limit too.
  - `ProBadge` defaults to "Premium". `ProDialog` can omit its action (Close only).
  - Trial video uses `TRIAL_VIDEO_COPY` ("Complete").
  - `PeopleCounter`.
- Call sites:
  - `media-manager.tsx` (trial video → Complete);
  - `message-form.tsx` and `memory-to-message.tsx` (trial VIDEO choice → Complete);
  - `recipients.tsx` and `trusted-contacts.tsx` (counters).
- `src/components/companion/companion.tsx`: on AI allowance exhaustion, "Compare plans" for the trial and Premium
  only.
- `src/lib/api/billing.ts`: types for `people`, `planDefinitions` and `PlanDefinition`.
- `src/hooks/use-vault.ts`: people writes refresh `GET /billing`.
- `src/lib/query/query-client.ts`: a `PLAN_LIMIT` refusal re-reads the plan.

## What customers now see

| Account | Plan page |
|---|---|
| Active trial | "Free Trial" + "Free trial" access, trial dates, usage at the trial's limits, Free Trial card marked "Your plan" |
| Premium (mapped) | "For After Premium · Billed monthly", Renews, Manage billing; Complete card: "Changing plans isn't available online yet" |
| Complete (mapped) | "For After Complete · Billed annually", Complete card "Your plan", nothing to buy |
| Expired trial | the read-only note; Premium "Not available to buy yet"; Complete Monthly/Annual + Continue to secure checkout; "Your free trial has been used" |
| Unresolved | "Subscription" + "Plan being checked", the support note, no purchase, AI "Available again with an active plan" |
| Legacy/unmapped | "Subscription · Monthly", "4 added" with no bar, AI "Not counted on your account" |
| Billing off / grandfathered | "Your current access" with the existing sentences; plans are informational |

Locks (all through the shared `ProDialog` / `UpgradeDialog`):

| Situation | Badge | Dialog action |
|---|---|---|
| Trial caps (person, contact, memory, questions) | Premium | View plans |
| Trial photos/audio, memory links | Premium | View plans |
| Trial video | Complete | View plans |
| Premium video | Complete (unchanged) | View plans |
| Premium at 10 people | Complete | View plans (comparison only) |
| Complete at 50 people | none | Close only ("the most on any plan") |
| Two-contact maximum | none (no add control, as before) | none |
| Unresolved subscription | — | Contact support (Step 6) |
| Expired / no access | — | View plans (unchanged) |

Companion: when the allowance is used, the trial and Premium get "Compare plans", and Complete gets the reset date
only. Hourly throttling is unchanged (Try again, no plan link).

## Pricing: missing backend contract

No backend contract supplies an amount, currency and interval for each configured offering. `checkoutOptions` holds
tier and interval only, and the Step 6 rule forbids a Stripe call on every entitlement read. So the plan page shows
**no prices**: "Prices are shown on Stripe's secure checkout page before you pay." No annual saving is claimed.
Premium is unpriced. The sandbox-only Complete amounts (AUD 99 / AUD 999) are not in customer copy.

## Results (fresh, after the final change)

| Check | Result | Evidence |
|---|---|---|
| Frontend vitest, 12 directories (account, shared, people, media, messages, memory-vault, prompts, companion, layout, admin, lib, hooks; 53 files), final run | 50 of 51 started files passed, 702/703 tests. 1 test timed out (20 s) under memory pressure; 2 files hit worker-start failures. Rerun alone: those 3 files, **54/54** passed. **All 53 files pass.** | `frontend-vitest.log`, `frontend-vitest-rerun.log` |
| Frontend eslint (all 91 changed `src` files) / source typecheck | exit 0 / exit 0 | `frontend-eslint.log`, `frontend-tsc.log` |
| Isolated production build | exit 0; compiled; TypeScript passed; 62/62 pages | `next-build.log` |
| Isolated browser (desktop 1280, tablet 820, phone 390, 200% zoom) | **12/12** | `browser-run.jsonl`, `screens/` |
| Backend `tsc` / oxlint (`src`, `test`, `prisma.config.ts`) | exit 0 / exit 0 (the same 5 old `ip-blocks` warnings) | `backend-tsc.log`, `backend-oxlint.log` |
| Backend unit, full suite, final run | **78 files, 1651/1651** | `backend-unit-final.log` |
| Isolated e2e, all 15 billing files, one combined run (after the last backend change) | **183/183**, exit 0, 0 skipped, 0 worker-start failures | `e2e-combined.log` |

**Screenshots** (`evidence/updated-plans-step-7/screens/`, synthetic accounts only):
- `01-trial-desktop`, `02-trial-phone`, `03-trial-200pct-zoom`;
- `04-feature-lock-dialog`;
- `05-premium-desktop`, `06-premium-phone`;
- `07-complete-desktop`;
- `08-expired-desktop-comparison-open`, `09-expired-phone`;
- `10-unresolved-desktop`.

**Browser checks:**
- No page-level horizontal scroll at any width. The comparison table scrolls inside its own box.
- Keyboard:
  - the interval is chosen with arrow keys;
  - Tab + Enter starts Checkout, sending exactly `{ COMPLETE, annual }`;
  - the comparison opens and closes with Enter, with visible focus;
  - the lock dialog traps focus, and Escape returns focus to its button.
- The fake Checkout returns to `?checkout=success`. It shows "Confirming…" and the API still says `trial_expired`,
  with no access.

**Failures during the step, separated:**
- **Assertion failures (all fixed):**
  - Expected contract changes: "Pro" → "Premium"/"Complete", the new lock and dialog copy, and the "Manage billing"
    label in existing tests.
  - Four tests (messages, memories, story workspace, my-wishes-rich) still expected the body without the `requestId`
    that Step 5 added. Step 5 hadn't run those files. They now expect a UUID; they don't strip it.
  - My own first drafts of new tests: wrong regexes and the jsdom `<details>` keyboard limit.
  - Real UI bugs found and fixed:
    - The "can't be bought online" note was lost when the plan matrix was absent.
    - The disclosure toggle had **no visible focus ring** (Tailwind 4 `outline-none` needs `outline-solid`). This was
      found by the first browser run (11/12, kept as `browser-run-1-focus-bug.jsonl`).
    - Misleading "no set limit" text for accounts without access, and the Free Trial card wording for subscribers.
      Both were found in the screenshots (the run before the fix is kept as `browser-run-2-before-wording.jsonl`).
- **Infrastructure failures:**
  - The final frontend run went over free RAM (about 570 MB free). The local dev stack, VS Code and Chrome were
    running alongside.
    - `story-inline-media` "leaving mid-upload…" timed out at 20 s.
    - `dashboard-shell` and `admin/security-activity` failed to start a worker.
    - All three passed alone (54/54).
  - The run before the last wording change had all 53 files in one run: 745/745 tests, before 3 tests were added.
  - One combined backend unit run: `auth.controller.spec` (16 tests) was skipped after its 30 s app-boot hook timed
    out under load. It passed alone (`backend-unit-auth-rerun.log`) and in the final full run.
  - Early frontend runs had worker-start failures (`people`, `trial-questions`, `my-wishes-rich`) while other suites
    ran in parallel.
- **Tooling note:** `plan.tsx` was repeatedly rewritten on disk to double quotes a moment after each edit. No repo
  hook does this, so it is probably an editor formatting on save while the file is open. The content is unaffected,
  and eslint and the typecheck pass.

## Requirements cross-check

- A stored tier never makes an expired or unresolved account look active. Covered by the plan tests (unresolved,
  expired) and browser check 12.
- Trial available, active, capped and expired; mapped Premium and Complete; legacy/unmapped; billing-off;
  grandfathered; unresolved; payment pending. Covered by `plan.test.tsx` (20) and `plan-locks.test.tsx` (8).
- Usage below, exactly at and above limits; loading and failed reads: `plan.test.tsx`.
- No unsupported purchase or tier switch, and the trial can't restart: `plan.test.tsx` and the browser.
- Badge wording: `plan-locks.test.tsx`, `plan-media`, `trial-media`, `trial-step7`, `trial-questions` and `people`
  tests.
- Typed input and draft recovery survive billing refreshes. Covered by the existing Step 6–7 suites (`trial-expired`,
  `kept-draft`, the question gate's "stays open"), all in the final run. The gate decisions never swap an open form
  on refetch.
- Account switching: `resetPrivateCache` drops billing, storage and AI usage (`plan.test.tsx`, "Account isolation").
  The companion is keyed by account (existing test).
- Checkout payload and server-confirmed unlocking: `plan.test.tsx` and the browser.

## Not run, skipped or blocked

- **Blocked:** real Stripe sandbox Checkout, webhook and entitlement (no sandbox prices, no app credentials, CLI not
  logged in).
- **Not run:** the full 61-file frontend suite (the 12 affected directories were run); backend e2e beyond the 15
  billing files.
- **Not run:** screen-reader software testing. Roles, labels, `aria-valuetext` and live regions are asserted in
  tests; nothing was tried with NVDA or VoiceOver.
- **Not built (out of scope):** prices on the plan page (missing contract), tier switching and proration, priority
  support, QR, transcription, new media features.

## Remaining product decisions

- Premium pricing, and a pricing contract (amount, currency, interval per offering) before any price is shown.
- Tier switching and proration (Checkout versus Customer Portal) and the Portal's product configuration.
- Legacy `monthly` / `annual` subscriptions: which tier, if any. Not backfilled.
- The unresolved-price policy (still interim).
- Grandfathered accounts that subscribe.
- What "priority support" means operationally. Not advertised.
- Final badge and dialog copy ("Premium" / "Complete" by lowest including tier).
- The sandbox payment blocker above, before any claim that payments work.

# For After — Free trial, billing and subscriptions (Step 10)

| | |
|---|---|
| **Status** | Built locally 2026-10-31, **disabled by default** (`BILLING_ENABLED` unset). Verified with Stripe **mocked** (real signature check, fake API calls). Never run against Stripe, never deployed, no plans published. |
| **Backend** | `src/billing/` (`BillingModule`, global): `GET/POST /billing*`, `POST /webhooks/stripe`, `GET /admin/billing/accounts` |
| **Frontend** | `/settings/plan` (`components/account/plan.tsx`), Account settings "Plan" card, shell notice and blocker; admin `/admin/billing`, Users "Plan" column/panel |
| **Provider** | Stripe, Node SDK `stripe@23.1.0` (API version `2026-10-28`), hosted Checkout + Customer Portal |

## 1. Decisions

**Confirmed (2026-10-31, product owner):** Stripe is the provider; the trial is **app-run and card-free**; it lasts
**7 days**; when access ends the Customer is pointed to the plan page to buy a paid plan (a notice on every page, never
a redirect away from their own content: see the reading and deleting rule below).

**Applied as conservative defaults (change only by decision):**
- Existing accounts: accounts created before `BILLING_ENFORCE_FROM` are **never restricted** and get no trial
  ("No billing record"). No account is changed by rollout.
- What "access ended" restricts: creating/changing content, uploads and the AI companion (POST/PUT/PATCH on the
  routes in §3). Reading, deleting your own content, account settings, the plan page, support, logout and the
  safety-notice answer stay open. Nothing is deleted, published or released early.
- Paid access lasts while Stripe says `active`, `trialing` or `past_due` **and** the paid period has not ended
  (`past_due` = "Payment issue", access kept until the period ends; Stripe's own retry/dunning settings decide what
  happens next). `incomplete` grants nothing.
- Admin billing visibility: **SUPER_ADMIN only** (page, and the Users summary).

**Still open (needed before launch):** prices and currency (configured in Stripe, not in code); whether both monthly and
annual plans are offered; paid plan feature or storage differences (every paid state keeps the single
`STORAGE_LIMIT_BYTES`; the trial's own restrictions are §8); subscription after death (`PROJECT_OVERVIEW.md` §40, "must be finalised before production");
content retention after access ends; Stripe dunning settings; billing visibility for ordinary ADMINs; tax and invoicing.

## 2. Configuration (names only; set values in the host's secret store)

| Name | Meaning |
|---|---|
| `BILLING_ENABLED` | `true` turns billing on. Unset/anything else: no trial, no checkout, no webhooks (503), nothing restricted |
| `BILLING_ENFORCE_FROM` | ISO instant, **required** when enabled; only accounts created at/after it are subject to billing |
| `STRIPE_SECRET_KEY` | `sk_test_…` (test) or `sk_live_…` (live); its mode must match every event |
| `STRIPE_WEBHOOK_SECRET` | the endpoint's signing secret (`whsec_…`) |
| `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL` | Stripe price ids; a plan is offered only when its price is set |
| `BILLING_AFTER_DEATH_POLICY_APPROVED` | `true` only once §7 is decided and built. With `BILLING_ENABLED=true` and a live key the API **refuses to start** without it; test mode and billing off are unaffected |
| `FRONTEND_URL` (existing) | the first origin builds the fixed return URLs `/settings/plan?checkout=success|cancelled` |

## 3. Access states (`src/billing/billing-access.ts`, one definition everywhere)

`no_billing_record` (billing off, or a pre-enforcement account: access) · `trial_available` (new account, nothing
started: no access) · `trial_active` · `trial_expired` · `paid_active` · `cancellation_scheduled` (access until period
end) · `payment_issue` (access until period end) · `payment_pending` (no access) · `access_ended`. A paid period wins
over a trial; an unknown Stripe status or a missing period is never treated as paid. Time is compared at request time
(`endsAt > now`), so expiry needs no job; there is no expiry worker.

**Gate** (`BillingAccessInterceptor`, global, after the route guards): `POST`/`PUT`/`PATCH` by a Customer on a controller
marked `@RequiresPlan()` → **402** "Your free trial or plan has ended. Choose a plan to continue." Marked: messages (and their
media and schedule), memory vault, My Story, My Wishes (prompts, disclaimer, songs), recipients, trusted contacts, the
assistant, `users/me/drafts`. The decision reads the matched route's metadata, not the URL (Express routes
case-insensitively). Never gated: reads, `DELETE`, `/auth`, `/users/me` (profile, password, email, storage view), `/billing`,
`/support`, `/death-verification/me/confirm-alive`, every Recipient/Trusted Contact/admin route, and the worker (message
release, death-triggered activation, notifications). A database error during the check fails the request (never
grants access).

**Frontend (UX only):** without access every page stays open under a compact notice (viewing, download, delete; Step 6
copy below); pages whose only purpose is adding or changing content (`…/new`, `…/edit`, `…/create-message`) explain
instead, with "View it read-only" / "Back to the list" and no redirect, and links to them open the plan dialog. A
refused write shows the API's message, "This wasn't saved. What you typed is still here." and "View plans" where it
failed. If the plan cannot be read nothing is hidden and the shell says so ("Check plan again").

## 4. Trial, checkout, webhooks

- **Trial** `POST /billing/trial`: Customer session (sign-in already requires a verified email); billing enabled; the
  account is subject to billing and has no trial or subscription. The server sets `startedAt = now`,
  `endsAt = now + 7 days`; the body is ignored. `CustomerTrial.userId` is unique: concurrent or repeated requests return
  the one trial (an expired trial is returned as expired, never restarted). One trial **per account**, not per person.
  Audited `TRIAL_STARTED`. A GET or page visit never starts a trial.
- **Checkout** `POST /billing/checkout { plan: monthly|annual }`: the plan key maps to the configured price id (no price,
  amount or currency from the client); refused while a paid subscription is active. The Stripe customer is created
  server-side once per account (`BillingAccount.stripeCustomerId`, idempotency key `customer-<userId>`) and is the
  trusted mapping for all events; Checkout uses idempotency key `checkout-<userId>-<plan>-<hour>`. Return URLs are fixed.
  The success URL only shows "Confirming your subscription" (bounded re-checks, then Refresh); it grants nothing.
- **Portal** `POST /billing/portal`: Stripe's Customer Portal for an account with a subscription (cancel, payment details).
- **Webhook** `POST /webhooks/stripe` (no session; `rawBody` enabled in `main.ts`): `Stripe.webhooks.constructEvent`
  over the raw body; missing/invalid signature 400; `livemode` must match the key's mode (400 otherwise). Handled:
  `checkout.session.completed`, `customer.subscription.*`, `invoice.*`. The customer must be one this app created (else
  acknowledged and ignored). The event's subscription must belong to that customer (400 otherwise, not recorded).
  **Selection:** every subscription of the customer is re-read from Stripe and the account holds the best one: active,
  then active but cancelling, then past due (all within their paid period), then incomplete, then anything else; ties go to
  the later period end, then the newer subscription. So duplicate, late and out-of-order events, and events for a replaced
  subscription, converge on the current state. An event about another subscription that changes nothing returns
  `{ superseded: true }`, is recorded in `StripeEvent` and logged (`billing_webhook_superseded`), with no audit row.
  **Concurrency:** `syncedAt` is read before the Stripe fetch and is the version the write is conditional on (strictly
  increasing); if another sync committed meanwhile, this one holds possibly older data, rolls back and reads Stripe again (3
  attempts, then 503 so Stripe retries). The event id, the new state and an audit row (`SUBSCRIPTION_SYNCED`, actor
  `SYSTEM`: previous/new status, plan, cancel flag, `eventSubscriptionCurrent`, `subscriptionReplaced`) commit in one
  transaction, so a row means the update applied; a duplicate returns `{ duplicate: true }`. If the Stripe fetch or the
  database fails, nothing is recorded and a non-2xx makes Stripe retry. Stored: customer/subscription ids, plan key, status,
  cancel flag, period end, sync time. Never stored: payloads, card or payment details, emails, invoices.
- **Outages**: Stripe down → checkout/portal fail honestly, webhooks retried by Stripe, access unchanged (the last
  verified state stands until its own period end). Database down → gated writes fail (never granted).

## 5. Rollout (separately authorised)

1. `prisma migrate deploy` (migration `20261031120000_add_billing`, additive; old API/worker versions ignore the new
   tables; the new enum values are only written by the new API).
2. Create products/prices and the webhook endpoint in Stripe **test** mode; set the variables above with test values on
   a preview environment; run a real test-mode checkout, cancellation and payment failure; confirm the webhook path.
3. Decide the open items in §1 and §7, then set `BILLING_ENFORCE_FROM` to the launch instant (existing accounts stay
   unrestricted) and `BILLING_ENABLED=true`. Live keys only after the test-mode run is signed off.
4. WordPress links to the app's existing sign-up; it never grants access, shares credentials or reads app tables.

## 6. Admin

`/admin/billing` (Management → Subscriptions & payments, shown to SUPER_ADMIN only) over `GET /admin/billing/accounts`
(admin role + MFA, then SUPER_ADMIN, else 403; `no-store`): accounts with a trial or a billing record; filter `state` is one
of the displayed states (trial_active, trial_expired, paid_active, cancellation_scheduled, payment_issue, payment_pending,
access_ended) and returns exactly the accounts showing it (`accessStateWhere`, `accessState()` as a query; an e2e compares
the two over every combination); also `plan`, exact account or `sub_…` reference, account-created range (≤ 366
days); newest first with id tie-breaker. Since 2026-11-09 the response also carries `summary` = `accounts` (listed
accounts in scope: every filter except `state`), `verified` (those with a stored Stripe `syncedAt`) and `states` (each
account once, by `accessStateWhere` for the seven filter states, and for the rest `trial_available` vs `no_billing_record`
by the enforcement rule), all in one REPEATABLE READ snapshot with the page; reading never calls Stripe. Admin → Users list/detail carry a `billing` summary only for SUPER_ADMIN
viewers (same function). Read-only: no refunds, charges, extensions, complimentary access, price or key editing, no
portal or invoice links.

## 7. Open decision: subscriptions after a verified death, and during suspension

**Today nothing touches Stripe when an account changes status.** `DeathVerificationService` sets `User.status = PASSED` when
an admin verifies a death (VERIFIED is final, never reopened), and suspension is reversible; neither calls billing. A
subscription therefore keeps renewing and charging the card until Stripe's own dunning ends it. Refund, proration and
notice rules are not defined anywhere (`PROJECT_OVERVIEW.md` §40: "must be finalised before production").

**The owner must decide:**
1. Verified death: cancel at once, cancel at period end, or keep billing until someone asks? Is any charge after the verified
   date of death refunded (`verifiedDeathAt` can predate the verification by weeks), and to whom is that communicated?
2. Suspension (an account-security state, may be lifted): keep billing, pause collection, or nothing? It need not match 1.
3. An open, unverified report: normally nothing should change, because the person may be alive.

**Technical options once decided (not built):**
- A. Cancel at period end on VERIFIED: no refund logic; at most one further charge is avoided, none is reversed.
- B. Cancel immediately on VERIFIED: stops renewals now; a refund rule is still a separate decision.
- C. Manual: list PASSED accounts with a live subscription on the admin billing page; an operator acts in Stripe.

**Any automatic action must be durable and must not make the verification transaction depend on Stripe:** a row written in
the same transaction as the status change (an outbox, or the existing queue's reconciler pattern), processed by the worker
with a Stripe idempotency key per case (`after-death-<caseId>`), retried with backoff, dead-lettered through the existing
mechanism, and audited; the resulting webhook then syncs through the normal path above.

**Prerequisite in code:** with `BILLING_ENABLED=true` and a live key the API refuses to start until
`BILLING_AFTER_DEATH_POLICY_APPROVED=true`. Test-mode environments and billing-off environments are unaffected.

## 8. Trial restrictions (revised policy, built in steps)

**Confirmed requirements (product owner):** 7 days; 100 MB = 100,000,000 bytes; one recipient and one trusted contact;
text-only messages; four text questions combined across My Story and My Wishes (Step 5), plus one text memory in the
Memory Vault (Step 7); Wishes media and content
media paid-only; after expiry creation/editing locked, view/download/delete open; paid access wins; billing-off and
grandfathered accounts unchanged; nothing deleted automatically.

**Step 2 (2026-11-12): entitlements and the storage allowance. Built locally; billing still disabled by default.**
- `entitlements(access, configuredStorageBytes)` in `billing-access.ts`: pure, kept apart from access (`hasAccess`,
  the gate). An enforced `trial_active` gets `TRIAL_STORAGE_BYTES` (100,000,000); every other state keeps
  `STORAGE_LIMIT_BYTES`. No state is unlimited. `accessState()`, its SQL and Prisma-filter forms are unchanged.
- `billingPolicy()` reads `BILLING_ENABLED` / `BILLING_ENFORCE_FROM` for `BillingService` and `StorageQuota`, the only
  two readers, both in the **API** process (`MediaModule` imports no `BillingModule`, and `reserve()` resolves the
  allowance through its own transaction). The **worker** (`QueueWorkersModule`) constructs neither, so it reads no
  billing settings and has no new startup requirement. `BILLING_ENFORCE_FROM` is required only when `BILLING_ENABLED`
  is exactly `true`; then a missing, blank or unparseable value stops the API at startup with
  "BILLING_ENFORCE_FROM must be an ISO date when BILLING_ENABLED=true." Any other value (unset, `false`, `TRUE`) is off.
- Storage: `media-storage.md` §5. The allowance is never taken from the request.
- Frontend: storage card and Storage Manager show a decimal-MB limit in decimal units ("… of 100.0 MB used"); the 5 GiB
  default display is unchanged. No new API field: `GET /users/me/storage` `limitBytes` carries the allowance and
  `GET /billing` already carries the state and trial dates.

**Step 3 (2026-11-12): one Recipient and one Trusted Contact during an enforced active trial. Built locally.**
- `creationCaps(access)` (also part of `entitlements()`): `{ recipients: 1, trustedContacts: 1 }` only for an enforced
  `trial_active`; otherwise `null` (no trial cap). Paid wins over trial dates; billing off and pre-enforcement accounts
  get no cap; states without access are refused earlier by the gate (402), unchanged.
- Enforced on the only two creation paths (`RecipientsService.create`, `TrustedContactsService.create`; there is no
  restore path, a deleted row is never revived). Billing on: `SELECT … FROM "User" … FOR UPDATE`, then `trialCap()`
  (`resolveAccess()` reads the billing rows through that transaction), then the live count, then the insert, so parallel
  requests serialise. Billing off: recipients take no lock (unchanged); contacts keep their existing lock.
- **What counts:** every live (not soft-deleted) row. Contacts count whatever their invitation: none sent, `PENDING`,
  `ACCEPTED`, `DECLINED`, or a `CANCELLED`/expired latest invitation. Deleting frees the slot (normal delete rules).
  Editing, and sending or resending an invitation (its own limits unchanged), never create a row.
- **Order for contacts:** the existing two-contact maximum is checked first (same 409 `MAX_REACHED`, no plan offer: no
  plan allows a third); then the trial cap. The refusal happens before any row or invitation exists.
- **Error:** `409 { statusCode, error: 'Conflict', code: 'TRIAL_LIMIT', message }` (`trialLimitError`). Distinct from
  validation (400), authorization (401/403/404) and no access (402). Existing excess records are never deleted, hidden
  or locked: they stay listed, editable and deletable; only new creation is refused while at or over the cap.
- `GET /billing` adds `trialCaps` (same `creationCaps()`); the app counts with the live lists. Frontend: People I Love
  and Trusted Contacts header controls show **Pro** once the cap is used and open a dialog ("View plans" →
  `/settings/plan`, "Close"); `/people/new` and `/trusted-contacts/new` opened at the cap explain instead of a form (the
  decision is frozen when the page first has its data, so a refetch never discards typing); a stale form refused with
  `TRIAL_LIMIT` keeps its input and links "View plans". The empty-state and message-form "Add someone you love" links
  only appear with no one added (the first is always allowed). Never shown when `trialCaps` is null.
- **Death verification:** no conflict. A new case needs `min(people able to confirm, 2)` confirmations
  (`requiredConfirmationsFor`), so a one-contact account needs one, exactly as for any paid account with one contact.

**Step 4 (2026-11-13): text-only messages and paid-only media during an enforced active trial. Built locally.**
- `featureAccess(access)` (part of `entitlements()`): `{ media: false }` only for an enforced `trial_active`; paid,
  billing off and pre-enforcement keep media. `PaidFeatures` (`src/billing/paid-features.service.ts`, provided by
  `MediaModule`, reads `billingPolicy()` itself, billing off reads nothing) is the one server check: `mediaAllowed()` /
  `assertMedia()`.
- **Refused (409 `code: PAID_FEATURE`, `paidFeatureError`):** creating a message in any non-text format; changing a
  message, or restoring a version, to a non-text format it doesn't have now; message, Memory Vault, My Story and My
  Wishes upload URLs (checked in the transaction before any reservation, row or signed upload); conversions (memory /
  story / wish → message, `MessageSnapshotService`) that copy files or set a non-text format. A text-only conversion is
  allowed.
- **Unchanged:** written text everywhere; no message-count limit; existing files stay listed, viewable and deletable;
  text edits to a paid-era photo message keep its format and files.
- **Upload lapse:** an upload signed while media was allowed but completed after it ended (trial still running) is
  removed on completion (row soft-deleted, reservation freed, file purged by normal cleanup), never scanned or READY.
- Recipient photos are **not** gated (approved 2026-11-14, decision 4: allowed within the trial's 100 MB).
- `GET /billing` adds `features` (`featureAccess()`). Frontend: media controls (MediaManager add/upload/record) and
  non-text message formats show **Pro** and open "Available with a paid plan" (View plans / Close, focus returns);
  a message keeps its own pre-trial format selectable; content-to-message in a trial is text-only with one Pro
  control for files; an unreadable plan shows a quiet "Check plan again" status and the API still decides; a stale
  page refused with `PAID_FEATURE` shows the message + View plans and no Try again; refused saves keep the form.
- **Verified:** backend `tsc`, oxlint, unit 26 files 780/780; e2e (isolated DB/Redis) new `trial-media` 11/11 plus
  `trial-storage`, `trial-people`, `messages`, `media`, `memory-to-message`, `memory-vault`, `my-wishes-rich`,
  `billing`: 9 files 114/114; frontend 13 files 224/224 (incl. new `trial-media.test.tsx` 10/10), `tsc`, eslint.

**Step 5 (2026-11-14): four text questions, My Story and My Wishes combined, during an enforced active trial. Built
locally.**
- `creationCaps()` adds `questions: TRIAL_QUESTIONS` (4) only for an enforced `trial_active`; otherwise `null`. Paid wins
  over trial dates; billing off and pre-enforcement accounts get no cap; expired / not started stay 402 at the gate.
- **What counts (`answeredQuestions()`, one SQL count over both tables):** live (`deletedAt IS NULL`) `MyStoryResponse`
  and `MyWishResponse` rows whose `textContent` has a non-whitespace character (`hasAnswerText()`, the DTOs' `/\S/`
  rule). One per question (each table is unique per owner and prompt). Not counted: files-only or memory-only answers,
  empty upload shells, unsaved drafts (`DraftRecovery`), private notes, Memory Vault items.
- **Enforced in the two answer saves** (`MyStoryService.save`, `MyWishesService.save`; the only paths that write answer
  text: upload shells (`liveResponseId`/`liveWishId`) never set text and media is paid-only in the trial (Step 4); drafts,
  conversions to messages, readiness and portals only read). Billing on: `lockAnswerEntitlements()` takes
  `SELECT … FROM "User" … FOR UPDATE` first, then `trialCap()`, then `assertQuestionSlot()`, in the save transaction,
  so parallel saves in either section serialise. Billing off: no lock, nothing read (unchanged).
- **Rules:** giving words to a question that has none needs a free slot; editing, re-saving or adding a note to an
  answer that already has words never does (so accounts already above four keep editing theirs). Clearing the words
  (`textContent: null`, only possible while files or memories keep the answer non-empty) frees the slot and keeps the
  files and links; deleting an answer frees it (normal delete rules: its own files and links only, never the memories).
  A freed slot can be used by any question in either section.
- **Memory links (corrected 2026-11-14 close-out):** `featureAccess().memoryLinks` is false only in an enforced active
  trial. A save whose `memoryVaultItemIds` contains any memory not already linked to that live answer (a new link, a
  replacement set, a link on a new or memory-only answer) is refused with 409 `code: PAID_FEATURE`,
  `PAID_MEMORY_LINK_MESSAGE`, before any write (text sent in the same request is not saved either). Allowed: a set that
  keeps or removes current links (ids compared case-insensitively), text saves with or without the unchanged set,
  unlinking, reading and deleting. Memories and files are never deleted by any of these. Paid, billing-off and
  grandfathered accounts link as before. Frontend: "Choose from Memory Vault" (workspace) and "Link a memory" (answer
  page) show **Pro** and open "Available with a paid plan"; linked memories keep Unlink.
- **Error:** `409 { statusCode, error: 'Conflict', code: 'TRIAL_LIMIT', message: TRIAL_QUESTION_LIMIT }` before any row
  changes (the transaction rolls back).
- `GET /billing` adds `questionsAnswered` (same count; always present) beside `trialCaps.questions`. Frontend: "X of 4
  trial questions answered" on My Story (workspace) and My Wishes (list) and both answer pages; at the cap, cards and
  the workspace editor of questions with no saved words show **Pro** and open the shared dialog ("Answer more questions
  with a plan", View plans / Close). A files-only answer still opens (its files stay viewable/deletable). A form already
  open, or with typing, is never swapped for the lock; a stale save refused with `TRIAL_LIMIT` keeps the text and shows
  View plans (the refusal re-reads the plan). Saves and deletes re-read `GET /billing`, so a freed slot unlocks both
  sections. Unknown plan is never treated as unlimited: a **new** answer shows "Checking your plan…" while loading and
  "We couldn’t check your plan just now" + "Check plan again" if it can't be read, instead of the answer box; saved
  answers stay editable, read and delete stay open, the list cards stay links and the API still enforces. Never shown
  when `trialCaps.questions` is null.
- **Memory Vault: pending.** No question model; its items are not counted and no limit was invented. Its trial
  text-entry allowance awaits a product decision (open decision 1). Step 4's paid-only vault media is unchanged.

- **Verified (2026-11-14 close-out, fresh runs):** backend `tsc`, oxlint; unit 1597/1597 (76 files); isolated e2e 11
  files 108/108; frontend 833/833 (58 files), isolated source typecheck, eslint; isolated production `next build`
  (Turbopack) and its generated-route types; isolated browser run 14/14. Full report:
  [`trial-step-5-closeout.md`](trial-step-5-closeout.md).
- Billing activation: the code default is off; the local development `.env` has `BILLING_ENABLED=true` and
  `BILLING_ENFORCE_FROM=2026-11-12T11:24:49Z` (read 2026-11-14, unchanged by Step 5), so accounts created after that
  date are enforced on the local API. Deployed environments were not checked.

**Step 6 (2026-11-14): expired trial, read-only access and the upgrade experience. Built locally.**
- **Server (unchanged rules, one new field):** the existing gate (`BillingAccessInterceptor`, §3) decides every gated
  write at request time from the central resolver (`BillingService.writeAccess()` → `accessState()`, server time; a
  trial ends exactly at `endsAt`). A form opened before the end and sent after it is refused. The 402 keeps its message
  and adds a stable `code` (`noAccessCode()`): `TRIAL_EXPIRED`, `TRIAL_NOT_STARTED`, `PAYMENT_PENDING`, `PLAN_ENDED`
  (fallback `PLAN_REQUIRED`). Paid wins over ended trial dates; billing off and grandfathered accounts are never gated;
  "Start free trial" never restarts or extends an ended trial (it returns the same ended state).
- **Audit (all customer write controllers):** gated (`@RequiresPlan`, POST/PUT/PATCH → 402): messages (create, edit,
  version restore), message media uploads, schedules (create, change), recipients (create, edit, photo upload),
  trusted contacts (create, edit, send/resend invitation), My Story (answers, private notes, memory links, share as a
  message), My Wishes (answers, notice acknowledgement, songs: add/edit/reorder, share as a message), Memory Vault
  (create, edit, media, share as a message), draft autosave (`users/me/drafts`), the AI companion. Never gated: reads,
  media access URLs (downloads), every `DELETE` (including unscheduling), `/auth` (sign-out), `/users/me` (profile),
  communication preferences, `/billing`, `/support`, confirm-alive. Workers, releases, grants and death verification are
  untouched.
- **Ambiguous at the time; all four approved in Step 7 (see below):** (1) draft autosave is a gated write, so after expiry new typing is not
  autosaved; it stays in the open form and the leave-page warning still applies (no new local storage was added).
  (2) Unlinking a memory from a My Story answer is a `PUT` and is refused; deleting the whole answer is allowed.
  (3) Unscheduling (`DELETE …/schedule`) stays allowed, so an expired customer can stop a scheduled release but not
  reschedule it. (4) Trusted-contact invitation resends are refused (a write).
- **Frontend:**
  - Compact notice on content pages: **"Your free trial has ended"** / "Choose a plan to keep creating and editing. You
    can still view, download and delete your existing content." / **View plans** (`/settings/plan`). Other states keep
    their own accurate copy: trial not started, payment pending, plan ended.
  - Create/edit controls open the shared plan dialog (View plans / Close): links to `…/new|edit|create-message`
    (intercepted in the shell), media add/record, the My Story "Add media" and memory picker, linking memories,
    schedule and change timing, restore version, recipient photo, invitations, song add/edit (reordering is hidden).
  - Saved My Story / My Wishes answers open read-only (Edit answer → dialog; Delete answer stays); a new question
    offers "Write your answer" → dialog.
  - Opening a message shows the prompt once per visit (View plans / Continue viewing); it never reopens on refetch.
  - A form already open stays open when the plan changes; a refused save says it wasn't saved and keeps the text; it
    is never resubmitted. Autosave refused with 402 says changes aren't kept automatically and stops retrying.
  - The plan is re-read when an active trial ends (one timer), on window focus (query default) and after any refused
    write; the plan page's existing checkout-return checks are unchanged (a success URL grants nothing). With no plan
    on sale (Stripe or prices not configured) the plan page says so and points to support.
  - The shell renders one stable tree, so a page is never remounted when the plan loads or changes.

- **Verified (2026-11-14, fresh):** backend `tsc`, oxlint; unit 1599/1599; isolated e2e 17 files 199/199 (new
  `trial-expired` with a controlled clock: 1 ms before, at and after `endsAt`); frontend 853/853, isolated source
  typecheck, eslint; isolated production `next build` and its route types; isolated browser 14/14 at 1280 and 390 px.
  Report: [`trial-step-6-report.md`](trial-step-6-report.md).

**Step 7 (2026-11-16): approved policy refinements and consistent restriction UI. Built locally.**
Five decisions **approved** by the product owner (2026-11-16):
1. **Unsaved drafts after expiry (approved):** server autosave stays gated (402). The words stay in the open form; the
   app also keeps a temporary copy in the browser tab (`sessionStorage`, `src/lib/local-drafts.ts`, key
   `for-after:unsaved:<userId>:<type>:<key>`), labelled **"Not saved to your account."** and described as temporary
   ("it may disappear when you close the tab"). It is removed on sign-in as another account, on sign-out and on session
   expiry (a 401, all via `resetPrivateCache`), on Discard, after a successful server autosave or the explicit Save, or
   when it matches the saved text; the browser drops it when the tab closes. While editing is open, reopening the
   editor offers it like a recovered draft; Restore fills the form and sends nothing (Save is still the Customer's
   action). **While read-only** (no write access) the answer page, the My Story workspace, the message page (an edit)
   and the Messages list (a new message) show "Unsaved draft in this tab" with **View unsaved draft** (exact text,
   read-only) and **Discard**; viewing enables no editing, restoring or saving. No browser-local layer existed before;
   this is the minimum needed and promises no permanent storage.
2. **Unlinking memories after expiry (approved):** new `DELETE /my-story/prompts/:promptKey/response/memories` with
   `{ memoryVaultItemIds }` (1–100 unique UUIDs, `RemoveMemoryLinksDto`; any other field is a 400 from the global
   whitelist). DELETE is never gated, so it works with no write access; `PUT …/response` stays gated (402) for every
   change, including one that only removes links. Every id must be linked to that live answer now (case-insensitive),
   else 400 `One or more memories are not linked to this answer.` One transaction: a bad id, or an answer that would be
   left empty, changes nothing. Removes link rows only (memories, their files and the text untouched); ownership by
   session; activity `STORY_RESPONSE_UPDATED`. The app's Unlink always uses it.
3. **Unscheduling after expiry (approved, unchanged code):** `DELETE /messages/:id/schedule` stays open with its existing
   rules and release race protection; `POST`/`PATCH …/schedule` stay 402. Released content and worker safeguards
   untouched.
4. **Trusted-contact invitation resends (approved, unchanged code):** `POST /trusted-contacts/:id/invitation` stays 402
   after expiry; accepted contacts and death-verification confirmation rules are unchanged.
5. **Memory Vault in an active trial (approved):** `creationCaps()` adds `memories: TRIAL_MEMORIES` (1) only for an
   enforced `trial_active`; null otherwise. `MemoryVaultService.create` (the only creation path: there is no copy,
   restore or import of memories; conversions create messages, uploads attach to an existing memory) takes
   `SELECT … FROM "User" … FOR UPDATE`, then `trialCap(…, 'memories')`, then counts **every live memory** and refuses
   at or over the cap with 409 `TRIAL_LIMIT` / `TRIAL_MEMORY_LIMIT` before any row. Separate from the four questions.
   Editing (`PATCH`) takes no slot, so existing excess memories stay readable, editable (while access lasts) and
   deletable; deleting frees the slot. Media stays paid-only (Step 4); after expiry the 402 comes first (Step 6). Nothing
   is stripped or deleted. Paid, billing-off and grandfathered unchanged. `GET /billing` adds `memoriesSaved` (same
   live count) beside `trialCaps.memories`.
- **Frontend consistency:** Memory Vault shows "X of 1 trial memory used", and "Save a memory" becomes the shared
  **Pro** button + dialog ("Save more memories with a plan", View plans → `/settings/plan`, Close; Escape returns focus)
  at the cap; `/memory-vault/new`, `/people/new` and `/trusted-contacts/new` share `useCreateGate`/`CreateGateNotice`:
  locked → explanation + View plans + back; plan loading → "Checking your plan…"; unreadable → no form (the shell's
  single "Check plan again" retries). Decided once, so a refetch never removes an open form. Inside the shell, page-level
  plan checks no longer repeat the shell's "Check plan again" (`ShellShowsPlanCheck`).
- Verified: see [`trial-step-7-report.md`](trial-step-7-report.md) (including the close-out). **Sandbox Checkout →
  signed webhook → entitlement → UI unlock was not verified: blocked** (no Stripe test keys, prices or webhook secret
  in the local `.env`; Stripe CLI not logged in).

**Not built yet:** nothing from the trial-restrictions list; Step 8 is the final validation.

**Open decisions:**
1. ~~Memory Vault's trial allowance?~~ **Approved (2026-11-16, Step 7):** one live text memory, separate from the four
   questions.
2. ~~Does deleting an answer free a slot?~~ Decided (Step 5): yes, live count.
3. Trial accounts already over a limit: keep everything (required). Recipients/contacts (Step 3) and answers (Step 5):
   excess stays editable and deletable; only new records/questions are refused.
4. ~~Recipient photos during the trial?~~ **Approved (2026-11-14):** allowed within the trial's 100 MB allowance, with
   their existing privacy, scanning and validation safeguards (ungated since Step 4; quota verified by `trial-storage`).
5. Trial start: today only by "Start free trial" (`trial_available` has no access until then); automatic at sign-up or
   verification instead?
6. ~~Does a memory-link-only My Story answer count as a "text question"?~~ Decided (Step 5): no; new memory-only
   answers are refused in the trial, existing ones kept.
7. AI companion, songs, scheduling and private notes during the trial (unchanged for now).
8. Error contract for "needs Pro": Step 3 uses 409 + `code: 'TRIAL_LIMIT'`; later steps should reuse it unless decided
   otherwise.
9. A trial account with one trusted contact needs one confirmation per death report (see Step 3): confirm this is the
   intended safeguard level for trial accounts, or whether trials should allow two contacts.

## 9. Updated plans: Free Trial, Premium, Complete (built in steps)

**Step 2 (2026-11-16): tier and entitlement foundation. Built locally. No customer-visible behaviour changed.**

Four separate concepts (`src/billing/billing-access.ts`):
- **Access state** (§3, unchanged): whether the account may write now (`hasAccess`). Paid precedence, trial start,
  duration and expiry, and the expired read/download/delete rules are unchanged.
- **Product tier** `ProductTier` = `FREE_TRIAL` | `PREMIUM` | `COMPLETE` (`PRODUCT_TIERS`).
- **Billing interval** `BillingInterval` = `monthly` | `annual` (`BILLING_INTERVALS`, the existing stored values).
- **Exemption** `billing_off` | `grandfathered`: not a tier.

An interval never decides a tier, and a tier never grants write access.

**Plan definitions** (`PLAN_DEFINITIONS`, the one source of these numbers; decimal bytes):

| | Free Trial | Premium | Complete |
|---|---|---|---|
| `storageBytes` | 100,000,000 | 2,000,000,000 | 5,000,000,000 |
| `recipients` / `trustedContacts` | 1 / 1 | 10 / 2 | 50 / 2 |
| `answeredQuestions` (My Story + My Wishes) | 4 | no limit | no limit |
| `memoryVaultEntries` | 1 | no limit | no limit |
| `contentMedia` (new) | none | PHOTO, AUDIO | PHOTO, AUDIO, VIDEO |
| `memoryLinks` (new/replacement) | no | yes | yes |
| `aiRequests` (successful, shared) | 5 per trial | 50 per month | 200 per month |
| `support` | standard | standard | priority (no response-time promise) |

Monthly and annual subscriptions to the same tier have identical definitions (annual still means a monthly AI
allowance). The `TRIAL_*` constants used by Trial Steps 2–7 now read from the Free Trial row; their values are
unchanged.

**What is enforced today: declared ≠ enforced.** `PLAN_IN_EFFECT` lists, per tier, the fields the server applies now:
- **Free Trial:** everything except `aiRequests` and `support` (Trial Steps 2–7).
- **Premium and Complete:** only where today's general paid behaviour already equals the definition. That is the
  two-contact maximum, no question or memory count, links allowed, and for Complete every media kind.
- **Not applied for any tier yet (as of Step 2):** paid storage (paid accounts still got `STORAGE_LIMIT_BYTES`), paid
  recipient counts, Premium's no-new-video rule, AI allowances (only the hourly Redis limit exists) and support
  priority. Paid storage and recipient counts were applied in Step 3 (below).
- `entitlements()`, `creationCaps()` and `featureAccess()` were **not** wired to paid tiers, so no restriction starts
  early.

**Persistence.** Migration `20261116120000_add_billing_paid_tier` adds enum `PaidTier` (`PREMIUM`, `COMPLETE`) and a
nullable `BillingAccount.tier`.
- Additive: no row is changed or backfilled.
- `BillingAccount.plan` keeps holding the interval (`monthly` / `annual` / `unknown`) for existing contracts.
- Nothing writes `tier` yet: Checkout and the webhook price mapping are a later step.
- The trial is not stored as a tier (it comes from `CustomerTrial`).

**Resolution (`planTier()`), from the access state:**

| Account | Result |
|---|---|
| Billing off | exemption `billing_off`, no tier |
| Created before enforcement | exemption `grandfathered`, no tier (even with a subscription) |
| Enforced active trial | `FREE_TRIAL`, mapping `trial` |
| Paid state with a stored tier | that tier, mapping `mapped` |
| Paid state with no stored tier | tier `null`, mapping **`unmapped`** |
| No access (trial expired, not started, payment pending, plan ended) | no tier |

The interval is reported separately, and only for a recognised stored value.

**Legacy and unmapped subscriptions.** A paid subscription with no stored tier is reported truthfully as
`unmapped`. It is never assigned Premium or Complete, and keeps exactly today's paid behaviour (access, configured
storage, no caps, all media). This is a compatibility rule for existing rows only. **How a newly encountered unknown
Stripe price should map is a pending decision**, not settled by this.

**SQL and Prisma access-state forms** (`accessStateSql`, `accessStateWhere`): unchanged. The tier is a stored column,
not part of the access state, so there is nothing to mirror. Their agreement with `accessState()` is still checked by
the billing e2e.

**API (additive).** `GET /billing` adds `productTier`:
```
{ tier, interval, exemption, mapping, definition, inEffect, notYetEnforced }
```
`definition` is the tier's row or `null`. `inEffect` and `notYetEnforced` partition its fields. Every existing field
is unchanged. The frontend does not read `productTier` yet.

**Running environments.** Apply the migration before the API uses this code, because the new `tier` select would
fail on a database without the column:
```
npx prisma migrate deploy
```
Verified on the isolated test database only. The development database was not migrated by this step.

**Step 2 close-out (2026-11-16).**
- `test/admin.e2e-spec.ts` now sets `BILLING_ENABLED=false` itself (and removes it afterwards). Its Customers write as
  un-gated accounts and its billing assertions don't depend on enforcement.
- It no longer inherits the developer's `.env`, which made it fail at setup (402) once local billing was enabled.
- The guards and the app's assertions are unchanged.

**Step 3 (2026-11-16): paid storage and recipient limits. Built locally.**

An **entitled mapped tier** is enforced; nothing else changes. That means an enforced account, in a paid state
(`paid_active`, `cancellation_scheduled` or `payment_issue`), with a stored `BillingAccount.tier`
(`entitledPaidTier()`):

| | Premium | Complete |
|---|---|---|
| Storage | 2,000,000,000 bytes | 5,000,000,000 bytes |
| Live recipients | 10 | 50 |

Trusted contacts stay at 1 in the trial and 2 at most otherwise; death-verification rules are unchanged.

**How it is enforced:**
- `resolveAccess()` now returns `paidTier`, read inside the caller's transaction.
- `entitlements().storageBytes` uses `PLAN_DEFINITIONS[paidTier]`, so `StorageQuota.reserve()` and `usage()` (every
  upload, conversion and recipient-photo path, and `GET /users/me/storage`) apply it with the existing User row lock.
- `recipientLimit()` returns `{ max, source }`: `trial` gives 1, `plan` gives 10 or 50, and `null` means no limit.
  `RecipientsService.create` locks the User row, resolves the limit, counts live recipients and inserts, all in one
  transaction.
- `creationCaps()` (the trial-only `trialCaps` in `GET /billing`) and `featureAccess()` are unchanged, so the trial UI
  never shows trial copy to a paid customer.
- `PLAN_IN_EFFECT` now includes `storageBytes` and `recipients` for both paid tiers.

**Unchanged:**
- **Trial:** 100,000,000 bytes, 1 recipient, `TRIAL_LIMIT`.
- **Unmapped paid subscriptions** (no stored tier): configured `STORAGE_LIMIT_BYTES` and no recipient cap.
- **Billing off and grandfathered accounts**, even with a stored tier.
- **States without access:** a stored tier is ignored, and writes are still refused by the gate (402).

No tier is backfilled or inferred from the interval.

**Errors:**
- A paid recipient cap is `409 { code: 'PLAN_LIMIT', message }`:
  `Your plan includes up to N people in People I Love. To add someone new, remove someone first.`
  It makes no upgrade promise, and the app shows no "View plans" for it.
- Storage keeps its existing generic 409 messages (`STORAGE_FULL`, `NOT_ENOUGH_STORAGE`).
- `TRIAL_LIMIT` is unchanged.

**Excess and downgrades:** nothing is deleted, hidden or truncated.
- Existing recipients stay listed, editable (while access lasts) and deletable.
- Files stay readable and downloadable.
- New recipients are refused while at or over the cap, and new reservations are refused while there isn't room.
- Deleting frees the space or slot.

**A plan change during an upload:**
- Storage is charged once, when the upload is reserved (`PENDING_UPLOAD` holds its declared size).
- Completion turns that same row `READY` and does not check the quota again, so there is no second charge.
- An upload reserved under the old limit completes even if the new limit is lower. The account may then be over its
  allowance, and only new reservations are refused.

**UI:** no code change was needed. The recipient form already shows the server's message for any 409 and keeps what
was typed. A test now pins this for `PLAN_LIMIT`. Counters and plan comparison come in a later step.

**Development setup required:** the `tier` column must exist before this code runs. A `nest start --watch` dev API
picks up the new code immediately, and until the migration is applied its billing and quota reads fail. From
`for-after-backend`:
```
npx prisma migrate deploy
```
Then restart the API and worker if they don't recover. This is additive (one enum, one nullable column), with no
data change.

**Step 4 (2026-11-16): media capabilities by tier. Built locally.**

**Policy** (`allowedMediaKinds()` in `billing-access.ts`, read from `PLAN_DEFINITIONS`): which kinds of **new** content
media an account may add.

| Account | New media allowed |
|---|---|
| Enforced active trial | none: unchanged `PAID_FEATURE` (recipient photos are not content media and stay allowed) |
| Entitled mapped Premium | `PHOTO`, `AUDIO` |
| Entitled mapped Complete | `PHOTO`, `AUDIO`, `VIDEO` |
| Unmapped paid, billing off, grandfathered | all kinds, as before |
| No access | all kinds in policy, but every write is refused at the gate first (402); a stored tier can't bypass it |

`PLAN_IN_EFFECT.PREMIUM` now includes `contentMedia`.

**One kind-aware check:** `PaidFeatures.mediaRefusal / assertMedia / mediaAllowed(owner, needed, tx?)`, where `needed`
is the kinds a write newly adds, or `'any'` for a format that needs some media.
- No media allowed at all gives the unchanged trial `PAID_FEATURE`.
- A kind the tier lacks gives `409 { code: 'TIER_REQUIRED', requiredTier: 'COMPLETE', feature: 'VIDEO', message }`,
  with message `Video is available with For After Complete. Your plan includes photos and audio.` This is not a trial
  limit.

**Protected write paths.** Every check runs before anything is reserved, signed or written; refusals roll back.
1. **Upload start** (messages, My Story, My Wishes; the Memory Vault only accepts photos and audio): by the declared
   kind, inside the existing transaction, before the quota reservation, row or signed upload.
2. **Upload completion:** re-checked for the row's kind at the moment the file would become READY. The kind is fixed
   when the upload is created, and completion verifies the actual file signature against the declared MIME type.
3. **Message create:** by format. VIDEO needs video. PHOTO and AUDIO need their kind. MIXED needs some media but never
   implies video: a MIXED message's files are checked by kind as each is uploaded or copied.
4. **Message edit and version restore:** only a switch to a format the message doesn't already have is checked. Text
   or metadata edits that keep a VIDEO format and its existing video are allowed, and so is VIDEO → MIXED (the same
   video is kept). Versions hold title, format and text, never files, so a restore can't re-attach a removed file;
   restoring a VIDEO-format version on Premium is refused and changes nothing.
5. **Conversions into messages** (`MessageSnapshotService`: memory, story or wish → message): every copied file's own
   kind (from the database row) plus the format's kind. A copied video is new video, refused on Premium before the
   message or any copy exists.
6. **Not content media, unchanged:** recipient photos (PHOTO only) and death-verification evidence.

**Existing video and downgrades.** Existing files are never removed or hidden.
- Existing videos stay listed, viewable (access URL), downloadable and removable.
- Premium can't upload, replace, copy or newly attach video.
- Keeping an existing video attached (an unchanged format, or VIDEO → MIXED) is not a new attachment.
- Release permissions and recipients' access to released messages are unchanged.

**Memory links:** the Memory Vault has never accepted video, for any plan (Phase 12: messages only; validation plus
the `MemoryVaultMediaAsset_kind_size_check` constraint). So a linked memory can't hold a video. Separately, a link
exposes only the memory's id, title and category:
- the answer and the book read no files of a linked memory;
- story → message only accepts the answer's own file ids (`INVALID_STORY_MEDIA`);
- the trusted-contact portal only counts memories.

Linking therefore gives no one new access to video. Both points are tested; no extra rule was needed.

**A plan change or access ending during an upload:**
- A video reserved under Complete and completed under Premium is refused at completion (`TIER_REQUIRED`). The existing
  `remove()` soft-deletes that pending row: its reservation is released once (a pending row stops counting when
  soft-deleted), and the provider file is purged by `MediaCleanup`. It is never scanned or made READY.
- A repeated completion finds no live row (404) and changes nothing. Pre-existing media is untouched.
- An allowed photo or audio upload completes once, moving its reserved bytes to used with no second charge (Step 3
  accounting).
- If access ends mid-upload, completion is a write and is refused at the gate (402). The row stays `PENDING_UPLOAD`
  and is retired by the existing stale-upload cleanup.

**API (additive):** `GET /billing` `features.mediaKinds`, the kinds of new media allowed now.

**Frontend (shared components):** `ProBadge` takes a label, `ProButton` a badge, `ChoiceGroup` locked choices a
`badge`, plus `COMPLETE_VIDEO_COPY` and `CompleteVideoButton`. `usePaidMedia().videoLocked` is true only when the plan
says media is allowed but not video.

Where Premium sees **Complete**:
- the media manager's "Add a video" and "Record a video" (the recorder is hidden);
- the "Video" message format, except on a message that is already VIDEO;
- the My Story workspace's "Add a video" (its file picker no longer accepts video on Premium, and a picked video is
  explained before any request);
- a story or wish video in "Create a message" ("Copy this video" instead of a checkbox).

The dialog says video is available with For After Complete and that existing videos stay and can be removed. Other
behaviour:
- `TIER_REQUIRED` refusals show the message plus View plans and keep the form; the plan is re-read.
- An unknown plan locks nothing, and the API decides.
- The trial's Pro controls are unchanged.

**Synthetic tiers only.** Tiers are set directly on test accounts. Nothing assigns a tier from Stripe yet, so no real
account has these limits.

**Verified (2026-11-16 close-out):** full results in
[`updated-plans-step-4-report.md`](updated-plans-step-4-report.md).
- Backend: `tsc` and oxlint clean; unit tests 77 files, 1631/1631.
- Isolated e2e: 24 files in one combined run, 290/290, 0 skipped. A test-only addition (My Story / My Wishes
  completion after a downgrade) then took `plan-media` to 13/13.
- Frontend: 21 files, 329/329; eslint clean.
- Isolated production build: exit 0, 62/62 pages.
- Isolated browser: 13/13 at 1280 and 390 px.

**Step 5 (2026-11-17): durable AI companion allowances. Built locally.** Full report:
[`updated-plans-step-5-report.md`](updated-plans-step-5-report.md).

**Counting rules** (`aiMeter()` in `billing-access.ts`; values from `PLAN_DEFINITIONS.*.aiRequests`):

| Account | Allowance | Bucket |
|---|---|---|
| Enforced active trial | 5 successful replies, no reset | one bucket for that trial: `trial:<CustomerTrial.id>` |
| Entitled mapped Premium | 50 per UTC calendar month | one bucket per account and UTC month: `month:YYYY-MM` |
| Entitled mapped Complete | 200 per UTC calendar month | the same `month:YYYY-MM` bucket |

- **Paid months:** from 00:00 UTC on the 1st to 00:00 UTC on the next 1st. No rollover. Annual subscriptions get the
  same monthly allowance.
- **Tier and interval changes** never start a fresh bucket; only the limit changes. Premium → Complete keeps the
  month's count and the limit becomes 200. Complete → Premium keeps it, and blocks further replies if the count
  already exceeds 50. Monthly ↔ annual changes nothing.
- **Trial usage stays in its own bucket.** A trial that becomes paid starts on that month's paid bucket.
- **What counts:** every companion action (questions and writing actions) once a complete reply is delivered.
- **What doesn't count:** failed, empty, cancelled or provider-truncated replies (a truncated reply is still shown).
- **Not metered** (no rows; existing behaviour plus the hourly, global and in-flight abuse limits): billing off,
  grandfathered and unmapped paid accounts.
- **No access** (expired, not started, ended): the gate still refuses `POST /assistant/reply` (402). A tier or
  allowance never grants access.

**Persistence:** migration `20261117090000_add_ai_usage` adds `AiUsage` and enum `AiUsageStatus`
(`RESERVED` / `USED` / `RELEASED`). Columns: `userId`, `requestId`, `period`, `status`, `expiresAt`, `settledAt`,
`createdAt`; unique `(userId, requestId)`. Metadata only: no prompt, reply or content (an e2e checks the columns and
values).

**Lifecycle** (`AiUsageService`; wired in `AssistantService.reply`):
1. **Order of checks.** The per-user hourly limit (Redis, unchanged) comes first, then the single-use request-id
   claim, then the allowance reservation, then the in-flight cap. The provider call follows.
2. **Reserve.** One short transaction under the User row lock counts `USED` rows plus unexpired `RESERVED` rows in the
   bucket. At the allowance it refuses with
   `409 { code: AI_ALLOWANCE_EXHAUSTED, kind, allowance, used, resetsAt, message }` (not the hourly 429). Otherwise it
   inserts a `RESERVED` row with `expiresAt = now + 55 s`: the 25 s provider budget plus 30 s grace. No transaction
   stays open during the provider call.
3. **Settle.** A complete reply settles `RESERVED → USED`, only while unexpired (a conditional update). A repeat on a
   `USED` row is a no-op.
4. **Release.** Failed, empty, cancelled or truncated replies release `RESERVED → RELEASED` (idempotent).
5. **Recording failure.** If the provider succeeds but settling fails, the reply is not shown:
   `503 AI_USAGE_UNRECORDED`. Nothing is released and the provider is not called again. The slot stays held until
   `expiresAt`, then frees itself, so an undelivered reply is not charged.
6. **Crash recovery.** A crashed request's `RESERVED` row stops counting at `expiresAt`; no sweeper is needed. A
   reservation can only settle before it expires and counts until then, so its slot is never reused while the original
   request could still succeed (the provider call is aborted at 25 s).

**Idempotency:**
- The client sends a fresh `requestId` (UUID) per Send, and a "Try again" is a new Send.
- A reused id is refused with `409 AI_REQUEST_DUPLICATE` before any reservation, charge or provider call. This uses a
  Redis claim keyed by account and id (1 h, for every account) and, for metered accounts, the database unique index.
- Ids are bound to the account, so another account can use the same id.
- Replies are not stored, so a duplicate gets no replay: the companion asks again with a new id.

**API:**
- `GET /assistant/usage` (a read, not gated) returns `{ metered: true, kind, allowance, used, inProgress, remaining,
  periodEndsAt, resetsAt }` or `{ metered: false, reason }`, where `reason` is one of `billing_off`, `grandfathered`,
  `unmapped_paid` or `no_access`. It never says "unlimited".
- `POST /assistant/reply` accepts an optional `requestId`.
- AI Operations gains the outcomes `allowance_exhausted`, `duplicate_request` and `usage_unrecorded`.
- `PLAN_IN_EFFECT` includes `aiRequests` for every tier.

**Companion:**
- One usage line under the composer: "X of 5 trial AI replies used", or "X of 50 AI replies used this month · resets
  1 December". Nothing is shown when the account isn't metered.
- Exhaustion gets its own message, with the reset date in UTC, no Try again, and a note that manual writing continues.
- A failed request gives the typed text back.
- Nothing is resent, saved, scheduled or released automatically.
- `GUIDE` (the assistant's page facts) no longer says plans and billing don't exist. It describes the Plan section
  and the remaining-reply counts only.

**Synthetic tiers only.** No Stripe mapping exists yet, so no real account is metered by tier.

**Verified (2026-11-17):** full results in [`updated-plans-step-5-report.md`](updated-plans-step-5-report.md).
- Backend: `tsc` and oxlint clean; unit tests 77 files, 1645/1645.
- Isolated e2e: 13 files in one combined run, 162/162, 0 skipped.
- Frontend: 30 files, 365/365; eslint clean.
- Isolated production build: exit 0, 62/62 pages.
- Isolated browser: 7/7 at 1280 and 390 px (fake provider).

**Step 6 (2026-11-17): Stripe price → tier mapping and tier Checkout. Implementation and local verification complete
(fake Stripe); sandbox verification blocked.** Full report: [`updated-plans-step-6-report.md`](updated-plans-step-6-report.md).

**Price settings** (`src/billing/stripe-prices.ts`, `PriceCatalog`):

| Setting | Means | Sold by Checkout |
|---|---|---|
| `STRIPE_PRICE_PREMIUM_MONTHLY` / `_ANNUAL` | PREMIUM + that interval | yes, when set (unset today: Premium pricing is undecided) |
| `STRIPE_PRICE_COMPLETE_MONTHLY` / `_ANNUAL` | COMPLETE + that interval (sandbox amounts approved: AUD 99 / AUD 999) | yes, when set |
| `STRIPE_PRICE_MONTHLY` / `STRIPE_PRICE_ANNUAL` (legacy) | an interval only, **no tier** (the existing unmapped behaviour) | no |

- Every id must look like `price_…` and appear in one setting only. A duplicate, including legacy versus tier, fails
  start-up. The legacy settings are never reinterpreted as a tier.
- A tier comes only from this mapping. It never comes from an interval, product name, amount or metadata (client or
  Stripe).
- Keep the legacy settings while legacy subscriptions exist.

**Checkout** (`POST /billing/checkout`):
- The body is `{ tier: PREMIUM | COMPLETE, interval: monthly | annual }`; any other field is refused (400).
- The server picks the configured price. An unconfigured pair is 400.
- Before creating a session, the price is read from Stripe and must be active, recurring, of that interval (count 1),
  licensed and in this mode. Otherwise the request gets 503 "This plan isn't available right now", and the log gets
  `billing_price_rejected` with the reason. This is the only Stripe call added; `GET /billing` reads configuration
  only.
- These are kept from before: authentication, the account-bound Stripe customer, fixed return URLs, and the
  idempotency key (now `checkout-<user>-<tier>-<interval>-<hour>`).
- "Already subscribed" (409) now also covers `plan_unresolved`.
- `GET /billing` adds `checkoutOptions: [{ tier, interval }]` and `subscription.mapping` (`mapped` / `unmapped` /
  `unresolved`). `plans` is kept, as the intervals of `checkoutOptions`.

**Webhook sync** (`BillingService.sync`). These safeguards were re-read in the code and are unchanged:
- raw-body signature check;
- mode check;
- `StripeEvent` dedup in the same transaction;
- re-reading the customer's subscriptions from Stripe;
- `subscriptionRank` choosing the current subscription (an old one's late event is "superseded");
- the `syncedAt` compare-and-set with retry;
- the ownership check (the subscription's customer must be the account's).

Resolution of the chosen subscription's items:
- **Mapped:** exactly one item, quantity 1, with a tier price. Stores `tier` and `plan` = the interval.
- **Legacy:** one item with a legacy price. Stores `plan` = the interval and `tier` null.
- **Unknown or ambiguous:** an unconfigured price, several items, no items, or quantity ≠ 1. The first item is never
  picked.
  - If this is the unmapped subscription the account already held (same id, no tier, not unresolved), it keeps its
    existing treatment: `plan` 'unknown' and access as before.
  - Otherwise (a new subscription, or one that was mapped) it is **unresolved**: `priceUnresolved` true, and the
    stored `tier` is left as it was (never a default).
  - The log gets `billing_price_unresolved` (or `billing_price_unmapped_kept`) with the event, user, reason and price
    ids. No secrets or content.
  - The audit row gets `tier`, `priceMapping` and `priceUnresolved`.

**New access state `plan_unresolved`:**
- When: Stripe says paid and in period, but the price is unresolved.
- No write access (fail closed, 402 `PLAN_UNRESOLVED`), no tier and no tier limits. Reads, downloads and deletes stay
  open.
- An active trial still wins. Grandfathered accounts keep access.
- It is in the resolver, its SQL, the admin filter and the plan page ("We're checking your plan", contact support).
- It resolves itself on the next event once the subscription carries a configured price.
- Migration `20261117120000_add_billing_price_unresolved` (additive, default false: every existing row keeps its
  meaning).

**What a mapping activates:** the tier is in force only in a paid state (`entitledPaidTier`). That gives Steps 3–5
storage, recipients, media and AI. `payment_pending`, `access_ended`, `trial_*` and `plan_unresolved` keep a stored
tier locked. A tier change on the same subscription keeps the UTC-month AI bucket.

**Step 6 close-out (2026-11-17).**
- Interim unresolved-price policy applied as instructed:
  - new unknown or ambiguous subscriptions grant nothing;
  - held legacy or unmapped subscriptions keep their access;
  - a mapped subscription meeting an unknown price is flagged, with no tier guessed.
- A retained tier can't bypass `PLAN_UNRESOLVED`: every content write is refused at the gate (storage, recipients,
  media and AI were tested). Reads, deletes, billing, support, account settings and sign-out stay open.
- A transient Stripe failure (a failed list or read) is a 500 with nothing stored, so Stripe retries. Only data Stripe
  actually returned can mark a price unresolved.
- A later sync with a configured price clears the flag and restores the tier.
- The `plan_unresolved` 402 message is now "We couldn't match your subscription to a plan yet, so creating and editing
  are paused. Please contact support." The UI's lock dialogs, refused saves and plan page offer **Contact support**,
  never "View plans" or "Choose a plan".
- Verified locally (fake Stripe; not payment evidence):
  - e2e: 15 files, 181/181;
  - backend unit tests: 78 files, 1651/1651;
  - frontend: 36 files, 440/440;
  - isolated build: 62/62;
  - browser: 10/10 at 1280 and 390 px.
- Prisma dependency correction:
  - an external, undocumented change had set `prisma` (CLI) to `^8.0.0-rc.34` next to `@prisma/client` 7.10.0;
  - restored to `^7.10.0` (that line only), with the lockfile back to HEAD's (only that change differed) and
    `node_modules` synced;
  - the generated client is byte-identical;
  - backend `tsc` exit 0 (`prisma.config.ts` included), unit tests 78 files 1651/1651, combined e2e 15 files
    181/181 (after scoping one parallel-unsafe audit count in `billing.e2e`).
- **Sandbox: blocked:**
  - "for after sandbox" has no products or prices;
  - no Stripe credentials or prices in `.env`;
  - the CLI isn't logged in.
- Dev DB: up to date (51 migrations, none pending).
- Details: [`updated-plans-step-6-report.md`](updated-plans-step-6-report.md).

**Step 7 (2026-11-17): the customer plan and usage experience. Built locally (fake Stripe; sandbox payments still
not verified).** Full report: [`updated-plans-step-7-report.md`](updated-plans-step-7-report.md).

**API additions** (additive, account-scoped, `GET /billing`; no Stripe call):
- `people.recipients { used, limit, limitSource }`: the live count and the limit the create route enforces. The source
  is `trial`, `plan` (an entitled Premium or Complete) or `null` (no count limit: unmapped paid, exempt, billing off,
  no access). The app never derives it from an interval.
- `people.trustedContacts { used, limit, limitSource }`: the trial's 1, or the two-contact maximum (`maximum`), which
  no plan raises.
- `planDefinitions`: the server's `PLAN_DEFINITIONS`, so the app never copies the numbers (used by the lock dialogs;
  the plan page's comparison was removed on 2026-11-19).

**Settings → Plan:**
1. **Summary.** The plan comes from the tier in force (`productTier.tier`), never a stored tier; access is shown
   separately. Legacy or unmapped plans keep "Subscription · Monthly/Annual". Exempt accounts show "Your current
   access". Also: trial or renewal dates, Start free trial (eligible only), and Manage billing (opens the Stripe
   portal, with no tier-change promise).
   - Refinement 2 (2026-11-20): one compact card. Dates appear once each, concisely, in the viewer's timezone with its
     offset (e.g. "27 Nov 2026, 9:44 am (UTC+5:30)"): "Trial ends" / "Trial ended" (trial states only, no start–end
     range), "Renews", "Paid until" (payment issue) or "Access ends" (cancelling; access stays on until then). Dates
     come only from the trial and `currentPeriodEnd`, never from an AI reset.
   - The read-only notice (expired trial, ended paid access) ends with **"View plans"** → `/settings/plan/choose`
     when something is on sale; such accounts get no second button. Accounts that can buy and still have access get
     the "Choose a plan" button in the card.
   - **"Compare plans"** (external, plain `NEXT_PUBLIC_PLANS_URL`, nothing about the account appended) sits beside it
     only for accounts that can buy. Never for subscribers (no tier switching), unresolved (Contact support first) or
     billing off. Unset today, so not shown.
   - Exempt (grandfathered) accounts currently still see "Choose a plan" (the API accepts their Checkout, as before);
     whether to invite them is the open grandfathered-subscription decision.
2. **Usage.** Storage (shared, no monthly reset), People I Love, trusted contacts, AI replies (trial total, or the UTC
   month with its reset, annual included), and the trial's questions and memory when they apply.
   - Bars are capped at 100%; the text keeps the real value, with "Above this allowance… everything stays".
   - A failed read says "Not available right now" with Try again, never 0.
   - With no count limit it says "no set limit", never "unlimited".
   - Grid: three columns on wide screens (≥1280 px), two at intermediate widths, one on phones.
3. **Choose a plan** (refined 2026-11-19, replacing the original three sales cards and `<details>` comparison:
   pricing and feature comparison belong on the marketing site; **moved in Step 8 to its own authenticated route,
   `/settings/plan/choose`**. Settings → Plan now holds no purchase controls, only one internal "Choose a plan"
   button when buying is possible).
   - Shown only when billing is on, the account holds no subscription (not paid, pending or unresolved) and at least
     one `{ tier, interval }` is configured. One small panel per tier on sale: the tier name, an interval radio group
     (unconfigured intervals disabled) and "Continue to secure checkout", which sends `{ tier, interval }`. This is
     the app's **only authenticated Checkout entry**. Tiers not on sale (Premium today) are not shown.
   - Nothing configured and no access: "Plans can't be bought online just yet" with Contact support (Step 6 rule).
   - Holding a subscription: no Choose a plan button; the route says "You already have a subscription" with Contact
     support and no controls. Unresolved: the route sends the Customer to Contact support.
   - One secondary external link, **"Compare plans on our website"**, on the purchase route (and "Compare plans" on
     the plan page for buy-eligible accounts, refinement 2), when
     `NEXT_PUBLIC_PLANS_URL` (frontend, https only) is set. **No verified URL exists yet, so it is unset and no link is
     shown.** Never a guessed URL.
   - The trial starts only from the summary and never restarts.
   - **No prices are shown.** No backend contract supplies an amount, currency and interval for the configured
     offering, so the section says the price appears on Stripe's checkout page. Premium is unpriced.
   - `planDefinitions` stays in `GET /billing`; the shared lock dialogs still use it.

**Shared locks:**
- The badge names the lowest tier that includes the feature: "Premium" for trial caps, photos and audio, memory links
  and questions; "Complete" for video, and for Premium's 10-person recipient limit.
- At Complete's 50 there is no badge and no plan, Close only. The two-contact maximum offers no plan, as before.
- All dialogs use the shared `ProDialog` / `UpgradeDialog`. An unresolved subscription goes to Contact support, and an
  expired account keeps View plans.
- Every lock's "View plans" goes to `/settings/plan` (summary, usage and, where allowed, Choose a plan).
- The companion: on AI allowance exhaustion it adds "View plans" (renamed from "Compare plans" on 2026-11-19: the plan
  page no longer compares plans) for the trial and Premium only. Complete shows
  just the reset. Hourly throttling is unchanged, with no plan link.

**Counters:**
- "X of Y people" and "X of 2 trusted contacts" on the people pages.
- The existing trial question and memory counters, the companion usage line and the Storage settings card.
- People writes now refresh `GET /billing`, and a `PLAN_LIMIT` refusal re-reads the plan.

**Pending decisions:**
- the tier for existing `monthly` / `annual` subscriptions (still unmapped; no backfill);
- whether an unresolved price should keep fail-closed access (Step 6's interim choice) or get some other treatment;
- tier switching, proration and the Customer Portal's product configuration (not built: a subscribed account can't
  change tier here);
- whether a grandfathered account that subscribes gets its tier;
- the trial's "preview" of My Story answers compared with the book;
- what "priority support" means operationally;
- how customers change tier (Customer Portal or Checkout);
- Premium's price;
- badge wording (Step 7 applies "Premium" / "Complete" by lowest including tier; confirm the copy);
- a pricing contract (amount, currency and interval per configured offering) before prices appear on the plan page;
- the marketing site's verified pricing URL for `NEXT_PUBLIC_PLANS_URL` (the "Compare plans" link stays hidden until
  then).

**Step 8 (2026-11-19): final integration verification. Local only (fake Stripe); not payment verification.** Full
report: [`updated-plans-step-8-report.md`](updated-plans-step-8-report.md).
- **Account management separated:** `/settings/plan` (status, usage, Start free trial, Manage billing, one "Choose a
  plan" button when eligible) and `/settings/plan/choose` (tier/interval Checkout; refuses subscribers and unresolved
  accounts; optional external comparison link). Checkout return URLs are unchanged.
- **Checkout is refused while a first payment is pending** (`payment_pending`, Stripe `incomplete`): 409, like other
  subscription-holding states, so two sessions can't both be paid. Finish or fix it through Manage billing, or let it
  expire.
- **Usage meters follow plan changes:** when `GET /billing`'s state, access or tier changes, the app re-reads storage
  and AI usage (usage counts are never reset).
- Verified: backend unit 1651/1651 (78 files, two rerun alone after resource failures), e2e 342/342 (27 files, one
  run), frontend 918/918 (64 files), builds, browser journeys 17/17 at 1280/820/390/200%.
- **Still blocked:** real sandbox Checkout → webhook → entitlement (no keys, prices or CLI login).

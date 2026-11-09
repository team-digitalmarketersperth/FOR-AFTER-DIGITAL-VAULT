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
annual plans are offered; trial/plan feature or storage differences (today every plan keeps the single
`STORAGE_LIMIT_BYTES`); subscription after death (`PROJECT_OVERVIEW.md` §40, "must be finalised before production");
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

**Frontend (UX only):** without access every page stays open under a plan notice (viewing, download, delete); pages whose
only purpose is adding or changing content (`…/new`, `…/edit`, `…/create-message`) show a blocker instead; a refused write
shows the API's message and a plan link where it failed. If the plan cannot be read nothing is hidden.

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
days); newest first with id tie-breaker. Admin → Users list/detail carry a `billing` summary only for SUPER_ADMIN
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

# 🕊️ For After — Project Task List

> The full-stack roadmap for **For After**, a secure Digital Legacy and Posthumous Messaging platform, from local
> development to production launch. Phase order follows `docs/PROJECT_OVERVIEW.md` §59 (Recommended Development Sequence).

|                              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Last updated**             | 2026-10-05                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Latest backend step**      | Step 24: transactional email through Brevo (provider-neutral `EmailProvider`; migrated from Resend 2026-10-05): sign-in codes, "a message is waiting" release emails (durable `ReleaseNotification` + `email-delivery` queue), account-holder safety notice. Step 24.1: per-Recipient release emails verified for all three triggers. Brevo key accepted (dev IP blocking off, 2026-10-05); **first real OTP to an inbox pending confirmation** ([`email-production-setup.md`](email-production-setup.md)) |
| **Latest frontend step**     | Step 24: admin queues show `email-delivery` jobs; portal E2E reads codes from the console email provider                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Backend**                  | Steps 1–16 + 22–24.1 + Phases 03, 04, 08 and 09 built and tested                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Frontend**                 | **27 of 30 tasks** built and verified (FE-1–19, FE-21–28); 204 unit/component tests; Playwright 36 passing, 0 failing, 0 skipped against the real local API (console email provider), PostgreSQL, Redis and the development bucket (Step 24, 2026-10-03). Frontend tracker: `for-after-frontend/docs/tasks.md`                                                                                                                                                                                             |
| **Checklist (phases 02–27)** | **163 of 227** items done (recounted from the checkboxes, 2026-10-05)                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## 📖 How to read this file

|  Symbol  | Meaning                                                |
| :------: | ------------------------------------------------------ |
| ✅ `[x]` | Done and verified by tests                             |
| 🟡 `[~]` | Partly done                                            |
| ⬜ `[ ]` | Not started                                            |
| **FE-n** | Frontend task number n in [Part 6](#-part-6--frontend) |

Each phase lists **Done** items first, then **To do**. "Backend ready" means the API exists and is tested but has no UI yet.

---

## 🧭 Contents

1. [At a glance](#-at-a-glance)
2. [Part 1 — Product decisions](#-part-1--product-decisions) (phase 01)
3. [Part 2 — Backend foundation](#-part-2--backend-foundation) (phases 02–06)
4. [Part 3 — Customer vault features](#-part-3--customer-vault-features) (phases 08–15)
5. [Part 4 — Scheduling and release engine](#-part-4--scheduling-and-release-engine) (phases 16–17)
6. [Part 5 — Portals and death verification](#-part-5--portals-and-death-verification) (phases 18–19)
7. [Part 6 — Frontend](#-part-6--frontend) (phase 07 + 30 frontend tasks)
8. [Part 7 — Platform services](#-part-7--platform-services) (phases 20–23)
9. [Part 8 — Quality and launch](#-part-8--quality-and-launch) (phases 24–27)
10. [Out of scope for MVP](#-out-of-scope-for-mvp)
11. [Housekeeping](#-housekeeping)

---

## 📊 At a glance

| Phase | Area                       | Status                                                                                                                                                                                   |    Done / items    |
| :---: | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------: |
|  01   | Product decisions          | 🟡 Docs written, most decisions still open; Phase 10 decided the Trusted Contact maximum, permissions and reopening                                                                      | 2 (+2 partly) / 34 |
|  02   | PostgreSQL + Prisma        | ✅ Done                                                                                                                                                                                  |       6 / 6        |
|  03   | NestJS foundation          | ✅ Done (Swagger + global exception filter, 2026-10-05)                                                                                                                                  |      12 / 12       |
|  04   | Authentication (core)      | ✅ Done: core, admin TOTP, change password, email verification, reset, Redis rate limits                                                                                                 |      13 / 13       |
|  05   | Sessions + authorization   | 🟡 Three principals, MFA-enforcing AdminGuard, admin idle timeout, CSRF Origin check (Step 23) done; password change ends other sessions (Step 22); standalone sign-out-all open         |      12 / 13       |
|  06   | Local development login    | ✅ Done (`/dev-login`, Step 17)                                                                                                                                                          |       2 / 2        |
|  07   | Next.js dashboard shell    | ✅ Done (Step 17)                                                                                                                                                                        |       6 / 6        |
|  08   | User profile               | ✅ Name, Account settings UI (Step 22), verified email change (Phase 08)                                                                                                                 |       3 / 3        |
|  09   | People I Love (Recipients) | ✅ Backend + UI (Step 18), pagination and private Recipient photo (Phase 09)                                                                                                             |       8 / 8        |
|  10   | Trusted Contacts           | 🟡 Backend, email OTP, Customer UI, max 2, email invitations, permission model done (Phase 10); SMS OTP deferred                                                                         |      12 / 13       |
|  11   | Messages                   | 🟡 TEXT/PHOTO/AUDIO/MIXED + UI (Step 18) done; video open                                                                                                                                |      11 / 14       |
|  12   | Media                      | 🟡 Photo/audio on B2 + upload UI/recorder (Step 18) done; bucket CORS, video, quotas open                                                                                                | 8 (+1 partly) / 15 |
|  13   | Memory Vault               | 🟡 Backend + UI done (Step 18)                                                                                                                                                           |       5 / 7        |
|  14   | My Story                   | 🟡 Backend + UI done (Step 18)                                                                                                                                                           |       4 / 6        |
|  15   | My Wishes                  | 🟡 Backend + UI with disclaimer done (Step 18)                                                                                                                                           |       5 / 7        |
|  16   | Scheduling                 | 🟡 FIXED_DATE, ON_DEATH, AFTER_DEATH executed + schedule UI (Step 18); recurring triggers open                                                                                           |      10 / 11       |
|  17   | Redis + BullMQ             | 🟡 Release, death-verification and `email-delivery` (Step 24) queues, admin failed-job view/retry done; DLQ/alerts open                                                                  | 8 (+1 partly) / 10 |
|  18   | Recipient portal           | 🟡 Backend (Step 13) + UI (Step 19) + email sign-in codes and release emails (Step 24) done; SMS open                                                                                    |       5 / 7        |
|  19   | Death verification         | 🟡 Workflow (Steps 14–15) + Trusted Contact portal, Customer safety UI (Step 19) and admin review UI (Step 20) done; evidence, second confirmation open                                  |      13 / 15       |
|  20   | Notifications              | 🟡 Brevo email: codes, release, safety, verify/reset (Phase 04), invitations (Phase 10); **real-inbox OTP + production domain pending (manual)**; SMS deferred                           |       2 / 5        |
|  21   | Stripe billing             | ⬜ Not started                                                                                                                                                                           |       0 / 6        |
|  22   | Admin portal               | 🟡 Admin backend (Step 16) + Admin Portal UI (Step 20) done; subscriptions/deliveries wait for Stripe/delivery                                                                           | 6 (+1 partly) / 7  |
|  23   | Audit + security           | 🟡 `AuditLog` + admin events (Step 16) + `PASSWORD_CHANGED` (Step 22); full app audit (Step 23); other customer events, export, deletion open                                            | 2 (+1 partly) / 7  |
|  24   | Testing                    | 🟡 Backend tests + Postman done; frontend 199 component + Playwright green (Step 22); §50 security cases, load test open                                                                 |       5 / 7        |
|  25   | WordPress integration      | ⬜ Not started                                                                                                                                                                           |       0 / 3        |
|  26   | Staging                    | 🟡 Railway client demo live (frontend, API, PostgreSQL, Redis); CI, separate secrets, worker process, QA open                                                                           |       2 / 6        |
|  27   | Production                 | ⬜ Not started                                                                                                                                                                           |       0 / 9        |
|  FE   | **Frontend (all apps)**    | 🟡 Customer app + vault + portals (Steps 17–19) + Admin Portal (Step 20) + Account settings (Step 22); billing, WordPress open                                                           |    **27 / 30**     |

### What the backend already does

```text
Customer ──login──► vault: People I Love · Trusted Contacts · Messages (+ photo/audio) · Schedules
                           Memory Vault · My Story · My Wishes
FIXED_DATE schedule ──BullMQ──► Message RELEASED ──► Recipient access grants
Recipient ──email code──► read released Messages + media                         (Step 13)
Customer adds Trusted Contact (max 2) ──email invitation──► accept / decline     (Phase 10; SMS deferred)
Trusted Contact ──email code──► see accounts ──► file death report (PENDING)       (Step 14)
                                                  └─ verifies nothing, releases nothing
CANCELLED / REJECTED case ──later report──► NEW case, full workflow again        (Phase 10; VERIFIED never reopens)
Report ──safety notice──► safeguard ──► admin verifies ──► PASSED + ON_DEATH/AFTER_DEATH release   (Step 15)
Admin ──password + TOTP──► dashboard · users (suspend/reactivate) · audit log · queues · death review (Step 16; UI Step 20)
```

---

## 🧩 Part 1 — Product decisions

> Phase 01. Questions only the product owner can answer. Many backend limits are placeholders until these are decided.

### 01 · Product decisions — 🟡 2 (+2 partly) of 34 done

**Done**

- [x] Product documentation written (`docs/`: PRD, overview, architecture, database, API, auth, security, threat model, deployment)

**Trusted Contacts and death reports**

- [~] Trusted Contacts: one or two? mandatory? replacement rules? exact permissions? _Decided (Phase 10, 2026-10-06):
  **maximum 2 active** per Customer (removed ones do not count; replacement = remove, then add); **permissions**: email OTP
  sign-in, display name, `hasPreservedContent`, case status, report death, start a new case after `REJECTED`/`CANCELLED`;
  no preserved-content, Recipient, settings or admin access ([trusted-contact-auth.md](trusted-contact-auth.md) §11).
  **Invitations: email only** (SMS invitation deferred). **Sign-in: email OTP** (SMS OTP deferred). Still open: mandatory?_
- [~] Trusted Contacts: can they see message titles, or that unreleased content exists? _Step 14 shows only a
  `hasPreservedContent` true/false (no titles or counts); confirm with product_
- [ ] Trusted Contacts: is showing them the Customer's relationship label (e.g. "Friend") acceptable?
- [x] **Death reports: how a `REJECTED`/`CANCELLED` case reopens** (Phase 10, 2026-10-06). A terminal `REJECTED` /
      `CANCELLED` case remains immutable history; a later legitimate Trusted Contact report creates a **new** case
      (`reopenedFromCaseId`, audit `CASE_REOPENED`) that runs the full safety workflow. Only one open case per Customer
      (partial unique index). `VERIFIED` / `PASSED` never reopens ([death-verification.md](death-verification.md) §1.1)
- [ ] Death verification: should "confirm alive" accept a free-text note from the Customer (not supported in Step 15)?
- [ ] Death verification: may Trusted Contacts or Recipients ever see `verifiedDeathAt`? May admins reject before review?
- [ ] Death verification: recovery/reversal procedure for a wrong verification (today: manual, see incident response)
- [ ] Death reports: same email added twice as Trusted Contact by one Customer can file one report per row (allow or block?)
- [ ] Death reports: should Trusted Contacts of a `SUSPENDED` Customer still see the account?
- [ ] Death verification: accepted evidence, number of confirmations, admin review rules

**Messages, scheduling and release**

- [ ] Scheduling: rules for birthdays, anniversaries, after-death and annual releases (BIRTHDAY needs: timezone, time of
      day, 29 Feb, several recipients with different birthdays, recurrence)
- [ ] Scheduled messages are locked (edit = unschedule → edit → reschedule): is that the UX we want?
- [ ] Composition rules: PHOTO/AUDIO may not carry text (must be MIXED), MIXED needs ≥ 2 of text/photo/audio: confirm with product
- [ ] What happens at release time if all assigned recipients were deleted after scheduling?
- [ ] When is a message `CANCELLED`, and can it ever be restored?
- [ ] Limits: message text 20,000 chars, 100 recipients per message, after-death offset ≤ 36,500 days (all configurable placeholders)
- [ ] Release: what should happen to a due message whose recipients were all deleted (currently stays SCHEDULED,
      re-checked every minute)?
- [ ] Release: alerting/admin view for stuck releases; run the worker as its own process in production?

**Media, storage and billing**

- [ ] Should `FAILED` media uploads be hidden from the list or cleaned up?
- [ ] Storage tiers and limits (placeholders: Basic 5 GB, Standard 25 GB, Legacy 100 GB)
- [ ] Subscription after death: what happens to billing and access

**People, accounts and data**

- [ ] Recipient access: downloads, original quality, permanent access, sharing
- [ ] Is a person who is both Recipient and Trusted Contact one linked record?
- [ ] Duplicate Recipients / Trusted Contacts per customer: allowed or blocked?
- [ ] Can a `PASSED` account ever sign in?
- [ ] Account deletion and data retention policy (legal review)

**My Story**

- [ ] Approve the final prompt set and categories (the Step 10 catalogue is a development placeholder; the overview also
      lists Parents, School, Career, Travel, Advice)
- [ ] Is 20,000 characters (shared with Messages and Memory Vault) enough per answer?
- [ ] Should the stored prompt snapshot keep the wording first answered, or the latest (current behaviour)?
- [ ] Answer formats beyond text (audio, video, photos) and linking Memory Vault items

**My Wishes**

- [ ] Approve the question set and categories (the Step 11 catalogue is a development placeholder; the overview's
      possible fields include burial/cremation, flowers, clothing, speakers, charity, religious/cultural preferences, which
      it does not cover)
- [ ] Legal review of the disclaimer wording; is an explicit, versioned acknowledgement needed? Should the API serve the
      disclaimer text?
- [ ] Who may see wishes after a verified death, and when (Trusted Contacts? Recipients?)

---

## 🏗️ Part 2 — Backend foundation

> Phases 02–06. Database, framework, Customer login and sessions: everything the features are built on.

### 02 · PostgreSQL + Prisma — ✅ 6 of 6

**Done**

- [x] PostgreSQL `for_after` database
- [x] Prisma 7 with `@prisma/adapter-pg`, client generated to `src/generated/prisma`
- [x] `User` model with `UserRole` (CUSTOMER, ADMIN, SUPER_ADMIN) and `UserStatus`
- [x] Migration `init`
- [x] `PrismaModule` / `PrismaService`, fails fast if the database is unreachable
- [x] Database errors logged without connection details

### 03 · NestJS foundation — ✅ 12 of 12

**Done**

- [x] NestJS 12, TypeScript, ES modules, Node 22
- [x] `ConfigModule` with `.env`
- [x] API prefix `/api/v1` (health checks stay at `/health/*`)
- [x] Global `ValidationPipe` (whitelist, forbid unknown fields, transform)
- [x] Helmet security headers, CORS for frontend/WordPress origins
- [x] Health checks: `GET /health/database`, `GET /health/redis`
- [x] Vitest unit + e2e setup, oxlint, Prettier
- [x] NestJS Observe (enabled when keys are set)
- [x] Redis 7 running locally in Docker (`for-after-redis`)
- [x] README rewritten for the project
- [x] Swagger / OpenAPI docs page: `/api/docs` (+ `/api/docs-json`) from the installed `@nestjs/swagger`; gated by
      `SWAGGER_ENABLED` (unset → development only, so production is off by default); four cookie session schemes
      (Customer, Admin, Recipient, Trusted Contact), no bearer auth; DTO schemas from the Nest CLI Swagger plugin
- [x] Global exception filter so unexpected errors never leak details (`src/config/global-exception.filter.ts`,
      registered in `configureApp`): HttpExceptions and body-parser 4xx unchanged; anything else is
      `{ statusCode: 500, message: "Internal server error", traceId? }` (Observe trace id), logged as class + safe code + stack frames only. Unit spec + `test/error-boundary.e2e-spec.ts` (secret-leak, Prisma/Redis/S3/Brevo-shaped
      errors, validation 400, bad JSON 400, Swagger on/off, OpenAPI document)

### 04 · Authentication — ✅ 13 of 13

**Done**

- [x] `POST /auth/register` (customers only; role/status cannot be sent)
- [x] `POST /auth/login` (generic error, same timing for unknown email)
- [x] `POST /auth/logout` (destroys session, clears cookie)
- [x] `GET /auth/me`
- [x] Argon2id password hashing
- [x] Email normalised to lowercase; duplicate email → 409
- [x] Only `ACTIVE` accounts can sign in
- [x] Rate limit: 5 requests/min per IP on register and login
- [x] Email verification (Phase 04): `POST /auth/verify-email`, `POST /auth/resend-verification`; registration emails
      a single-use 24 h link (`/verify-email?token=…`); only the SHA-256 of the 32-byte token is stored (`AuthToken`);
      sets `User.emailVerifiedAt` (on `/auth/me`), audited `EMAIL_VERIFIED`. **Signing in does not require it:** no
      doc defines that policy, so login is unchanged (open product decision)
- [x] Password reset (email link with expiry) (Phase 04): `POST /auth/forgot-password` (same `202` answer for any email)
      and `POST /auth/reset-password`; single-use 60 min link, registration password rule, Argon2id,
      `passwordChangedAt` ends every session, no auto sign-in, audited `PASSWORD_RESET_COMPLETED`; Customers only
- [x] Change password with re-authentication (Step 22): `POST /auth/change-password`, Customer only, current password
      required (wrong → `400`), registration rule reused, 5/min; this browser gets a new session id, every other
      Customer session gets `401` via `User.passwordChangedAt` vs session `authenticatedAt`; audited `PASSWORD_CHANGED`
- [x] TOTP two-factor authentication **required for admins** (Step 16, `docs/admin.md`): password → Redis challenge →
      TOTP (`otplib`, ±30 s, time-step replay guard) or one-time recovery code; AES-256-GCM secrets; 5 attempts per
      challenge + Redis per-IP limit. Optional Customer 2FA is not built (reuse the same service when needed)
- [x] Move rate-limit storage to Redis before running more than one API instance (Phase 04): `RedisThrottlerStorage`
      on the app's Redis client under `for_after:throttle:`; two API instances share one counter (e2e); fails closed

### 05 · Sessions + authorization — 🟡 12 of 13

**Done**

- [x] Redis-backed sessions (`connect-redis`), no in-memory fallback
- [x] HttpOnly `for_after_session` cookie, SameSite=Lax, Secure in production
- [x] Session ID regenerated on login
- [x] `SessionAuthGuard` reloads the user every request (suspension applies immediately)
- [x] `@CurrentUser()` decorator
- [x] `CustomerGuard` (customer-only routes; admins get 403)
- [x] Ownership pattern: every query scoped to `ownerUserId` + `deletedAt: null`, not-owned → 404
- [x] Three separate principals (Step 14), none authorizes another's routes (401):

  | Principal       | Cookie                              | Signs in with        |
  | --------------- | ----------------------------------- | -------------------- |
  | Customer        | `for_after_session`                 | email + password     |
  | Recipient       | `for_after_recipient_session`       | email code (Step 13) |
  | Trusted Contact | `for_after_trusted_contact_session` | email code (Step 14) |

- [x] Shared email OTP + Redis session engine (`src/otp-auth/`) used by Recipient and Trusted Contact auth, with separate
      peppers, Redis namespaces, cookies and guards
- [x] `AdminGuard` (Step 15): `ADMIN`/`SUPER_ADMIN` only, role re-read each request; Customers 403; no admin sign-up

**To do**

- [x] Session timeout on inactivity for admins (Step 16): `ADMIN_SESSION_IDLE_TIMEOUT_SECONDS` (30 min); admin sessions
      without MFA state are destroyed; `AdminGuard` checks role **and** MFA. Customer sessions unchanged
- [x] Separate admin session cookie (Step 23 follow-up): `for_after_admin_session` + Redis prefix
      `for_after:admin_sess:`, read only on `/admin/*` and `/admin-auth/*`; `POST /admin-auth/logout`. Customer and
      admin sessions coexist in one browser; each logout ends only its own (backend e2e + Playwright)
- [ ] "Sign out all devices" as its own action (Step 22: a password change already ends every other session; there is
      still no per-user session list)
- [x] CSRF review for cookie-based requests (Step 23, `docs/step-23-audit.md` SEC-002): `SameSite=Lax` + CORS allowlist,
      plus an Origin check that refuses state-changing requests from any origin outside `FRONTEND_URL`/`WORDPRESS_URL`
      (`403`); no token needed for this model. WordPress (FE-29) must be listed in `WORDPRESS_URL`

### 06 · Local development login — ✅ 2 of 2

**Done**

- [x] Backend login API usable locally (`localhost:4000/api/v1/auth/login`)
- [x] Next.js `/dev-login` page (localhost:3000) using the real `POST /auth/login`; real `404` in production builds
      (`src/proxy.ts` + page `notFound()`, E2E-tested against `next build`) → **FE-7** (Step 17)

---

## 🗂️ Part 3 — Customer vault features

> Phases 08–15. What a Customer stores in their vault. Every backend here is owner-scoped: another Customer's data is
> always `404`.

### 08 · User profile — ✅ 3 of 3

**Done**

- [x] Backend (Step 22): view via `GET /auth/me`, update own name via `PATCH /users/me` (Customer only, explicit DTO,
      trimmed 1–100, cannot be cleared; email/role/status/id rejected with `400`; no `/users/:id`)
- [x] Frontend: Account settings page (`/settings`, account menu) → **FE-9** (Step 22)

- [x] Change email with verification (Phase 08): `POST /auth/change-email` (current password re-checked) emails a 24 h
      single-use link to the NEW address; `User.email` changes only on `POST /auth/change-email/confirm` (atomic:
      email, `emailVerifiedAt`, `emailChangedAt`, other change/reset links consumed, audited `EMAIL_CHANGED`); every
      Customer session ends; the old address gets a notice. Resend and cancel included. Settings keeps the email
      read-only with a "Change email" dialog; `/settings/verify-email-change` confirms

### 09 · People I Love (Recipients) — ✅ 8 of 8

**Done**

- [x] `Recipient` model + migration `add_recipients` (not a `User`; signs in by email code since Step 13)
- [x] CRUD API: `POST/GET /recipients`, `GET/PATCH/DELETE /recipients/:id`
- [x] Validation: email normalised, basic phone format, date-only birthday, private note ≤ 2000
- [x] Soft delete; `ownerUserId`/`deletedAt` never returned
- [x] Unit tests + real-PostgreSQL e2e tests incl. cross-user isolation

**To do**

- [x] Pagination on the list endpoint (Phase 09): `GET /recipients?page&limit` (25 default, 100 max, the admin lists'
      `PageQueryDto`) → `{items, pagination}`, newest first with an `id` tiebreak; owner-scoped count; People I Love
      shows 25 per page with Previous / Next; the message picker still loads everyone
- [x] Recipient photo (Phase 09): optional private photo (`RecipientPhoto`), JPEG/PNG/WebP ≤ 5 MB, presigned PUT →
      HEAD-verified → current in one transaction (old one replaced only then; partial unique index = one current
      photo), signed 5-minute access, remove; initials fallback in the list and detail. Unit + e2e + Playwright (real
      private bucket)
- [x] Frontend: list, add, view, edit, remove "People I Love" → **FE-10** (Step 18) (Playwright verified, Step 21)

### 10 · Trusted Contacts — 🟡 12 of 13 (SMS OTP deferred)

**Done**

- [x] `TrustedContact` model + migration `add_trusted_contacts` (not a User, no content access)
- [x] CRUD API: `POST/GET /trusted-contacts`, `GET/PATCH/DELETE /trusted-contacts/:id`
- [x] Email or mobile required, kept on every PATCH, also enforced by a database CHECK
- [x] Soft delete; ownership isolation; unit + e2e tests
- [x] **Step 14:** sign-in by email code (`docs/trusted-contact-auth.md`): own Redis session + cookie, generic `202`
      (no enumeration), HMAC-stored codes, 5 attempts, single use, rate limits
- [x] **Step 14:** `GET /trusted-contact/accounts`: every Customer listing the signed-in email, with display name,
      content-exists boolean and case status only; foreign/removed relationship ids → 404
- [x] **Step 14:** removing a Trusted Contact ends their access to that Customer immediately (re-checked each request)

**To do**

- [x] Maximum per customer: **maximum 2 active Trusted Contacts** (Phase 10). `409` on a third; soft-deleted ones do
      not count; count + insert under a `FOR UPDATE` lock on the Customer row (e2e: 5 concurrent creates → one `201`);
      FE-11 hides "Add" and explains the limit
- [x] **Email** invitation + acceptance flow (Phase 10): `TrustedContactInvitation` (SHA-256 token hash, 7-day technical
      default TTL, one `PENDING` per contact), sent through `EmailProvider` (Brevo), resend supersedes, accept/decline
      atomic, removal or email change kills the link, accepting creates no session; `/trusted-contact/invitation` page.
      **SMS invitation deferred to post-MVP** (mobile-only contacts show "No invitation")
- [ ] SMS OTP for mobile-only Trusted Contacts — ⏸️ **DEFERRED / POST-MVP** (no Twilio, no `SmsProvider`)
- [x] Email OTP delivery (Step 24): `TrustedContactOtpDelivery` → `EmailOtpDelivery` → `EmailProvider` (Brevo)
- [x] Permission model (Phase 10): a Trusted Contact may report/verify death through the death-verification workflow
      and may start a new case after a previous `REJECTED`/`CANCELLED` case; no preserved-content access; admin stays the
      final verifier. Enforced server-side; e2e covers the forbidden routes
- [x] Frontend: manage Trusted Contacts → **FE-11** (Step 18; their own portal is FE-24 to FE-27, Step 19) (Playwright verified, Step 21)

### 11 · Messages — 🟡 11 of 14

**Done**

- [x] `Message` model + migration `add_messages`: `MessageContentType` (TEXT/VIDEO/AUDIO/PHOTO/MIXED), `MessageStatus`
      (DRAFT/SCHEDULED/RELEASED/CANCELLED)
- [x] Every message created as DRAFT; `status`/`ownerUserId` never accepted from the client
- [x] `MessageRecipient` join (many-to-many), unique per pair; only the owner's live recipients can be assigned (generic
      400 otherwise)
- [x] CRUD API: `POST/GET /messages`, `GET/PATCH/DELETE /messages/:id`; PATCH replaces recipients atomically; only DRAFT
      is editable/deletable (409)
- [x] Soft delete; ownership isolation (404); responses hide `ownerUserId`, `deletedAt`, join-table ids
- [x] Unit tests + real-PostgreSQL e2e tests incl. cross-user and transaction cases
- [x] Step 8 composition (`docs/message-composition.md`): API accepts TEXT, PHOTO, AUDIO, MIXED as the customer's
      explicit `contentType` (never inferred, never changed by the server); VIDEO → 400
- [x] Drafts may be incomplete; PATCH `textContent`: missing = unchanged, `null` clears, blank stored as `null`
- [x] Strict `checkComposition` before DRAFT → SCHEDULED (409 with a safe message): no PENDING_UPLOAD/FAILED media;
      per-type required/forbidden text, photo, audio; MIXED needs ≥ 2 modalities
- [x] Concurrency: conditional DRAFT row updates so edits/uploads and scheduling can't interleave

**To do**

- [ ] VIDEO content type (after the video pipeline, phase 12)
- [ ] Pagination / summary list (list currently returns full text)
- [ ] Soft-deleting a message should also clean up its media (currently left for reconciliation)
- [x] Frontend: create/edit message flow, assign recipients, status views, unschedule-to-edit → **FE-12**, **FE-16** (Step 18) (Playwright verified, Step 21)

### 12 · Media — 🟡 8 (+1 partly) of 15

**Done**

- [x] Private Backblaze B2 dev bucket via the S3-compatible API (`@aws-sdk/client-s3`, `s3-request-presigner`);
      provider-neutral `MediaStorage` abstraction
- [x] `MediaAsset` model + migration `add_media_assets` (`MediaKind`, `MediaAssetStatus`, DB CHECK: PHOTO/AUDIO only, size > 0)
- [x] Direct upload: `POST /messages/:id/media/upload-url` → presigned PUT (Content-Type signed, 10 min) →
      `POST …/complete` verifies with HeadObject → READY / FAILED
- [x] PHOTO (jpeg/png/webp, ≤ 20 MB) and AUDIO (mpeg/mp4/webm/wav, ≤ 100 MB); VIDEO and SVG rejected; server-generated
      storage keys
- [x] List, presigned GET access URL (5 min, READY only), soft delete + best-effort object delete; changes only on DRAFT messages
- [x] Owner-only; storage errors sanitized (503); signed URLs never stored or logged
- [x] Unit + e2e tests with mocked storage; manual end-to-end check against the real B2 bucket passed
- [x] Uploads independent of the message `contentType` (allowed media checked at scheduling, Step 8)

**To do**

- [ ] Video via Mux or Cloudflare Stream (upload, processing webhooks, signed playback)
- [ ] Malware scanning / quarantine, magic-byte checks (MIME header is not content validation)
- [ ] Cleanup job for stale `PENDING_UPLOAD` rows and orphaned objects
- [ ] Restricted bucket CORS for browser uploads: **now blocking real browser uploads**. The `for-after-dev` preflight from
      `http://localhost:3000` returns 403. Rule needed: origin `http://localhost:3000` (later `https://app.forafter.com.au`),
      method `PUT`, header `content-type` (`docs/media-storage.md`)
- [ ] Storage usage tracking and quota enforcement (80/90/100% warnings)
- [ ] Separate production bucket and credentials
- [~] Frontend: upload with progress + cancel, browser audio recorder, signed previews, delete → **FE-13**, **FE-14**
  (Step 18) (Playwright verified, Step 21). Video recorder waits for the video pipeline

### 13 · Memory Vault — 🟡 5 of 7

**Done**

- [x] Step 9 (`docs/memory-vault.md`): `MemoryVaultCategory` enum, `MemoryVaultItem`, `MemoryVaultMediaAsset`, migration
      `add_memory_vault`
- [x] CRUD `/memory-vault` (+ `?category=`), owner-scoped, soft delete; private: no status, recipients, schedule or release
- [x] PHOTO/AUDIO media reusing Step 7 storage, allowlist, limits and verification; deleting a memory hides its media
- [x] Unit + e2e tests (mocked storage) incl. cross-user isolation

**To do**

- [ ] Sharing / recipient assignment / scheduling / create a message from a memory (product decision)
- [ ] Search, tags, pagination; orphaned-object cleanup after soft delete
- [x] Frontend: Memory Vault pages, category filter, photo/audio → **FE-17** (Step 18) (Playwright verified, Step 21)

### 14 · My Story — 🟡 4 of 6

**Done**

- [x] Step 10 (`docs/my-story.md`): prompt catalogue in code (stable keys, version, 7 categories), `MyStoryResponse`,
      migration `add_my_story`
- [x] `/my-story/prompts` (+ `?category=`), `PUT/GET/DELETE /my-story/prompts/:promptKey/response`; one answer per
      prompt, soft delete, restore on re-save
- [x] Unit + e2e tests incl. cross-user isolation

**To do**

- [ ] Final prompt set and categories approved in discovery (V1 catalogue is a development placeholder)
- [ ] Audio/video/photo answers, linking Memory Vault items, sharing, release, create a message from an answer (product decision)
- [x] Frontend: My Story prompts + editor → **FE-18** (Step 18) (Playwright verified, Step 21)

### 15 · My Wishes — 🟡 5 of 7

**Done**

- [x] Step 11 (`docs/my-wishes.md`): non-legal prompt catalogue in code (stable keys, version, 7 categories),
      `MyWishResponse`, migration `add_my_wishes`
- [x] `/my-wishes/prompts` (+ `?category=`), `PUT/GET/DELETE /my-wishes/prompts/:promptKey/response`; one answer per
      prompt, soft delete, restore on re-save
- [x] Private: no recipients, Trusted Contact or admin access, schedule, release, media, Message/memory/story conversion
- [x] Unit + e2e tests incl. cross-user isolation and "creates nothing else"

**To do**

- [ ] Disclaimer shown in the UI; acknowledgement/consent record if legal review requires it
- [ ] Release to family after verified death, media, AI help (product decision; AI must never present output as legal advice)
- [x] Frontend: My Wishes pages with the exact non-legal disclaimer → **FE-19** (Step 18) (Playwright verified, Step 21)

---

## ⏰ Part 4 — Scheduling and release engine

> Phases 16–17. When a message is released. Only `FIXED_DATE` is executed today; `ON_DEATH` and `AFTER_DEATH` are
> stored and wait for death verification (phase 19).

### 16 · Scheduling — 🟡 10 of 11

**Done**

- [x] `ReleaseTriggerType` enum (all 8 product types) + `MessageSchedule` (one per message), migration `add_message_schedules`
- [x] API: `POST/GET/PATCH/DELETE /messages/:id/schedule`; supports FIXED_DATE, ON_DEATH, AFTER_DEATH (others → 400, reserved)
- [x] DRAFT → SCHEDULED on create, SCHEDULED → DRAFT on delete, both atomic; only the Step 12 release worker sets RELEASED
- [x] FIXED_DATE needs an explicit timezone offset, stored as UTC, must be in the future; DB CHECK enforces fields per trigger
- [x] Stored in PostgreSQL only (no Redis-only schedules, no `setTimeout`)
- [x] Composition check runs inside the scheduling transaction after the row is locked; schedule PATCH changes only the trigger
- [x] Unit + e2e tests incl. cross-user isolation
- [x] Release engine for FIXED_DATE (Step 12, phase 17); schedule create/PATCH/unschedule keep the queue in sync after commit
- [x] ON_DEATH / AFTER_DEATH execution (Step 15) after an admin-verified death: `DeathTriggeredMessageActivation`
      (`dueAt` = `verifiedAt` / `verifiedDeathAt + afterDeathDays`), released through the same queue and transaction

**To do**

- [ ] NOW, BIRTHDAY, ANNIVERSARY, CUSTOM_EVENT, ANNUAL_AFTER_DEATH (waiting on product decisions); per-recipient
      release/delivery records
- [x] Frontend: schedule picker (FIXED_DATE with timezone offset, ON_DEATH, AFTER_DEATH), change timing, unschedule → **FE-15** (Step 18) (Playwright verified, Step 21)

### 17 · Redis + BullMQ — 🟡 8 (+1 partly) of 10

**Done**

- [x] Step 12 (`docs/message-release.md`): `bullmq` + `ioredis`, queue `message-release` on `QUEUE_REDIS_URL` or
      `REDIS_URL`; sessions keep the `redis` client
- [x] `MessageRelease` audit row (unique `messageId`), migration `add_message_release_execution`; SCHEDULED → RELEASED +
      release row in one locked transaction
- [x] Reconciler (startup + every 60 s) rebuilds jobs within the 24 h lookahead from PostgreSQL; overdue run immediately
- [x] Worker re-checks PostgreSQL: stale jobs no-op, early jobs re-delayed, no live recipient blocks, DB errors retried
      (5 attempts, exponential backoff)
- [x] Deterministic job id `message-release-<messageId>`, id-only payload, bounded job history; no release endpoint
- [x] Unit tests + e2e with real PostgreSQL, Redis and BullMQ (release, duplicates, stale, reschedule, death triggers,
      recovery, read-only)
- [x] Step 15 `death-verification` queue: delayed safeguard job per case + reconciler (notice retries, overdue
      safeguards, missing activations); release reconciler also queues verified death-trigger activations

**To do**

- [x] Delivery worker for email (Step 24): `email-delivery` queue, `ReleaseNotification` row per grant (unique), job id
      per row, provider-neutral idempotency keys, backoff, reconciler. SMS is out of scope (phase 20)
- [~] Dead-letter handling, queue monitoring and alerts: **monitoring done (Step 16)**: `GET /admin/system/queues`,
  failed-job list (sanitized) and retry (audited; the worker re-checks PostgreSQL). Exhausted jobs stay in BullMQ's
  `failed` set for 7 days; a real DLQ and alerting are still open
- [ ] Separate worker process (currently runs inside the API process)

---

## 🚪 Part 5 — Portals and death verification

> Phases 18–19. The two outside audiences: **Recipients**, who read what was released to them, and **Trusted
> Contacts**, who report a death. Neither is a User, and neither can see anything else.

### 18 · Recipient portal — 🟡 5 of 7

**Done**

- [x] Recipient authentication by email OTP (no password), separate Redis session + `for_after_recipient_session` cookie (Step 13)
- [x] View only released messages, authorized by release-time `RecipientMessageAccessGrant` snapshots (Step 13)
- [x] Secure media access: READY PHOTO/AUDIO via short-lived signed URLs (Step 13)

**To do**

- [ ] SMS OTP (mobile-only Recipients already get access grants)
- [x] Email OTP delivery and a "message is waiting" email after each release (Step 24, one provider for both
      portals; [`email-production-setup.md`](email-production-setup.md))
- [ ] Grant revocation, sender display name, read receipts (product decisions open)
- [x] Frontend: calm, simple recipient experience → **FE-21** to **FE-23** (Step 19) (Playwright verified, Step 21)

### 19 · Death verification — 🟡 13 of 15

> ⚠️ **Report ≠ verification ≠ release.** Only an admin, after the safety notice and the safeguard window, can verify.

**Done (Step 14: report intake)**

- [x] Trusted Contact reports death (`docs/death-verification.md`): `DeathVerificationCase` (one per Customer) +
      `DeathReport` (one per contact, reporter snapshot), migrations `add_death_report_intake` and `death_report_owner_deletion`
- [x] `POST /trusted-contact/accounts/:id/death-reports` → `201 PENDING_VERIFICATION`; duplicate → 409; date-only, not in
      the future; note ≤ 2000, never logged; `confirmReport: true` required; injected fields → 400
- [x] `GET /trusted-contact/accounts/:id/death-verification`: status, reportedByYou, openedAt only (no counts or reporters)
- [x] A second Trusted Contact reports into the same case; nothing is verified automatically
- [x] A report changes no User, Message, schedule, release or access grant (verified by unit, e2e and live checks)

**Done (Step 15: verification workflow)**

- [x] Account-holder safety notice through provider-neutral `DeathNoticeDelivery` (console in development; email in
      Step 17); failures keep the case `PENDING_VERIFICATION` and are retried; Step 14 cases picked up automatically
- [x] Safeguard window (`DEATH_VERIFICATION_SAFEGUARD_SECONDS`, default 14 days), started only after a successful notice
      and stored per case; `SAFEGUARD_ACTIVE → READY_FOR_REVIEW` by a delayed BullMQ job + reconciler
- [x] Customer "I'm still alive": `GET /death-verification/me`, `POST …/confirm-alive` → `CANCELLED` from any open status
      (Phase 10: a later report then opens a new case; see the product decision in Part 1)
- [x] Admin review (minimal): list, detail, verify (`verifiedDeathAt` with timezone, not future) and reject, only from
      `READY_FOR_REVIEW`, no override
- [x] Verified: account `PASSED` in the same transaction (login 403, sessions 401); ON_DEATH/AFTER_DEATH activation and
      release through the Step 12 queue with Step 13 access grants
- [x] Atomic decisions (exactly one of confirm-alive / verify / reject wins) + `DeathVerificationAuditEvent` trail
- [x] Migration `add_death_verification_workflow` (additive); unit, e2e (17) and live Postman checks

**To do**

- [ ] Evidence upload (death certificate etc.) to private storage
- [ ] Second confirmation when a second Trusted Contact exists (today: supporting report only)
- [x] Frontend: Trusted Contact portal → **FE-24** to **FE-27** and Customer safety banner + confirm-alive (Step 19,
      component-tested); admin review UI → **FE-28** (Step 20: list, detail with the case's event timeline, verify with an
      explicit offset `verifiedDeathAt` + confirmation, reject, 409 "case changed" + refetch; verified live: VERIFIED →
      PASSED → ON_DEATH release by the backend, reject, confirm-alive race)

---

## 🎨 Part 6 — Frontend

> The frontend lives in `D:\FOR-AFTER-DIGITAL-VAULT\for-after-frontend` (Steps 17–20; its own tracker is `docs/tasks.md`), next to `for-after-backend` and
> `postman`. See its README for setup, the auth architecture and tests. The backend for 25 of the 30 tasks below is
> already built and tested.

### Frontend summary — 🟡 27 of 30 done

| Group                      | Tasks  |     Done     |            Backend ready             |
| -------------------------- | :----: | :----------: | :----------------------------------: |
| A. Foundation              |   6    |  ✅ 6 of 6   |                 n/a                  |
| B. Customer account        |   3    |  ✅ 3 of 3   |                3 of 3                |
| C. Customer vault features |   11   | 🟡 10 of 11  |               10 of 11               |
| D. Recipient portal        |   3    |  ✅ 3 of 3   |                3 of 3                |
| E. Trusted Contact portal  |   4    |  ✅ 4 of 4   |                4 of 4                |
| F. Admin portal            |   1    |  ✅ 1 of 1   |                1 of 1                |
| G. WordPress               |   2    |    0 of 2    |                1 of 2                |
| **Total**                  | **30** | **27 of 30** | **27 of 30** (FE-1 needs no backend) |

**Stack (phase 07, built in Step 17):** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui
(Radix) · TanStack Query 5 · React Hook Form + Zod 4 · Lucide · Vitest + RTL · Playwright. All API calls use cookies
(`credentials: 'include'`), never tokens; `GET /auth/me` is the only auth source of truth.

**🎯 First milestone (§60):** create user → login → session → `/auth/me` → dashboard opens (FE-1 to FE-5 + FE-8).
✅ Reached in Step 17 and covered by Playwright against the real local API.

### 07 · Next.js dashboard shell = A. Foundation — ✅ 6 of 6

|  #   | Task                                                                                                             | Backend  |
| :--: | ---------------------------------------------------------------------------------------------------------------- | :------: |
| FE-1 | ✅ Create the Next.js app with the planned stack (Step 17)                                                       |   n/a    |
| FE-2 | ✅ API client that sends cookies and handles `401` / `403` / `409` / `429` consistently (`ApiError`)             | ✅ ready |
| FE-3 | ✅ Auth-aware layout: redirect to login when `/auth/me` returns 401; 403 shown as access denied; admins kept out | ✅ ready |
| FE-4 | ✅ Dashboard layout: sidebar, mobile sheet navigation, header with current Customer, logout                      | ✅ ready |
| FE-5 | ✅ Dashboard home page (welcome + vault overview; future sections marked "Coming soon", no invented stats)       | ✅ ready |
| FE-6 | ✅ Shared loading, error and empty states (`PageLoader`, `Spinner`, `ErrorState`, `EmptyState`, form fields)     |   n/a    |

### B. Customer account — ✅ 3 of 3

|  #   | Task                                                                                                                                                                                                  | Phase | Backend  |
| :--: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---: | :------: |
| FE-7 | ✅ `/dev-login` page for local development; real `404` in production builds (Step 17)                                                                                                                 |  06   | ✅ ready |
| FE-8 | ✅ Register / login pages in the app (WordPress forms are FE-29). Register → `/login` (backend creates no session)                                                                                    |  04   | ✅ ready |
| FE-9 | ✅ Account settings (`/settings`, account menu): first/last name (header refreshes), email read-only with a verified "Change email" dialog (Phase 08), password change (Step 22; Playwright verified) |  08   | ✅ ready |

### C. Customer vault features — 🟡 10 of 11 (Step 18; Playwright verified, Step 21)

|   #   | Task                                                                                                                                                                   | Phase |    Backend     |
| :---: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---: | :------------: |
| FE-10 | ✅ People I Love: list (paged), add, view, edit, remove, private photo                                                                                                 |  09   |    ✅ ready    |
| FE-11 | ✅ Trusted Contacts: list, add, edit, remove, max 2, invitation status + resend (Phase 10)                                                                                    |  10   |    ✅ ready    |
| FE-12 | ✅ Messages: create/edit draft, choose content type, assign recipients                                                                                                 |  11   |    ✅ ready    |
| FE-13 | ✅ Message media: photo/audio upload with progress + cancel (presigned PUT → complete), previews, delete. ⚠️ Real browser uploads need the bucket CORS rule (phase 12) |  12   |    ✅ ready    |
| FE-14 | ✅ Audio recorder in the browser (MediaRecorder, WebM/MP4 by browser; video recorder waits for the video pipeline)                                                     |  12   | ✅ audio ready |
| FE-15 | ✅ Schedule picker: FIXED_DATE with timezone, ON_DEATH, AFTER_DEATH + days; change timing; unschedule                                                                  |  16   |    ✅ ready    |
| FE-16 | ✅ Message status views (DRAFT / SCHEDULED / RELEASED) and the explicit "unschedule to edit" flow                                                                      |  16   |    ✅ ready    |
| FE-17 | ✅ Memory Vault: list/filter by category, create/edit/delete, photo/audio media                                                                                        |  13   |    ✅ ready    |
| FE-18 | ✅ My Story: prompts by category, answer/edit/delete                                                                                                                   |  14   |    ✅ ready    |
| FE-19 | ✅ My Wishes: prompts by category, answer/edit/delete, exact non-legal disclaimer                                                                                      |  15   |    ✅ ready    |
| FE-20 | ⬜ Plan/billing pages (Stripe checkout and portal)                                                                                                                     |  21   |  ⬜ not built  |

### D. Recipient portal — ✅ 3 of 3 (Step 19; Playwright verified, Step 21)

|   #   | Task                                                                              | Phase |      Backend       |
| :---: | --------------------------------------------------------------------------------- | :---: | :----------------: |
| FE-21 | ✅ Recipient sign-in: email → 6-digit code (one accessible field, paste, resend)  |  18   | ✅ ready (Step 13) |
| FE-22 | ✅ Released messages list and message page: calm, simple, distraction-free        |  18   |      ✅ ready      |
| FE-23 | ✅ Photo/audio viewing through short-lived signed URLs (lightbox, per-item retry) |  18   |      ✅ ready      |

### E. Trusted Contact portal — ✅ 4 of 4 (Step 19; Playwright verified, Step 21)

|   #   | Task                                                                                                                                            | Phase |      Backend       |
| :---: | ----------------------------------------------------------------------------------------------------------------------------------------------- | :---: | :----------------: |
| FE-24 | ✅ Trusted Contact sign-in: email → 6-digit code                                                                                                |  10   | ✅ ready (Step 14) |
| FE-25 | ✅ Accounts list: account holder name, "preserved content exists" flag, case status                                                             |  10   |      ✅ ready      |
| FE-26 | ✅ Death report form: optional date (not in future), optional note, summary, required confirmation; "report ≠ verification" wording; 409 states |  19   |      ✅ ready      |
| FE-27 | ✅ Case status page: all six statuses in plain words, "reported by you", opened date                                                            |  19   |      ✅ ready      |

### F. Admin portal — ✅ 1 of 1

|   #   | Task                                                                                                                                                                                                                                                                                                                            | Phase |      Backend       |
| :---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---: | :----------------: |
| FE-28 | ✅ Admin portal (Step 20): password + mandatory TOTP sign-in, first-time enrolment with recovery codes, recovery-code sign-in, users (search/filter/suspend/reactivate), death-verification review (verify/reject), audit log viewer, queues (failed jobs, retry). Component-tested, Playwright + live run against the real API |  22   | ✅ ready (Step 16) |

### G. WordPress — ⬜ 0 of 2

|   #   | Task                                                                                         | Phase |      Backend       |
| :---: | -------------------------------------------------------------------------------------------- | :---: | :----------------: |
| FE-29 | ⬜ WordPress login/signup forms on `forafter.com.au` calling the NestJS API                  |  25   |      ✅ ready      |
| FE-30 | ⬜ Redirect to `app.forafter.com.au/dashboard` after login, shared `.forafter.com.au` cookie |  25   | ⬜ config not done |

Frontend testing (component + Playwright E2E) is tracked in phase 24 and applies to every task above.

---

## ⚙️ Part 7 — Platform services

> Phases 20–23. Shared services the product needs before launch. None started yet.

### 20 · Notifications — 🟡 2 of 5

- [x] Email provider with templates (Step 24): **Brevo** behind a provider-neutral `EmailProvider` (`brevo` |
      `resend` optional, inactive | `console` dev-only | `disabled`; production requires `brevo` or `resend`), four HTML + text templates with no preserved
      content, fake inbox for tests ([`email-production-setup.md`](email-production-setup.md))
- [x] Brevo adapter (`BrevoEmailProvider`, REST over `fetch`, no SDK); dev sender is a Brevo-verified personal
      address, no custom domain. Opt-in live test: `BREVO_LIVE_TEST=1 npx vitest run src/email/brevo-email-provider.live.spec.ts`
- [x] Brevo `401 unauthorized` on an eligible Recipient OTP (2026-10-05): cause was Brevo's authorised-IP check
      (unrecognised IP). IP blocking turned off for development; read-only checks then passed authentication.
      Troubleshooting table in [`email-production-setup.md`](email-production-setup.md) §4
- [ ] **Manual:** confirm an eligible Recipient OTP and a Trusted Contact OTP arrive in a real inbox (restart the API
      first if `.env` changed)
- [ ] **Manual (production):** authenticate a For After domain in Brevo, move `EMAIL_FROM_ADDRESS` to it, turn
      tracking off, turn authorised-IP blocking back on with the production IPs
- [ ] SMS via Twilio
- [x] Notifications sent today (Step 24): Recipient and Trusted Contact sign-in codes, "a message is waiting for you"
      after a release (durable, retried, one per grant), account-holder safety notice when a death report starts the
      safety check
- [x] Recipient release notifications (Step 24.1): one email per released Message per assigned Recipient with an email,
      only after the release and the access grant (FIXED_DATE, ON_DEATH, AFTER_DEATH at its real release time), greeting
      by first name ("Hello," without one), no content. Idempotent on the access grant; a Recipient without email still
      gets the release and grant; a provider failure never undoes a release. Worker and reconciler skip deleted
      messages, matching OTP eligibility. Details: [`email-production-setup.md`](email-production-setup.md) §3
- [x] Account and invitation emails: email verification and password reset (Phase 04), Trusted Contact invitations
      (Phase 10). SMS OTP and SMS invitations are deferred (see Twilio above)

### 21 · Stripe billing — ⬜ 0 of 6

- [ ] Stripe Billing: plans, free trial, monthly/annual
- [ ] Checkout, billing portal, invoices
- [ ] Webhooks (signature-verified, idempotent)
- [ ] Failed-payment handling, upgrade/downgrade/cancel
- [ ] Plan limits (storage, recipients, trusted contacts)
- [ ] Subscription-after-death behaviour (per product decision)

### 22 · Admin portal — 🟡 6 (+1 partly) of 7

- [x] Death-verification review + decision API (Step 15): `/admin/death-verifications` list, detail, verify, reject;
      paginated and audited since Step 16
- [x] Admin APIs (separate, audited; not the customer endpoints): `/admin/*` + `/admin-auth/*` (Step 16, `docs/admin.md`)
- [x] Users: search (email/name, case-insensitive), view (metadata + counts, never content; audited), suspend and
      reactivate (never `PASSED`; `ADMIN` → Customers, `SUPER_ADMIN` → also admins; no self-change) (Step 16)
- [~] Subscriptions, deliveries, failed jobs: **failed jobs done** (Step 16). Admin subscription management deferred until
  the Stripe backend exists (Phase 21); admin delivery monitoring deferred until the delivery worker/data model exists
  (Phase 17/20). No billing or delivery data was invented
- [x] Audit log viewer: `GET /admin/audit-logs` (event, actor, subject, date filters, paginated) + detail (Step 16)
- [x] Admin 2FA required (Step 16): mandatory TOTP + recovery codes, admin idle timeout
- [x] Frontend: admin portal → **FE-28** (Step 20, `for-after-frontend/src/components/admin/`); no billing, delivery,
      role-editing, deletion or force-release UI (no such APIs)

Open (not checklist items yet): admin MFA reset / recovery-code regeneration API, re-authentication for sensitive
actions, role management (deliberately no API).

### 23 · Audit + security — 🟡 2 (+1 partly) of 7

- [~] `AuditLog` model and events: **model + admin events built (Step 16)**, append-only (DB trigger), IP stored as a
  /24 or /48 prefix. Admin sign-in, MFA, logout, user status changes, user/death-case views, death decisions and job
  retries are recorded. Step 22 adds actor `CUSTOMER` and `PASSWORD_CHANGED`. Other Customer-side events
  (USER_CREATED, RECIPIENT_UPDATED, MESSAGE_RELEASED, …) are still open
- [x] Never store passwords, OTPs or message content in audit data (Step 16: scalar-only metadata, secret-like keys
      dropped; unit + e2e tested)
- [ ] Data export (background job, private temporary archive)
- [ ] Account deletion workflow (re-auth, grace period, export, cancel schedules, delete media)
- [ ] Dependency scanning (npm audit / Dependabot)
- [x] Step 23 full application audit, bug bash and hardening: [`step-23-audit.md`](step-23-audit.md) (issue register,
      verification, deferred items). 0 P0/P1; SEC-002 (CSRF Origin check) fixed; SEC-001 (a local DB password in the
      initial commit's `docs/development-guide.md`) to rotate if it was ever reused; separate admin cookie deferred
- [ ] Threat-model review against `threat-model.md` (repo root; updated for Step 14 on 2026-09-29)

---

## 🚀 Part 8 — Quality and launch

> Phases 24–27. Testing, WordPress hand-off, staging and production.

### 24 · Testing — 🟡 5 of 7

**Done**

- [x] Unit tests: **615 passing** (31 files)
- [x] E2E tests on real PostgreSQL + Redis + BullMQ: **162 passing** (15 files: auth, recipients, trusted contacts,
      messages, schedules, media with mocked storage, message composition, memory vault, my story, my wishes, message
      release, recipient portal, trusted contact portal, death verification, **admin backend (Step 16, 20 tests)**)
- [x] Step 16 Postman folder **17-Admin-Backend** (66 requests) + folder 16 admin logins updated for TOTP. Its TOTP
      pre-request script was checked against `otplib`; the admin flow was verified live against the built API with a
      scripted smoke test. The folder itself has **not** been run in the Postman app yet
- [x] Postman collection for Steps 1–15 (`postman/collections/FOR-AFTER`, 262 requests in 16 folders); live run: folder 16
      59/59, folders 1–15 all pass except one throttling artifact of the test runner (7 manual upload steps skipped)
- [x] Intermittent e2e suite-start failures fixed: they were 10 s `beforeAll` timeouts under 14 parallel real-app boots;
      e2e hook/test timeouts are now 60 s / 30 s

**To do**

- [x] Step 24: email unit tests (provider selection and production guards, Brevo and Resend error mapping, timeout, templates,
      worker) and `test/email-delivery.e2e-spec.ts` (9 tests, fake inbox: OTP emails, release → one minimal email →
      Recipient sign-in, re-release/reconcile sends nothing new, provider outage → FAILED → admin retry → SENT, safety
      email and the cancelled-before-send race); Playwright reads codes and the release email from the console provider
- [x] Step 24.1: 7 more `email-delivery` e2e tests (DRAFT/SCHEDULED/unscheduled send nothing; 3 Recipients + 1 without
      email → 3 emails with one isolated transient failure retried to SENT; privacy; re-release + both reconcilers send
      nothing new; second message → second email; the email is not a sign-in; report/safeguard send nothing, ON_DEATH at
      verification, AFTER_DEATH only at its release) and a `ReleaseNotificationQueue` unit spec. E2E suites that boot
      the release workers now run one file at a time (`vitest.config.e2e.ts`): they share one database, and a suite
      booting mid-test could release and email another suite's due message through its own `disabled` provider
- [x] Step 22: backend `test/account.e2e-spec.ts` (23 tests: profile, password, session revocation, cross-principal,
      audit) + unit tests; frontend 14 component tests and `e2e/account.spec.ts` (3 Playwright tests, real API)
- [x] Frontend component and E2E tests (`for-after-frontend`): Vitest + RTL **185 passing** (13 files); Playwright
      **31 passing** against the real local API, PostgreSQL, Redis and the development bucket (Step 21, 2026-10-02):
      Customer auth and `/dev-login` (dev and production build), vault CRUD, real browser photo/audio/recorded uploads to
      READY, failed upload → retry, scheduling, Recipient OTP → real FIXED_DATE release → read, Trusted Contact OTP → death
      report → Customer "I'm still alive", admin password + TOTP enrolment, suspend/reactivate, verify/reject, queues,
      cross-portal session isolation. Step 21 fixed one frontend bug (lost death-report confirmation, FE-26); no backend
      code changed
- [ ] Critical security test cases from overview §50 (recipient reading unreleased messages/media is covered by
      `test/recipient-portal.e2e-spec.ts` since Step 13)
- [ ] Load test for delivery workers

### 25 · WordPress authentication integration — ⬜ 0 of 3

- [ ] WordPress login/signup forms (`forafter.com.au/login`, `/signup`) calling the NestJS API → **FE-29**
- [ ] Shared cookie domain `.forafter.com.au`, CORS for WordPress origin
- [ ] Redirect to `app.forafter.com.au/dashboard` after login → **FE-30**

### 26 · Staging — 🟡 2 of 6

Client demo on Railway (2026-10-06), Railway-generated domains, no custom domain yet. The frontend proxies `/api/v1`
to the API over Railway private networking (`API_PROXY_TARGET`, `next.config.ts`): two `*.up.railway.app` hosts are
cross-site, so the API's `SameSite=Lax` cookies would not reach it directly. Once `app.`/`api.forafter.com.au` exist,
drop the proxy and point `NEXT_PUBLIC_API_BASE_URL` at the API. Short `DEATH_VERIFICATION_SAFEGUARD_SECONDS=60` is
demo-only.

- [x] Choose hosting: Railway (demo/staging; production region still open, see §27)
- [ ] Railpack builds for API and frontend (no Dockerfile needed); separate worker process still open (workers run in the API)
- [x] Managed PostgreSQL and Redis (Railway; `prisma migrate deploy` as the pre-deploy step)
- [ ] GitHub Actions: lint → type check → tests → build → deploy staging → E2E
- [ ] Staging secrets separate from production; Stripe test mode
- [ ] Client review / QA pass

### 27 · Production — ⬜ 0 of 9

- [ ] Production infrastructure in Australian region; TLS on all domains
- [ ] Secrets manager (no `.env` files on servers)
- [ ] Manual approval step before production deploy
- [ ] Automated PostgreSQL backups + point-in-time recovery, **restore tested**
- [ ] Object storage versioning / lifecycle
- [ ] Monitoring: Nest Observe, Sentry, uptime checks, queue alerts
- [ ] Incident response runbook (`docs/incident-response.md`)
- [ ] Privacy policy, terms, data-retention policy
- [ ] Launch 🎉

---

## 🚫 Out of scope for MVP

> From overview §54. Not planned for the first release.

Native iOS/Android apps · AI features · fully automated death verification · hospital/charity integrations ·
white-label platform · shared family vaults · printed books · multi-language.

---

## 🧹 Housekeeping

**Done**

- [x] Docs aligned with code (`REDIS_URL`, no JWT)
- [x] Dummy test users and recipients removed from the dev database
- [x] `.env.example` with placeholder values (no secrets)
- [x] `.gitignore` covers `.env`, `.env.local`, `.env.production`, `.env.*.local`; `.env` never committed
- [x] Secret audit: no credentials outside `.env`
- [x] Development guide: `APP_ENV` → `NODE_ENV`
- [x] All docs updated for Step 14 and given a consistent layout (summary card, contents, numbered sections)

**To do**

- [ ] Commit Steps 7–14 (currently uncommitted)
- [ ] Put `for-after-frontend` under version control (Step 17): it is not in the backend repo, and the root
      `D:\FOR-AFTER-DIGITAL-VAULT` git repo has no commits yet. Decide: its own repo, or a root monorepo
- [ ] Dev account `jiya@gmail.com` was re-registered with a password other than the one the Postman collection uses; reset it
- [ ] Approve Prisma install script (`npm install-scripts approve prisma`) after the npm warning
- [x] Run Prettier on 7 older files flagged by `prettier --check` (done during Step 15; formatting only)
- [x] Fix 2 `tsc` errors in test files outside the build (`message-release.service.spec.ts`, `test/app.e2e-spec.ts`):
      already fixed in the working tree before Step 16; `npx tsc --noEmit` (includes tests) verified clean at Step 16
- [ ] Postman workspace collection (`postman/collections/FOR-AFTER/.resources/definition.yaml`) stores passwords as
      plain collection variables (`customerPassword`, `adminPassword`, `dvCustomerPassword`); move them to local current
      values and rotate the `jiya@gmail.com` dev password before that folder is ever committed
- [ ] Parallel e2e files share one database, so a release reconciler can queue another file's due messages: tests
      must assert on their own job ids, not global queue counts (fixed in `trusted-contact-portal.e2e-spec.ts` in Step 16)

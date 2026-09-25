# For After — Project Task List

Full-stack roadmap from local development to production. Order follows
`for-after-backend/docs/PROJECT_OVERVIEW.md` §59 (Recommended Development Sequence).

**Legend:** `[x]` done and verified · `[~]` partly done · `[ ]` not started

**Last updated:** 2026-09-25

## Progress summary

| Phase | Area | Status |
|---|---|---|
| 01 | Product decisions | 🟡 Partly done (docs exist, key decisions open) |
| 02 | PostgreSQL + Prisma | ✅ Done |
| 03 | NestJS foundation | ✅ Done |
| 04 | Authentication (core) | ✅ Done |
| 05 | Sessions + authorization | 🟡 Partly done |
| 06 | Local development login | 🟡 Backend ready, page not built |
| 07 | Next.js dashboard shell | ⬜ Not started |
| 08 | User profile | ⬜ Not started |
| 09 | People I Love (Recipients) | 🟡 Backend done, UI not built |
| 10 | Trusted Contacts | 🟡 Backend done, UI not built |
| 11 | Messages | 🟡 Backend done (TEXT drafts), UI not built |
| 12 | Media | 🟡 Photo/audio backend done (B2), video/quotas not started |
| 13–15 | Memory Vault, My Story, My Wishes | ⬜ Not started |
| 16 | Scheduling | 🟡 Schedules stored (3 triggers), nothing executes them yet |
| 17–27 | BullMQ → Production | ⬜ Not started |

---

## 01 Product decisions

- [x] Product documentation written (`docs/`: PRD, overview, architecture, database, API, auth, security, threat model, deployment)
- [ ] Trusted Contacts: one or two? mandatory? replacement rules? exact permissions?
- [ ] Trusted Contacts: can they see message titles, or that unreleased content exists?
- [ ] Death verification: accepted evidence, number of confirmations, admin review rules
- [ ] Scheduling: rules for birthdays, anniversaries, after-death and annual releases (BIRTHDAY needs: timezone, time of day, 29 Feb, several recipients with different birthdays, recurrence)
- [ ] Scheduled messages are locked (edit = unschedule → edit → reschedule): is that the UX we want?
- [ ] What happens at release time if all assigned recipients were deleted after scheduling?
- [ ] When is a message `CANCELLED`, and can it ever be restored?
- [ ] Limits: message text 20,000 chars, 100 recipients per message, after-death offset ≤ 36,500 days (all configurable placeholders)
- [ ] Should `FAILED` media uploads be hidden from the list or cleaned up?
- [ ] Subscription after death: what happens to billing and access
- [ ] Storage tiers and limits (placeholders: Basic 5 GB, Standard 25 GB, Legacy 100 GB)
- [ ] Recipient access: downloads, original quality, permanent access, sharing
- [ ] Is a person who is both Recipient and Trusted Contact one linked record?
- [ ] Duplicate Recipients / Trusted Contacts per customer: allowed or blocked?
- [ ] Can a `PASSED` account ever sign in?
- [ ] Account deletion and data retention policy (legal review)

## 02 PostgreSQL + Prisma

- [x] PostgreSQL `for_after` database
- [x] Prisma 7 with `@prisma/adapter-pg`, client generated to `src/generated/prisma`
- [x] `User` model with `UserRole` (CUSTOMER, ADMIN, SUPER_ADMIN) and `UserStatus`
- [x] Migration `init`
- [x] `PrismaModule` / `PrismaService`, fails fast if the database is unreachable
- [x] Database errors logged without connection details

## 03 NestJS foundation

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
- [ ] Swagger / OpenAPI docs page (package installed, not configured)
- [ ] Global exception filter so unexpected errors never leak details

## 04 Authentication

- [x] `POST /auth/register` (customers only; role/status cannot be sent)
- [x] `POST /auth/login` (generic error, same timing for unknown email)
- [x] `POST /auth/logout` (destroys session, clears cookie)
- [x] `GET /auth/me`
- [x] Argon2id password hashing
- [x] Email normalised to lowercase; duplicate email → 409
- [x] Only `ACTIVE` accounts can sign in
- [x] Rate limit: 5 requests/min per IP on register and login
- [ ] Email verification
- [ ] Password reset (email link with expiry)
- [ ] Change password (with re-authentication)
- [ ] TOTP two-factor authentication (required for admins)
- [ ] Move rate-limit storage to Redis before running more than one API instance

## 05 Sessions + authorization

- [x] Redis-backed sessions (`connect-redis`), no in-memory fallback
- [x] HttpOnly `for_after_session` cookie, SameSite=Lax, Secure in production
- [x] Session ID regenerated on login
- [x] `SessionAuthGuard` reloads the user every request (suspension applies immediately)
- [x] `@CurrentUser()` decorator
- [x] `CustomerGuard` (customer-only routes; admins get 403)
- [x] Ownership pattern: every query scoped to `ownerUserId` + `deletedAt: null`, not-owned → 404
- [ ] Admin / SUPER_ADMIN guards for admin APIs
- [ ] Session timeout on inactivity for admins
- [ ] "Sign out all devices"
- [ ] CSRF review for cookie-based requests from WordPress and Next.js domains

## 06 Local development login

- [x] Backend login API usable locally (`localhost:4000/api/v1/auth/login`)
- [ ] Next.js `/dev-login` page (localhost:3000), disabled in production

## 07 Next.js dashboard shell

- [ ] Create Next.js app (TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, React Hook Form + Zod, Lucide)
- [ ] API client that sends cookies (`credentials: 'include'`)
- [ ] Auth-aware layout: redirect to login when `/auth/me` returns 401
- [ ] Dashboard layout: navigation, header, logout
- [ ] Dashboard home page
- [ ] Loading, error and empty states
- [ ] **Milestone (§60):** create user → login → session → `/auth/me` → dashboard opens

## 08 User profile

- [ ] Backend: view/update own profile (name), change email (with verification)
- [ ] Frontend: profile and account settings pages

## 09 People I Love (Recipients)

- [x] `Recipient` model + migration `add_recipients` (not a login account)
- [x] CRUD API: `POST/GET /recipients`, `GET/PATCH/DELETE /recipients/:id`
- [x] Validation: email normalised, basic phone format, date-only birthday, private note ≤ 2000
- [x] Soft delete; `ownerUserId`/`deletedAt` never returned
- [x] Unit tests + real-PostgreSQL e2e tests incl. cross-user isolation
- [ ] Pagination on the list endpoint (when needed)
- [ ] Recipient photo (after Media, phase 12)
- [ ] Frontend: list, add, edit, remove "People I Love"

## 10 Trusted Contacts

- [x] `TrustedContact` model + migration `add_trusted_contacts` (not a login account, no content access)
- [x] CRUD API: `POST/GET /trusted-contacts`, `GET/PATCH/DELETE /trusted-contacts/:id`
- [x] Email or mobile required, kept on every PATCH, also enforced by a database CHECK
- [x] Soft delete; ownership isolation; unit + e2e tests
- [ ] Maximum per customer (waiting on product decision)
- [ ] Invitation email/SMS and acceptance flow
- [ ] Trusted Contact identity verification (OTP)
- [ ] Permission model (waiting on product decision)
- [ ] Frontend: manage Trusted Contacts

## 11 Messages

- [x] `Message` model + migration `add_messages`: `MessageContentType` (TEXT/VIDEO/AUDIO/PHOTO/MIXED), `MessageStatus` (DRAFT/SCHEDULED/RELEASED/CANCELLED)
- [x] API accepts TEXT only; every message created as DRAFT; `status`/`ownerUserId` never accepted from the client
- [x] `MessageRecipient` join (many-to-many), unique per pair; only the owner's live recipients can be assigned (generic 400 otherwise)
- [x] CRUD API: `POST/GET /messages`, `GET/PATCH/DELETE /messages/:id`; PATCH replaces recipients atomically; only DRAFT is editable/deletable (409)
- [x] Soft delete; ownership isolation (404); responses hide `ownerUserId`, `deletedAt`, join-table ids
- [x] Unit tests + real-PostgreSQL e2e tests incl. cross-user and transaction cases
- [ ] Rich messages (PHOTO / AUDIO / VIDEO / MIXED content types) built on Media
- [ ] Pagination / summary list (list currently returns full text)
- [ ] Soft-deleting a message should also clean up its media (currently left for reconciliation)
- [ ] Frontend: create/edit message flow, assign recipients

## 12 Media

- [x] Private Backblaze B2 dev bucket via the S3-compatible API (`@aws-sdk/client-s3`, `s3-request-presigner`); provider-neutral `MediaStorage` abstraction
- [x] `MediaAsset` model + migration `add_media_assets` (`MediaKind`, `MediaAssetStatus`, DB CHECK: PHOTO/AUDIO only, size > 0)
- [x] Direct upload: `POST /messages/:id/media/upload-url` → presigned PUT (Content-Type signed, 10 min) → `POST …/complete` verifies with HeadObject → READY / FAILED
- [x] PHOTO (jpeg/png/webp, ≤ 20 MB) and AUDIO (mpeg/mp4/webm/wav, ≤ 100 MB); VIDEO and SVG rejected; server-generated storage keys
- [x] List, presigned GET access URL (5 min, READY only), soft delete + best-effort object delete; changes only on DRAFT messages
- [x] Owner-only; storage errors sanitized (503); signed URLs never stored or logged
- [x] Unit + e2e tests with mocked storage; manual end-to-end check against the real B2 bucket passed
- [ ] Video via Mux or Cloudflare Stream (upload, processing webhooks, signed playback)
- [ ] Malware scanning / quarantine, magic-byte checks (MIME header is not content validation)
- [ ] Cleanup job for stale `PENDING_UPLOAD` rows and orphaned objects
- [ ] Restricted bucket CORS for browser uploads (when the frontend exists)
- [ ] Storage usage tracking and quota enforcement (80/90/100% warnings)
- [ ] Separate production bucket and credentials
- [ ] Frontend: upload with progress, video/audio recorder, previews

## 13 Memory Vault

- [ ] Backend: memories (photos, notes, stories) scoped to owner
- [ ] Frontend: Memory Vault pages

## 14 My Story

- [ ] Backend: life-story sections
- [ ] Frontend: My Story editor

## 15 My Wishes

- [ ] Backend: wishes (funeral, personal, practical)
- [ ] Frontend: My Wishes pages

## 16 Scheduling

- [x] `ReleaseTriggerType` enum (all 8 product types) + `MessageSchedule` (one per message), migration `add_message_schedules`
- [x] API: `POST/GET/PATCH/DELETE /messages/:id/schedule`; supports FIXED_DATE, ON_DEATH, AFTER_DEATH (others → 400, reserved)
- [x] DRAFT → SCHEDULED on create, SCHEDULED → DRAFT on delete, both atomic; nothing sets RELEASED
- [x] FIXED_DATE needs an explicit timezone offset, stored as UTC, must be in the future; DB CHECK enforces fields per trigger
- [x] Stored in PostgreSQL only (no Redis-only schedules, no `setTimeout`)
- [x] Unit + e2e tests incl. cross-user isolation
- [ ] NOW, BIRTHDAY, ANNIVERSARY, CUSTOM_EVENT, ANNUAL_AFTER_DEATH (waiting on product decisions)
- [ ] Release engine that executes schedules (phase 17), per-recipient release/delivery records
- [ ] Frontend: schedule picker per message

## 17 Redis + BullMQ

- [ ] BullMQ queues using `REDIS_URL`
- [ ] Scanner job that moves due schedules from PostgreSQL into queues
- [ ] Delivery worker with retries, idempotency keys, dead-letter handling
- [ ] Queue monitoring and alerts

## 18 Recipient portal

- [ ] Recipient authentication by email/SMS OTP (no password), scoped session
- [ ] View only released messages mapped to that recipient
- [ ] Secure media playback / downloads
- [ ] Frontend: calm, simple recipient experience

## 19 Death verification

- [ ] Trusted Contact reports death, uploads evidence (private storage)
- [ ] Second confirmation when a second Trusted Contact exists
- [ ] Admin review: approve / reject, statuses per `docs/death-verification.md`
- [ ] Safety waiting period before ON_DEATH releases
- [ ] Customer "I'm still alive" cancellation path
- [ ] Mark user `PASSED`, trigger after-death schedules

## 20 Notifications

- [ ] Email provider (Postmark or AWS SES) with templates
- [ ] SMS via Twilio
- [ ] Notifications: verification, password reset, invitations, releases, death-verification steps

## 21 Stripe

- [ ] Stripe Billing: plans, free trial, monthly/annual
- [ ] Checkout, billing portal, invoices
- [ ] Webhooks (signature-verified, idempotent)
- [ ] Failed-payment handling, upgrade/downgrade/cancel
- [ ] Plan limits (storage, recipients, trusted contacts)
- [ ] Subscription-after-death behaviour (per product decision)

## 22 Admin portal

- [ ] Admin APIs (separate, audited; not the customer endpoints)
- [ ] Users: search, view, suspend
- [ ] Subscriptions, deliveries, death-verification review queue
- [ ] Audit log viewer
- [ ] Admin 2FA required
- [ ] Frontend: admin portal

## 23 Audit + security

- [ ] `AuditLog` model and events (USER_CREATED, RECIPIENT_UPDATED, MESSAGE_RELEASED, DEATH_CONFIRMED, ADMIN_LOGIN, …)
- [ ] Never store passwords, OTPs or message content in audit data
- [ ] Data export (background job, private temporary archive)
- [ ] Account deletion workflow (re-auth, grace period, export, cancel schedules, delete media)
- [ ] Dependency scanning (npm audit / Dependabot)
- [ ] Threat-model review against `docs/threat-model.md`

## 24 Testing

- [x] Unit tests (211 passing)
- [x] E2E tests on real PostgreSQL (44 passing: auth, recipients, trusted contacts, messages, schedules, media with mocked storage)
- [ ] Frontend component and E2E tests (e.g. Playwright)
- [ ] Critical security test cases from overview §50 (e.g. recipient reading unreleased media)
- [ ] Load test for delivery workers

## 25 WordPress authentication integration

- [ ] WordPress login/signup forms (`forafter.com.au/login`, `/signup`) calling the NestJS API
- [ ] Shared cookie domain `.forafter.com.au`, CORS for WordPress origin
- [ ] Redirect to `app.forafter.com.au/dashboard` after login

## 26 Staging

- [ ] Choose hosting (recommended AWS Sydney `ap-southeast-2`)
- [ ] Dockerfile(s) for API and worker
- [ ] Managed PostgreSQL and Redis
- [ ] GitHub Actions: lint → type check → tests → build → deploy staging → E2E
- [ ] Staging secrets separate from production; Stripe test mode
- [ ] Client review / QA pass

## 27 Production

- [ ] Production infrastructure in Australian region; TLS on all domains
- [ ] Secrets manager (no `.env` files on servers)
- [ ] Manual approval step before production deploy
- [ ] Automated PostgreSQL backups + point-in-time recovery, **restore tested**
- [ ] Object storage versioning / lifecycle
- [ ] Monitoring: Nest Observe, Sentry, uptime checks, queue alerts
- [ ] Incident response runbook (`docs/incident-response.md`)
- [ ] Privacy policy, terms, data-retention policy
- [ ] Launch

---

## Out of scope for MVP (overview §54)

Native iOS/Android apps · AI features · fully automated death verification ·
hospital/charity integrations · white-label platform · shared family vaults ·
printed books · multi-language.

## Housekeeping

- [x] Docs aligned with code (`REDIS_URL`, no JWT)
- [x] Dummy test users and recipients removed from the dev database
- [ ] First git commit of Steps 1–7 (currently uncommitted)
- [x] `.env.example` with placeholder values (no secrets)
- [x] `.gitignore` covers `.env`, `.env.local`, `.env.production`, `.env.*.local`; `.env` never committed
- [x] Secret audit: no credentials outside `.env`
- [ ] Approve Prisma install script (`npm install-scripts approve prisma`) after the npm warning
- [ ] Run Prettier on 6 older files flagged by `prettier --check`
- [ ] Development guide: `APP_ENV` → `NODE_ENV`

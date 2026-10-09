# 🕊️ For After — Backend

> API for **For After**, a secure digital legacy and posthumous messaging platform. Customers record messages and
> memories for the people they love; the platform releases them on scheduled dates or after a verified death.

| | |
|---|---|
| **Scope** | Backend: NestJS + PostgreSQL + Redis. The Next.js app is in [`../for-after-frontend`](../for-after-frontend) (Steps 17–19: Customer app and vault, Recipient and Trusted Contact portals, death-verification safety banner; tracked in [`docs/tasks.md`](../for-after-frontend/docs/tasks.md) there). Postman, curl and the automated tests still work. |
| **Built** | Steps 1–16 (latest: admin backend with mandatory TOTP, user management, audit log, queue monitoring) |
| **Tests** | 615 unit · 162 e2e (real PostgreSQL + Redis + BullMQ) · Postman collection for Steps 1–16 |
| **Roadmap** | [`docs/task.md`](docs/task.md) |

## 🧭 Contents

1. [Status](#-status)
2. [Tech stack](#-tech-stack)
3. [Getting started](#-getting-started)
4. [Environment variables](#-environment-variables)
5. [Scripts](#-scripts)
6. [API at a glance](#-api-at-a-glance)
7. [Security conventions](#-security-conventions)
8. [Domain model](#-domain-model)
9. [Project structure](#-project-structure)
10. [Documentation](#-documentation)

---

## ✅ Status

| Step | Feature | State |
|:--:|---|---|
| 1 | PostgreSQL + Prisma foundation, health checks | ✅ Done |
| 2 | Customer auth: register, login, logout, `/auth/me` (Redis sessions) | ✅ Done |
| 3 | People I Love (Recipients) CRUD | ✅ Done |
| 4 | Trusted Contacts CRUD | ✅ Done |
| 5 | Messages (drafts) assigned to Recipients | ✅ Done |
| 6 | Message scheduling: `FIXED_DATE`, `ON_DEATH`, `AFTER_DEATH` (stored in PostgreSQL) | ✅ Done |
| 7 | Private PHOTO/AUDIO message media, direct upload (Backblaze B2; ImageKit since Phase 12) | ✅ Done |
| 8 | Message composition: TEXT, PHOTO, AUDIO, MIXED, checked before scheduling | ✅ Done |
| 9 | Memory Vault: private memories with PHOTO/AUDIO | ✅ Done |
| 10 | My Story: private text answers to guided life-story prompts | ✅ Done |
| 11 | My Wishes: private, non-legal text answers about farewell preferences | ✅ Done |
| 12 | Message release: BullMQ moves due `FIXED_DATE` messages to `RELEASED` (no delivery yet) | ✅ Done |
| 13 | Recipient Portal: email OTP, separate session, read-only released Messages/media ([docs](docs/recipient-portal.md)) | ✅ Done (no email provider yet) |
| 14 | Trusted Contact email OTP + death report intake ([docs](docs/trusted-contact-auth.md)) | ✅ Done (no email provider yet) |
| 15 | Death verification: safety notice, safeguard window, Customer confirm-alive, minimal admin verify/reject, `ON_DEATH`/`AFTER_DEATH` release ([docs](docs/death-verification.md)) | ✅ Done (console notice only; email in Step 17) |
| 16 | Admin backend: mandatory TOTP, user management, audit log, queue operations ([docs](docs/admin.md)) | ✅ Done |
| 17–19 | **Frontend** (Next.js, `../for-after-frontend`): Customer auth + dashboard, vault (People I Love, Trusted Contacts, Messages + media + scheduling, Memory Vault, My Story, My Wishes), Recipient portal, Trusted Contact portal, Customer safety banner | ✅ Built (see frontend `docs/tasks.md` for test status) |
| — | Email/SMS delivery, evidence upload, SMS OTP, billing, video, admin frontend, WordPress login | ⬜ Not started |

> ⚠️ **Report ≠ verification ≠ release.** A Trusted Contact report never marks anyone dead. Only an admin, after the
> account holder was notified and the safeguard window ended, can verify a death; only then do death-triggered
> Messages release.

---

## 🧰 Tech stack

| Area | Choice |
|---|---|
| Runtime | Node.js 22, TypeScript, ES modules |
| Framework | NestJS 12 |
| Database | PostgreSQL 16 with Prisma 7 (`@prisma/adapter-pg`) |
| Redis 7 | Customer sessions (`express-session` + `connect-redis`, no JWT), BullMQ release queue (`bullmq` + `ioredis`), Recipient and Trusted Contact OTP challenges, rate limits and sessions |
| Security | Argon2id password hashing, Helmet, `@nestjs/throttler`, class-validator, HMAC-SHA256 OTPs |
| Media | ImageKit (private files, signed upload tokens and URLs); legacy B2 rows read-only |
| Quality | Vitest (unit + e2e), oxlint, Prettier |
| Telemetry | NestJS Observe (optional) |

---

## 🚀 Getting started

### Prerequisites

- Node.js 22.23.2+ and npm 11
- PostgreSQL 16 on `localhost:5432` with a database named `for_after`
- Redis 7 on `localhost:6379`. With Docker Desktop:

  ```bash
  docker run -d --name for-after-redis --restart unless-stopped -p 6379:6379 redis:7-alpine
  ```

### Setup

```bash
npm install
cp .env.example .env       # then fill in the secrets (see below)
npx prisma migrate dev     # apply migrations
npx prisma generate        # generate the client into src/generated/prisma
npm run start:dev          # http://localhost:4000
```

Check it is up:

```bash
curl http://localhost:4000/health/database
curl http://localhost:4000/health/redis
```

---

## 🔐 Environment variables

Copy `.env.example` to `.env`. **Never commit `.env`.**

| Variable | Required | Example / notes |
|---|:--:|---|
| `NODE_ENV` | no | `development` (`production` enables secure cookies and trusts one proxy hop) |
| `PORT` | no | `4000` |
| `SWAGGER_ENABLED` | no | `true` \| `false`. Unset: Swagger is on only with `NODE_ENV=development`, so test and production stay off unless set to `true` (e.g. staging). Anything else fails startup |
| `DATABASE_URL` | ✅ | `postgresql://postgres:<password>@localhost:5432/for_after` |
| `REDIS_URL` | ✅ | `redis://localhost:6379` (`rediss://` for TLS) |
| `SESSION_SECRET` | ✅ | random, at least 32 characters |
| `SESSION_TTL_SECONDS` | no | `604800` (7 days) |
| `FRONTEND_URL`, `WORDPRESS_URL` | no | allowed CORS origins, comma-separated |
| `COOKIE_DOMAIN` | no | empty locally, `.forafter.com.au` in production |
| `OBSERVE_APP_KEY`, `OBSERVE_APP_SECRET` | no | telemetry is only enabled when both are set |
| `QUEUE_REDIS_URL`, `RELEASE_*` | no | release queue settings ([message release](docs/message-release.md)); the queue uses `REDIS_URL` if `QUEUE_REDIS_URL` is empty |
| `OBJECT_STORAGE_*`, `MEDIA_*` | for media | private bucket, credentials, URL lifetimes, size limits ([media storage](docs/media-storage.md)) |
| `RECIPIENT_OTP_PEPPER` | ✅ | random, at least 32 characters; HMAC key for Recipient codes (never logged) |
| `RECIPIENT_OTP_*`, `RECIPIENT_SESSION_TTL_SECONDS`, `RECIPIENT_COOKIE_DOMAIN` | no | code lifetime, attempts, rate limits, Recipient cookie ([recipient portal](docs/recipient-portal.md)) |
| `TRUSTED_CONTACT_OTP_PEPPER` | ✅ | random, at least 32 characters, **different** from the Recipient pepper |
| `TRUSTED_CONTACT_OTP_*`, `TRUSTED_CONTACT_SESSION_TTL_SECONDS`, `TRUSTED_CONTACT_COOKIE_DOMAIN` | no | same settings for Trusted Contacts ([trusted contact auth](docs/trusted-contact-auth.md)) |
| `DEATH_VERIFICATION_SAFEGUARD_SECONDS` | no | `1209600` (14 days); local testing may use `60`; stored per case when it starts |
| `EMAIL_PROVIDER` | ✅ in production | `brevo` (selected; production requires `brevo` or the optional `resend`), `console` (`NODE_ENV=development` only) or `disabled` (default elsewhere). Sign-in codes, release and safety emails ([email setup](docs/email-production-setup.md)) |
| `BREVO_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME`, `APP_BASE_URL` | with `brevo` | server-side Brevo v3 API key, a sender verified in Brevo, display name, app origin for links |
| `RESEND_API_KEY` | with `resend` only | optional, inactive Resend adapter; never required for Brevo |
| `EMAIL_SEND_TIMEOUT_MS`, `EMAIL_QUEUE_NAME`, `EMAIL_JOB_*`, `EMAIL_RECONCILE_INTERVAL_SECONDS` | no | email timeout and the `email-delivery` queue |
| `DEATH_VERIFICATION_QUEUE_NAME`, `DEATH_VERIFICATION_RECONCILE_INTERVAL_SECONDS`, `DEATH_VERIFICATION_JOB_*` | no | safeguard queue settings ([death verification](docs/death-verification.md)) |
| `ADMIN_TOTP_ENCRYPTION_KEY` | ✅ | 32 random bytes, **base64** (`openssl rand -base64 32`); encrypts admin TOTP secrets. Dedicated key |
| `ADMIN_TOTP_CHALLENGE_TTL_SECONDS`, `ADMIN_TOTP_MAX_ATTEMPTS`, `ADMIN_TOTP_VERIFY_IP_LIMIT`, `ADMIN_SESSION_IDLE_TIMEOUT_SECONDS`, `ADMIN_TOTP_ISSUER` | no | `300`, `5`, `20` (per IP / 15 min), `1800`, `For After` ([admin](docs/admin.md)) |

Generate a secret (session secret or pepper):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The app **refuses to start** if `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `RECIPIENT_OTP_PEPPER`,
`TRUSTED_CONTACT_OTP_PEPPER` or a valid `ADMIN_TOTP_ENCRYPTION_KEY` is missing, if any OTP or death-notice delivery mode is `console` outside `NODE_ENV=development`, or if
PostgreSQL or Redis is unreachable.

---

## 📜 Scripts

| Command | What it does |
|---|---|
| `npm run start:dev` | Run with hot reload |
| `npm run build` / `npm run start:prod` | Compile to `dist/` and run it |
| `npm run lint` | oxlint (type-aware) |
| `npm run format` | Prettier |
| `npm test` | Unit tests (no database needed) |
| `npm run test:e2e` | End-to-end tests against the real PostgreSQL in `DATABASE_URL` and Redis; they create and then delete their own test users |
| `npm run test:cov` | Unit tests with coverage |
| `npm run backfill:access-grants` | After `npm run build`: dry run listing releases made before Step 13 with no access grants; add `-- --apply` to create them (idempotent, never automatic) |

**Database changes:** edit `prisma/schema.prisma`, then `npx prisma migrate dev --name <change>`.

> ⚠️ Never run `prisma migrate reset` against a database with data you need, and never edit a migration that has
> already been applied: add a new one.

---

## 🌐 API at a glance

Base path `/api/v1`, except health checks. There are **three separate principals**, each with its own HttpOnly
cookie. No cookie works on another principal's routes (`401`). Postman stores and resends cookies automatically.

**Swagger / OpenAPI:** `http://localhost:4000/api/docs` (UI) and `/api/docs-json` (document) when `SWAGGER_ENABLED`
allows it (default: development only). Each route shows its cookie session scheme (`customer-session`,
`admin-session`, `recipient-session`, `trusted-contact-session`); there are no bearer tokens. DTO schemas come from the
Nest CLI Swagger plugin (`nest-cli.json`), so they appear in `npm run build` / `start:dev` builds. "Try it out" sends
requests from the docs origin, which the CSRF Origin check refuses for POST/PATCH/DELETE unless it is in
`FRONTEND_URL`; use the frontend or Postman for writes.

| Principal | Cookie | Signs in with |
|---|---|---|
| Customer | `for_after_session` | email + password (`/auth/login`) |
| Recipient | `for_after_recipient_session` | email code (`/recipient-auth/verify-otp`) |
| Trusted Contact | `for_after_trusted_contact_session` | email code (`/trusted-contact-auth/verify-otp`) |

### Customer

| Method | Path | Access |
|---|---|---|
| GET | `/health/database`, `/health/redis` | public |
| POST | `/api/v1/auth/register`, `/api/v1/auth/login` | public, 5/min per IP |
| POST | `/api/v1/auth/logout` | any |
| GET | `/api/v1/auth/me` | signed in |
| POST, GET | `/api/v1/recipients` | CUSTOMER |
| GET, PATCH, DELETE | `/api/v1/recipients/:id` | CUSTOMER, owner only |
| POST, GET | `/api/v1/trusted-contacts` | CUSTOMER |
| GET, PATCH, DELETE | `/api/v1/trusted-contacts/:id` | CUSTOMER, owner only |
| POST, GET | `/api/v1/messages` | CUSTOMER |
| GET, PATCH, DELETE | `/api/v1/messages/:id` | CUSTOMER, owner only (changes: DRAFT only) |
| POST, GET, PATCH, DELETE | `/api/v1/messages/:messageId/schedule` | CUSTOMER, owner only |
| POST, GET, DELETE | `/api/v1/messages/:messageId/media/...` | CUSTOMER, owner only |
| POST, GET | `/api/v1/memory-vault` | CUSTOMER |
| GET, PATCH, DELETE | `/api/v1/memory-vault/:id` (+ `/media/...`) | CUSTOMER, owner only |
| GET | `/api/v1/my-story/prompts[?category=]`, `/api/v1/my-story/prompts/:promptKey` | CUSTOMER |
| GET, PUT, DELETE | `/api/v1/my-story/prompts/:promptKey/response` | CUSTOMER, own answer only |
| GET | `/api/v1/my-wishes/prompts[?category=]`, `/api/v1/my-wishes/prompts/:promptKey` | CUSTOMER |
| GET, PUT, DELETE | `/api/v1/my-wishes/prompts/:promptKey/response` | CUSTOMER, own answer only |

### Recipient (Step 13)

| Method | Path | Access |
|---|---|---|
| POST | `/api/v1/recipient-auth/request-otp`, `/api/v1/recipient-auth/verify-otp` | public, rate-limited |
| GET | `/api/v1/recipient-auth/me` | Recipient |
| POST | `/api/v1/recipient-auth/logout` | any |
| GET | `/api/v1/recipient/messages[/:messageId[/media[/:mediaAssetId/access-url]]]` | Recipient; released + granted Messages only (read-only) |

### Trusted Contact (Step 14)

| Method | Path | Access |
|---|---|---|
| POST | `/api/v1/trusted-contact-auth/request-otp`, `/api/v1/trusted-contact-auth/verify-otp` | public, rate-limited |
| GET | `/api/v1/trusted-contact-auth/me` | Trusted Contact |
| POST | `/api/v1/trusted-contact-auth/logout` | any |
| GET | `/api/v1/trusted-contact/accounts` | Trusted Contact; Customers who list this email (safe fields only) |
| POST | `/api/v1/trusted-contact/accounts/:trustedContactId/death-reports` | Trusted Contact; files a report (starts the safety notice) |
| GET | `/api/v1/trusted-contact/accounts/:trustedContactId/death-verification` | Trusted Contact; high-level case status |

### Death verification (Step 15)

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/death-verification/me` | CUSTOMER; own case status + safeguard deadline |
| POST | `/api/v1/death-verification/me/confirm-alive` | CUSTOMER; cancels an open case about them |
| GET | `/api/v1/admin/death-verifications[?status&page&limit]`, `/api/v1/admin/death-verifications/:caseId` | ADMIN / SUPER_ADMIN (+MFA); paginated, detail audited |
| POST | `/api/v1/admin/death-verifications/:caseId/verify`, `…/reject` | ADMIN / SUPER_ADMIN (+MFA); only after the safeguard (`READY_FOR_REVIEW`) |

### Admin backend (Step 16)

| Method | Path | Access |
|---|---|---|
| POST | `/api/v1/auth/login` | admins get `{mfaRequired, mfaSetupRequired, challengeId}`, no session |
| POST | `/api/v1/admin-auth/totp/setup`, `…/totp/confirm`, `…/totp/verify`, `…/recovery/verify` | admin MFA challenge holder; success creates the session |
| GET | `/api/v1/admin-auth/me` | ADMIN / SUPER_ADMIN (+MFA) |
| GET | `/api/v1/admin/dashboard` | ADMIN / SUPER_ADMIN (+MFA) |
| GET | `/api/v1/admin/users`, `/api/v1/admin/users/:userId` | ADMIN / SUPER_ADMIN (+MFA); detail audited |
| POST | `/api/v1/admin/users/:userId/suspend`, `…/reactivate` | ADMIN (Customers) / SUPER_ADMIN (also admins); never `PASSED` |
| GET | `/api/v1/admin/audit-logs`, `/api/v1/admin/audit-logs/:auditLogId` | ADMIN / SUPER_ADMIN (+MFA); read-only |
| GET/POST | `/api/v1/admin/system/queues`, `…/:queueName/failed`, `…/:queueName/jobs/:jobId/retry` | ADMIN / SUPER_ADMIN (+MFA); allowlisted queues |

There is no admin sign-up (an operator sets `User.role`); an admin enrolls TOTP on first sign-in. Admin sessions end
after 30 minutes idle. Full guide: [docs/admin.md](docs/admin.md).

### Example

```bash
curl -c jar -H "Content-Type: application/json" \
  -d '{"email":"lisa@example.com","password":"StrongPassword123!"}' \
  http://localhost:4000/api/v1/auth/login

curl -b jar -H "Content-Type: application/json" \
  -d '{"firstName":"Sofia","relationship":"Daughter","email":"sofia@example.com"}' \
  http://localhost:4000/api/v1/recipients
```

Field rules and responses: [`docs/api.md`](docs/api.md). Postman: `D:\FOR-AFTER-DIGITAL-VAULT\postman\collections\FOR-AFTER`
(Steps 1–15) and [`postman/README.md`](postman/README.md) (generated JSON collection).

---

## 🛡️ Security conventions

These apply to every module; follow them in new code.

| Rule | What it means |
|---|---|
| **Owner from the session only** | `ownerUserId` comes from the signed-in user and is never accepted from a request body. |
| **Ownership inside the query** | Every read and write filters on `{ id, ownerUserId, deletedAt: null }`. Missing, deleted or someone else's → the same `404`, never `403`. |
| **Strict input** | The global ValidationPipe rejects unknown fields (`400`); route ids must be UUIDs (`400`). My Story / My Wishes use a catalogue prompt key (malformed `400`, unknown `404`). |
| **Customer-only routes** | `SessionAuthGuard` + `CustomerGuard`; admins get `403` and will use separate, audited admin APIs. |
| **Recipient routes** | `RecipientSessionAuthGuard` only; access comes from a release-time `RecipientMessageAccessGrant` for the verified email. Anything not released and granted is `404`. |
| **Trusted Contact routes** | `TrustedContactSessionAuthGuard` only; every query goes through the signed-in email's active `TrustedContact` rows. Foreign or removed ids are `404`. No access to any Customer content. |
| **One OTP engine, separate secrets** | Recipient and Trusted Contact codes share `src/otp-auth/` but use separate peppers, Redis namespaces, cookies and guards. |
| **Soft delete** | `DELETE` sets `deletedAt`; rows are kept for history. |
| **Errors never leak internals** | A global filter (`src/config/global-exception.filter.ts`) keeps every `HttpException` (400, 401, 403, 404, 409, 429, 503, validation) exactly as Nest renders it. Anything unexpected is `{ "statusCode": 500, "message": "Internal server error", "traceId": "…" }` in every environment (`traceId` only when Nest Observe is on; quote it to support). The server logs the error class, a safe code and stack frames, never the message. |
| **Private data stays private** | `ownerUserId`, `deletedAt` and `passwordHash` are never returned; personal data, request bodies, OTPs, session ids and report notes are never logged. Tests use fictional data only. |

---

## 🗃️ Domain model

| Model | What it is |
|---|---|
| **User** | An account (`CUSTOMER`, `ADMIN`, `SUPER_ADMIN`). |
| **Recipient** | "People I Love": someone who may receive the customer's content. Not a `User`: signs in to the Recipient Portal by email code, no password. |
| **TrustedContact** | Someone who will report the customer's death. Not a `User`: signs in by email code (Step 14), with no access to the customer's content. Needs an email or a mobile (database CHECK). |
| **Message** (+ `MessageRecipient`, `MessageSchedule`, `MediaAsset`) | Private content for Recipients, created as DRAFT and scheduled for later release. |
| **MessageRelease** | Written by the release worker when a message becomes `RELEASED` (one per message). Release is not delivery: nothing is sent yet. |
| **RecipientMessageAccessGrant** | Written in the same release transaction, one per live assigned Recipient, with email/mobile snapshotted. The only thing the Recipient Portal authorizes from. |
| **DeathVerificationCase** | One per Customer. `PENDING_VERIFICATION → SAFEGUARD_ACTIVE → READY_FOR_REVIEW → VERIFIED`, or `REJECTED` (admin) / `CANCELLED` (Customer). Holds the safeguard window, the admin decision and `verifiedDeathAt`. |
| **DeathReport** | One per Trusted Contact per case, with a snapshot of the reporter's name and contact details at submission. Never deleted. |
| **DeathVerificationAuditEvent** | Append-only history of every case step (Step 15). No free text. |
| **DeathTriggeredMessageActivation** | One per `ON_DEATH`/`AFTER_DEATH` Message after a `VERIFIED` case, holding its `dueAt` (Step 15). |
| **AdminMfaCredential** (+ `AdminMfaRecoveryCode`) | An admin's AES-256-GCM encrypted TOTP secret, replay guard, and hashed one-time recovery codes (Step 16). |
| **AuditLog** | Generic append-only audit trail (Step 16): admin sign-in, user status changes, sensitive admin reads, death decisions, job retries. A DB trigger blocks edits. |
| **MemoryVaultItem** (+ `MemoryVaultMediaAsset`) | A private memory with text, photos and audio. Not a Message: no recipients, schedule or release. |
| **MyStoryResponse** | Private text answer to one guided My Story prompt. Prompts live in code (`src/my-story/my-story.prompts.ts`). Never shared, scheduled or released. |
| **MyWishResponse** | Private text answer to one My Wishes prompt (farewell preferences). Not a will or any legal, medical or financial instruction. |

---

## 📁 Project structure

```text
src/
├── auth/                   register/login/logout, SessionAuthGuard, CustomerGuard, AdminGuard, @CurrentUser()
├── users/                  UsersService (never returns passwordHash)
├── recipients/             People I Love
├── trusted-contacts/       Trusted Contacts (Customer CRUD)
├── messages/               Messages and composition rules
├── message-schedules/      Message scheduling
├── message-release/        Release worker, queue sync, reconciler (BullMQ), access grants + backfill
├── media/                  Message media and the shared MediaStorage (S3-compatible)
├── memory-vault/           Memory Vault items and their media
├── my-story/               My Story prompt catalogue and answers
├── my-wishes/              My Wishes prompt catalogue and answers (non-legal)
├── otp-auth/               Shared email OTP + Redis session engine (Steps 13–14)
├── recipient-auth/         Recipient email OTP, sessions, RecipientSessionAuthGuard
├── recipient-portal/       Read-only released Messages and media for Recipients
├── trusted-contact-auth/   Trusted Contact email OTP, sessions, TrustedContactSessionAuthGuard
├── trusted-contact-portal/ Accounts list, death report and case status routes
├── death-verification/     Reports, safety notice + safeguard queue, confirm-alive, admin verify/reject, death-trigger activation
├── admin-auth/             Step 16: admin TOTP + recovery codes (Redis MFA challenge → admin session)
├── admin/                  Step 16: dashboard, users, audit viewer, queue monitor + retry
├── audit/                  Step 16: append-only AuditLog
├── prisma/                 PrismaService
├── redis/                  RedisService (sessions, OTP challenges, rate limits)
├── health/                 /health/database, /health/redis
├── config/                 HTTP setup shared by the app and tests
└── generated/prisma/       generated Prisma client (do not edit)
prisma/                     schema.prisma and migrations
test/                       e2e tests
postman/                    generated JSON Postman collection + local environment
docs/                       product, architecture and API documentation
```

---

## 📚 Documentation

| Topic | Documents |
|---|---|
| **Product** | [Project overview](docs/PROJECT_OVERVIEW.md) · [PRD](docs/prd.md) · [Task list](docs/task.md) |
| **Architecture** | [Architecture](docs/architecture.md) · [Database](docs/database.md) · [API](docs/api.md) · [Endpoint list](docs/for-after-api-endpoints-step-1-to-13.md) |
| **Security** | [Authentication](docs/authentication.md) · [Authorization](docs/authorization.md) · [Security](docs/security.md) · [Threat model](threat-model.md) |
| **Operations** | [Development guide](docs/development-guide.md) · [Deployment](docs/deployment.md) · [Incident response](docs/incident-response.md) |
| **Customer features** | [Message composition](docs/message-composition.md) · [Media storage](docs/media-storage.md) · [Scheduling](docs/scheduling.md) · [Message release](docs/message-release.md) · [Memory Vault](docs/memory-vault.md) · [My Story](docs/my-story.md) · [My Wishes](docs/my-wishes.md) |
| **Portals** | [Recipient Portal](docs/recipient-portal.md) · [Trusted Contact auth](docs/trusted-contact-auth.md) · [Death verification](docs/death-verification.md) |

---

## 📄 License

Private and unlicensed (`UNLICENSED`). All rights reserved.

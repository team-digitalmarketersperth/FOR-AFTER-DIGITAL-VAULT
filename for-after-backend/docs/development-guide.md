# 🛠️ For After — Development Guide

> Everything needed to run, test and change the backend on a Windows development machine.

| | |
|---|---|
| **Stack** | Node.js 22 · NestJS 12 · PostgreSQL 16 + Prisma 7 · Redis 7 · Vitest |
| **Runs on** | `http://localhost:4000` (API) |
| **Related** | [README](../README.md) · [Deployment](deployment.md) · [Task list](task.md) |

## 🧭 Contents

1. [Prerequisites](#1-prerequisites)
2. [Node version (NVM for Windows)](#2-node-version-nvm-for-windows)
3. [Project setup](#3-project-setup)
4. [Database setup](#4-database-setup)
5. [Running and testing](#5-running-and-testing)
6. [Local OTP testing](#6-local-otp-testing)
7. [Port mapping](#7-port-mapping)
8. [Environment variables](#8-environment-variables)
9. [Project structure](#9-project-structure)
10. [Conventions](#10-conventions)
11. [Known issues and fixes](#11-known-issues-and-fixes)

---

## 1. Prerequisites

| Tool | Version |
|---|---|
| Node.js | v22.23.2+ (managed with NVM for Windows) |
| npm | v11.x |
| PostgreSQL | v16 |
| Redis | v7+ (Docker: `docker run -d --name for-after-redis --restart unless-stopped -p 6379:6379 redis:7-alpine`) |
| ClamAV (clamd) | Phase 12B malware scanning, required to complete uploads (Docker: `docker run -d --name for-after-clamav --restart unless-stopped -p 127.0.0.1:3310:3310 -e CLAMD_CONF_StreamMaxLength=110M clamav/clamav:stable`; first start downloads signatures for a few minutes; see `docs/media-storage.md` §2e) |
| Git | any recent |

---

## 2. Node version (NVM for Windows)

1. Install NVM for Windows:

   ```bash
   winget install CoreyButler.NVMforWindows
   ```

2. Install and use the required Node version:

   ```bash
   nvm install 22.23.2
   nvm use 22.23.2
   ```

3. Upgrade npm:

   ```bash
   npm install -g npm@11
   ```

> ⚠️ If an old standalone Node.js MSI is installed, uninstall it first. `where.exe node` should only point to the NVM path.

---

## 3. Project setup

```bash
cd for-after-backend
npm install
cp .env.example .env
```

Then fill in `.env`. The app **will not start** without:

- `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`
- `RECIPIENT_OTP_PEPPER` (Step 13) and `TRUSTED_CONTACT_OTP_PEPPER` (Step 14): random, 32+ characters each, different
  from each other

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Database setup

1. Create a local PostgreSQL database named `for_after`.
2. Apply migrations: `npx prisma migrate dev`
3. Generate the Prisma client: `npx prisma generate`
4. Inspect data (optional): `npx prisma studio`

> ⚠️ Never run `npx prisma migrate reset` on a database with data you need, and never edit a migration that is already
> applied: create a new one with `npx prisma migrate dev --name <change>`.

---

## 5. Running and testing

| Task | Command |
|---|---|
| Development (hot reload, port 4000) | `npm run start:dev` |
| Unit tests (Vitest, no database) | `npm test` |
| E2E tests (real PostgreSQL + Redis) | `npm run test:e2e` |
| Lint | `npm run lint` |
| Format | `npm run format` |
| Build / production | `npm run build` / `npm run start:prod` |
| Access-grant backfill (Step 13, one-off) | `npm run build && npm run backfill:access-grants` (dry run; add `-- --apply` to write) |

**Postman:**
- `D:\FOR-AFTER-DIGITAL-VAULT\postman\collections\FOR-AFTER`: Postman workspace collection for Steps 1–15, 16 folders.
- `postman/` in this repo: the generated JSON collection ([postman/README.md](../postman/README.md)).

---

## 6. Local OTP testing

Recipient and Trusted Contact sign-in, released-message and safety emails go through `EMAIL_PROVIDER` (Step 24,
[email setup](email-production-setup.md)). For local testing without Brevo credentials, set in `.env`:

```env
NODE_ENV=development
EMAIL_PROVIDER=console
APP_BASE_URL=http://localhost:3000
```

Every email then appears in the API terminal instead of being sent:

```text
[DEV ONLY] Email (recipient-otp) to s***@example.com | Your For After sign-in code | … Your sign-in code is 123456 …
```

> 🔒 `console` is refused at startup unless `NODE_ENV=development`; production requires `brevo` (or the optional `resend`).

To receive real emails locally instead, set `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY` and a Brevo-verified
`EMAIL_FROM_ADDRESS` (no custom domain needed), then restart the API. Codes then arrive by email only, not in the
terminal. If the log shows `email_send_failed … (code: unauthorized)`, Brevo is refusing the key, usually because of
its authorised-IP check: add your IP or turn IP blocking off for development. See
[email setup](email-production-setup.md) §4 (troubleshooting) and §5. Frontend Playwright OTP tests still need
`EMAIL_PROVIDER=console`.

### Death verification (Step 15)

```env
DEATH_VERIFICATION_SAFEGUARD_SECONDS=60   # set it once; production uses 1209600 (14 days)
```

The account-holder safety notice then appears as
`[DEV ONLY] Death verification safety notice sent to l***@example.com for case <caseId> (...)`, and a case reaches
`READY_FOR_REVIEW` about a minute after the report. With `disabled`, no notice is sent, so **no safeguard starts** (by
design).

**Admin account for local testing.** There is no admin sign-up. Register an account, then promote it:

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = 'admin.dev@example.test';
```

> ⚠️ Verifying a death sets that Customer to `PASSED` and blocks their login for good. Test with fictional customers
> only (Postman folder 16 registers fresh ones each run), never your own account.

---

## 7. Port mapping

| Service | Address |
|---|---|
| Next.js frontend (`for-after-frontend`) | `localhost:3000` |
| NestJS backend | `localhost:4000` |
| PostgreSQL | `localhost:5432` |
| Redis | `localhost:6379` |
| ClamAV clamd | `127.0.0.1:3310` |

---

## 8. Environment variables

The authoritative list is `.env.example`. The main groups:

```env
# Core
NODE_ENV=development
PORT=4000
DATABASE_URL="postgresql://postgres:<password>@localhost:5432/for_after?schema=public"
REDIS_URL=redis://localhost:6379
SESSION_SECRET="<32+ random characters>"

# Recipient Portal (Step 13)
RECIPIENT_OTP_PEPPER="<32+ random characters>"

# Trusted Contact auth + death reports (Step 14)
TRUSTED_CONTACT_OTP_PEPPER="<32+ random characters, different from the Recipient pepper>"

# Death verification (Step 15)
DEATH_VERIFICATION_SAFEGUARD_SECONDS=60          # local testing only; production default 1209600 (14 days)

# Email (Step 24)
EMAIL_PROVIDER=console                     # brevo | resend (optional) | console (development only) | disabled
APP_BASE_URL=http://localhost:3000

# Admin backend (Step 16): required, the app refuses to start without it
ADMIN_TOTP_ENCRYPTION_KEY="<openssl rand -base64 32>"  # 32 random bytes, base64; dedicated key
# ADMIN_SESSION_IDLE_TIMEOUT_SECONDS, ADMIN_TOTP_*   (optional, defaults in .env.example; see docs/admin.md)

# Media (Step 7): OBJECT_STORAGE_*, MEDIA_*   (see .env.example)
# Release queue (Step 12): QUEUE_REDIS_URL, RELEASE_*   (optional, defaults in .env.example)
```

**Planned (not used by the code yet):** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`POSTMARK_SERVER_TOKEN`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `SENTRY_DSN`. Media uses `IMAGEKIT_PUBLIC_KEY`,
`IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_URL_ENDPOINT` (Phase 12; Mux is no longer planned). Storage quota uses `STORAGE_LIMIT_BYTES` (Phase 12C; set it small, e.g. `50000`, to try the 80/90/100 % states
locally). Malware scanning uses `CLAMAV_HOST`,
`CLAMAV_PORT`, `MEDIA_MALWARE_SCAN_TIMEOUT_MS` (Phase 12B).

> ℹ️ Earlier versions of this guide used `APP_ENV`; the code reads **`NODE_ENV`**.

---

## 9. Project structure

```text
for-after-backend/
├── docs/                 # Project documentation
├── prisma/               # Database schema and migrations
├── src/                  # NestJS source code (one folder per module; see the README for the full list)
│   ├── auth/             # Customer login + guards
│   ├── otp-auth/         # Shared email OTP engine (Recipient + Trusted Contact)
│   ├── ...               # Feature modules
│   ├── main.ts           # Application entry point
│   └── app.module.ts     # Root module
├── test/                 # E2E tests + shared test helpers
├── postman/              # Generated JSON Postman collection
├── .env                  # Environment variables (git-ignored)
├── .env.example          # Template with placeholders only
├── package.json
└── tsconfig.json
```

---

## 10. Conventions

### Coding standards

- **Modules:** ECMAScript Modules (ESM).
- **Testing:** Vitest for unit and e2e tests; e2e tests use real PostgreSQL + Redis and fictional data only.
- **Validation:** `class-validator` DTOs; the global pipe rejects unknown fields.
- **Database:** Prisma for data access; raw SQL only when necessary (e.g. row locks, RLS).
- **Security:** follow the conventions in the [README](../README.md#-security-conventions) (owner from the session,
  `404` never `403`, nothing sensitive logged).

### Dependencies

- **Phase-gated:** install packages only when building the module that needs them.
- Future integrations (Stripe, Twilio, an email provider) wait until their features are built.

### Git

`.gitignore` must include `.env`, `node_modules/`, `dist/` and `src/generated/`. Commit feature branches, open PRs, and
never commit secrets.

### Local frontend

The Next.js app lives in `../for-after-frontend` (`npm run dev`, then http://localhost:3000). Start PostgreSQL, Redis and
this API first. Customers use `/login` or the development-only `/dev-login`; Recipients use `/recipient/sign-in` and
Trusted Contacts `/trusted-contact/sign-in`, with codes read from this API's console (`[DEV ONLY] ... OTP for ...`).
Postman and curl still work.

---

## 11. Known issues and fixes

| Issue | Fix |
|---|---|
| npm "edgesOut" Arborist bug | Use npm 11.x |
| NVM PATH conflicts on Windows | Uninstall standalone Node.js |
| Prisma version drift | Stay on Prisma 7 (`@prisma/client@7`, `prisma@7`); do not upgrade blindly |
| Prisma install-script warning | `npm install-scripts approve prisma` |
| API won't start after pulling Step 14 | Add `TRUSTED_CONTACT_OTP_PEPPER` to `.env` |

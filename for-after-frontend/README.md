# 🕊️ For After — Frontend

> The web app for **For After**, a secure digital legacy and posthumous messaging platform: the Customer app and vault,
> the Recipient and Trusted Contact portals, and the Admin Portal. Talks to the NestJS API in [`../for-after-backend`](../for-after-backend)
> using HttpOnly session cookies (one per kind of user).

| | |
|---|---|
| **Built** | Step 17: foundation, Customer auth, `/dev-login`, dashboard shell (FE-1 to FE-8). Step 18: the Customer vault: People I Love, Trusted Contacts, Messages with photo/audio upload, browser recording and scheduling, Memory Vault, My Story, My Wishes (FE-10 to FE-19) |
| **Also built** | Step 19: Recipient portal (FE-21 to FE-23), Trusted Contact portal (FE-24 to FE-27), Customer death-verification safety banner + "I'm still alive". Step 20: Admin Portal (FE-28): password + mandatory TOTP sign-in and enrolment, users, death-verification review, audit log, queues |
| **Not built yet** | Profile (FE-9, no backend), billing (FE-20), WordPress (FE-29/30) |
| **Stack** | Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui (Radix) · TanStack Query 5 · React Hook Form + Zod 4 · Lucide |
| **Tests** | Vitest + React Testing Library: **204 passing** · Playwright against the real local API (`EMAIL_PROVIDER=console`), PostgreSQL, Redis and the development bucket (Step 24, 2026-10-03): **36 passing**, 0 failing, 0 skipped (with the email log, a fictional admin and a fictional failed job) |
| **Progress** | [`docs/tasks.md`](docs/tasks.md) (frontend tracker, 26 of 30 tasks, all verified) · full roadmap: [`../for-after-backend/docs/task.md`](../for-after-backend/docs/task.md) Part 6 |

## Requirements

- Node.js 20.9+ (developed on 22) and npm
- The backend running locally: PostgreSQL, Redis and NestJS on `http://localhost:4000`
  (see the backend README). Its `.env` must have `FRONTEND_URL=http://localhost:3000` for CORS.

## Getting started

Start things in this order:

```bash
# 1–2. PostgreSQL and Redis (however you run them locally)
# 3. Backend
cd for-after-backend && npm run start:dev          # http://localhost:4000
# 4. Frontend
cd for-after-frontend
npm install
cp .env.example .env.local                          # defaults work locally
npm run dev                                          # http://localhost:3000
```

| URL | What |
|---|---|
| http://localhost:3000 | Frontend (redirects to `/dashboard`, or `/login` when signed out) |
| http://localhost:3000/register | Create a Customer account |
| http://localhost:3000/login | Sign in |
| http://localhost:3000/dev-login | Development-only sign-in page (404 in production builds) |
| http://localhost:4000/api/v1 | Backend API |

## Environment

| Variable | Default | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `http://localhost:4000/api/v1` | Read only in `src/lib/env.ts`; every request is built from it |
| `NEXT_PUBLIC_APP_ENV` | `development` | `/dev-login` exists only when this is `development` **and** the app is not a production build |

`NEXT_PUBLIC_*` values are inlined into the browser bundle at build time. **No secrets belong here**: the session
secret, database, Redis, storage keys, OTP peppers and the TOTP key stay in the backend.

## Scripts

| Script | What |
|---|---|
| `npm run dev` | Development server on :3000 |
| `npm run build` / `npm start` | Production build / serve it |
| `npm run lint` | ESLint (`eslint-config-next`) |
| `npm run typecheck` | Generates route types, then `tsc --noEmit` |
| `npm test` | Vitest unit + component tests (network mocked at `fetch`) |
| `npm run test:e2e` | Playwright. Needs the backend on :4000; starts `next dev` on :3000 and a production build on :3100 (the build takes minutes on a slow disk: start `npm run build && npx next start -p 3100` yourself to reuse it). `vault.spec` uploads a few tiny files to the development bucket |

First run of Playwright: `npx playwright install chromium`. The API throttles login and register to 5 per minute per IP,
and the E2E suite uses 3 of each, so wait a minute between runs. E2E accounts are throwaway
`e2e-<timestamp>@example.com` users in your local database.

On a slow machine, `next dev` compiles each route on first visit (20 s to over a minute here) and its HMR rebuilds can
abort a navigation mid-test, so the first run of a spec can time out for reasons that have nothing to do with the app.
For the real-backend suites, serve a production build on :3000 instead (`npm run build && npx next start -p 3000`, it
is reused) and run `npx playwright test --project=vault --project=production-build`; run `--project=development`
(`/dev-login`) against `npm run dev`. The vault project gives Chromium a fake microphone for the recorder test.

## How authentication works

```text
/login form ──POST /auth/login──► NestJS sets HttpOnly for_after_session cookie (Redis session)
            ──GET /auth/me─────► confirms the session ──► /dashboard
```

- **The backend is the only source of truth.** The app never sees, stores or logs the session: no tokens, no
  `localStorage`/`sessionStorage`, no cookie parsing. Every request uses `credentials: 'include'`
  (`src/lib/api/client.ts`).
- **`GET /auth/me` decides who is signed in** (`useCurrentUser`, query key `['auth', 'me']`). A `401` means signed
  out (`null`), never an error, and is never retried. `403` is "access denied", not signed out.
- **Checked in the browser, not in Server Components.** The cookie belongs to the API origin (`localhost:4000`,
  later `api.forafter.com.au`), so Next.js server code cannot read it. The route gates in
  `src/components/auth/auth-gates.tsx` render a loading state until `/auth/me` answers, so private content never
  flashes. When production shares a `.forafter.com.au` cookie (FE-30), server-side checks can be added.
- **Route gates are UX, not security.** NestJS guards enforce every rule (Customer-only vault, `ACTIVE` status,
  admin MFA) on every request. A suspended or `PASSED` Customer's next `/auth/me` returns `401` and the app returns
  them to `/login`; the login form shows the backend's "This account cannot sign in." (`403`).
- **Register does not sign in.** The backend creates no session, so the app goes to `/login?registered=1`.
- **Admins are not Customers.** An admin's password only opens a TOTP challenge (`mfaRequired`). The Customer login
  form says "This account requires administrator sign-in" and links to `/admin/login`; admins use the Admin Portal.
- **Logout** calls `POST /auth/logout` (the backend destroys the session and clears the cookie), then drops every
  cached query and sets `['auth', 'me']` to `null`. Login also drops the previous cache, so nothing from one person
  survives into another's session on a shared browser.

## Vault features (Step 18)

| Route | What |
|---|---|
| `/people`, `/people/new`, `/people/[id]`, `/people/[id]/edit` | People I Love |
| `/trusted-contacts`, `/new`, `/[id]/edit` | Trusted Contacts (Customer-side management only; nobody is contacted) |
| `/messages`, `/messages/new`, `/messages/[id]`, `/messages/[id]/edit` | Drafts, media, readiness, schedule, unschedule-to-edit |
| `/memory-vault[?category=]`, `/new`, `/[id]`, `/[id]/edit` | Memories with photo/audio |
| `/my-story[?category=]`, `/my-story/[promptKey]` | Guided answers (catalogue from the API) |
| `/my-wishes[?category=]`, `/my-wishes/[promptKey]` | Same, with the non-legal disclaimer |

- **Uploads** go straight from the browser to private storage: `upload-url` → `PUT` (XHR, for progress and cancel) → `complete` → READY. Previews use short-lived signed URLs, kept in memory only and fetched only when shown.
- **Browser uploads need a CORS rule on the bucket.** `for-after-dev` (still private) has one, `forAfterLocalUpload` (`../backblaze/cors-rules.json`): origin `http://localhost:3000`, operation `s3_put`, header `content-type`. Production needs the same for `https://app.forafter.com.au`. Signed GETs (previews) need no CORS rule.
- **Session expiry:** any `401` from a feature call drops private cached data and returns to `/login`.

## Portals (Step 19)

| Route | Who | Session |
|---|---|---|
| `/recipient/sign-in`, `/recipient/messages`, `/recipient/messages/[id]` | Recipients (email code) | `for_after_recipient_session`, checked by `/recipient-auth/me` |
| `/trusted-contact/sign-in`, `/trusted-contact/accounts`, `/…/[trustedContactId]`, `/…/[trustedContactId]/report` | Trusted Contacts (email code) | `for_after_trusted_contact_session`, checked by `/trusted-contact-auth/me` |
| Safety banner on every Customer page | The account holder | the Customer session; `/death-verification/me` |

- The three sessions are separate: each portal has its own gate, query namespace (`['recipient', …]`, `['trusted-contact', …]`) and sign-out, and a 401 in one never signs the others out.
- **Codes in development** are emailed through the API's `EMAIL_PROVIDER`; with `console` they are printed only in the API terminal (`[DEV ONLY] Email (recipient-otp) to s***@example.com | … Your sign-in code is 123456 …`); with `brevo` (the backend's real provider) they arrive in the inbox. The UI never shows or fetches them, and never knows which provider is used. Playwright OTP tests need the API on `console`.
- **E2E:** the OTP flows in `e2e/portals.spec.ts` run only when the backend output is teed to a file and `E2E_BACKEND_LOG` points at it:
  `npm run start:dev | tee backend.log` (backend), then `E2E_BACKEND_LOG=../for-after-backend/backend.log npx playwright test --project=vault` (frontend). The Recipient test waits about 2 minutes for a real FIXED_DATE release.
- **Phase 10 E2E** (`e2e/trusted-contacts.spec.ts`: invitation → accept → OTP sign-in, the 2-contact limit, a new death report after a closed case) also needs `E2E_BACKEND_LOG`, and reads the invitation link from the console email. `E2E_BASE_URL` points the `development` project at another app origin, e.g. a build served on :3100 that talks to a second API started with `EMAIL_PROVIDER=console`: `E2E_BASE_URL=http://localhost:3100 NEXT_PUBLIC_API_BASE_URL=http://localhost:4001/api/v1 E2E_BACKEND_LOG=… npx playwright test --project=development e2e/trusted-contacts.spec.ts`. Never run it against an API using `brevo`: adding a contact emails a real invitation.

## Admin Portal (Step 20)

| Route | What |
|---|---|
| `/admin/login` | Email + password. For an admin the API returns only a TOTP challenge (no session) |
| `/admin/mfa/setup` | First sign-in: setup key + QR (drawn in the browser, never by a QR service) → first code → 10 recovery codes, shown once |
| `/admin/mfa/verify` | Later sign-ins: 6-digit TOTP, or one recovery code (lost device) |
| `/admin` | Overview: only the API's numbers; ready-for-review cases and failed jobs first |
| `/admin/users[?search=&status=&role=&page=]`, `/admin/users/[id]` | Server-side search/filter/paging; account metadata and counts only; suspend (reason required) / reactivate |
| `/admin/death-verifications[?status=&page=]`, `/[caseId]` | Review queue, reports, the case's own event timeline, verify / reject (READY_FOR_REVIEW only) |
| `/admin/audit-logs[?eventType=&actorUserId=&subjectType=&subjectId=&from=&to=&page=]`, `/[id]` | Read-only audit trail |
| `/admin/system/queues[?queue=&page=]` | Queue counts, failed jobs (sanitized by the API), retry |

- **Password ≠ access.** The portal opens only after `POST /admin-auth/totp/confirm|verify` or `/recovery/verify`
  succeeds **and** `GET /admin-auth/me` confirms the session. `AdminGate` (`components/admin/admin-shell.tsx`) checks
  `/admin-auth/me` (never `/auth/me`): `401` → `/admin/login` (never the Customer `/login`), `403` (a Customer) →
  "Access denied" without signing anyone out.
- **The challenge id lives in memory only** (the query cache, never storage or the URL). A refresh during the second
  step asks you to sign in again; the challenge expires after 5 minutes anyway. The TOTP secret and recovery codes
  exist only in component memory while shown; nothing admin-related is written to `localStorage`/`sessionStorage`.
- **Own cookie.** Admins use `for_after_admin_session` (Customers keep `for_after_session`), so one browser profile can
  hold both. An admin sign-in, sign-out (`POST /admin-auth/logout`) or expiry drops only `['admin', …]` queries
  (`resetAdminCache`); a Customer login/logout leaves them alone. A signed-in Customer who opens `/admin` just sees
  the admin sign-in (their cookie is never sent to admin routes).
- **Idle timeout is the server's.** After `ADMIN_SESSION_IDLE_TIMEOUT_SECONDS` (30 min) the next admin call is `401`;
  the app clears admin data and shows "Your admin session expired. Please sign in again." on `/admin/login`. There is
  no client-side timer.
- **Privacy:** admins see account metadata and counts, never Message, Memory Vault, My Story or My Wishes content.
  Retry re-runs a job through the worker's normal checks; there is no "release now". There is no role editor, no
  account deletion and no "force" decision.
- **Verify death** needs the case page, an explicit verified time of death (date + time in your timezone, sent with its
  offset, never copied from the reported date), a ticked confirmation and a final button. A `409` (e.g. the account
  holder confirmed alive meanwhile) shows "This case changed while you were reviewing it" and refetches.
- **Provisioning:** there is no admin sign-up. Register normally, then promote (backend `docs/admin.md` §11).
- **E2E:** `e2e/admin.spec.ts` always checks signed-out and Customer access. The signed-in flows run with a fictional
  local admin: `E2E_ADMIN_EMAIL`, `E2E_ADMIN_PASSWORD` (and `E2E_ADMIN_TOTP_SECRET` once enrolled; a not-yet-enrolled
  admin is enrolled by the test), plus optional `E2E_ADMIN_SUSPEND_EMAIL`, `E2E_ADMIN_READY_CASE`,
  `E2E_ADMIN_REJECT_CASE` (fictional Customer / READY_FOR_REVIEW case ids).

## Security notes

- **CSRF:** the app relies on `SameSite=Lax` cookies plus the API's CORS allowlist. A CSRF token/review is still an
  open backend task before production (task.md phase 05).
- **Headers:** `next.config.ts` sets `X-Content-Type-Options`, `X-Frame-Options: DENY` and `Referrer-Policy`, and
  hides `X-Powered-By`. A Content-Security-Policy is **deferred** until the staging domains exist (it must allow the
  API and media origins).
- **`/dev-login`:** blocked in production by `src/proxy.ts` (real `404`) and again by `notFound()` in the page. It
  calls the real `POST /auth/login` with credentials you type; nothing is stored.
- **Errors:** components only render `ApiError.message`, which is fixed copy or a plain-text NestJS message.
  `429` and `5xx` always use fixed copy; stack traces and raw bodies are never shown.
- **Redirects:** there is no `?next=` parameter, so there is no open-redirect surface.

## Project structure

```text
src/
├── app/
│   ├── (auth)/            login, register, dev-login (GuestGate: signed-in Customers go to /dashboard)
│   ├── (dashboard)/       dashboard, people, trusted-contacts, messages, memory-vault, my-story, my-wishes (CustomerGate)
│   ├── recipient/         sign-in + (signed-in)/messages          (Recipient portal, own gate)
│   ├── trusted-contact/   sign-in + (signed-in)/accounts          (Trusted Contact portal, own gate)
│   ├── admin/             (auth)/login, mfa/setup, mfa/verify + (portal)/… (Admin Portal, AdminGate)
│   ├── layout.tsx         fonts, metadata, providers (QueryClient + toasts)
│   ├── page.tsx           / → /dashboard
│   └── error.tsx, not-found.tsx, icon.svg
├── components/
│   ├── auth/              Customer forms, gates
│   ├── layout/            dashboard shell, nav config, logo, safety banner
│   ├── people/            People I Love, Trusted Contacts (Customer side)
│   ├── messages/          list, form, detail, schedule panel
│   ├── media/             MediaManager (upload/preview/delete), AudioRecorder
│   ├── memory-vault/      Memory Vault
│   ├── prompts/           My Story + My Wishes (shared)
│   ├── portals/           portal shell/gates, OTP sign-in, Recipient + Trusted Contact pages
│   ├── admin/             admin shell/gates, sign-in + MFA, overview, users, death verification, audit, queues
│   ├── shared/            page header, confirm dialog, states, form fields, code field, feature card
│   └── ui/                shadcn/ui primitives (restyled)
├── hooks/                 use-auth, use-vault, use-media, use-portals, use-admin, use-unsaved-changes
├── lib/
│   ├── api/               client, errors, auth, people, messages, media, memory-vault, prompts, portals, admin
│   ├── query/             QueryClient, query keys, per-principal 401 handling
│   ├── format.ts          dates (calendar dates never shift), labels
│   ├── composition.ts     message readiness guidance (mirrors the backend rules)
│   ├── death-verification.ts  the one status → wording table (reporter and admin wording)
│   ├── admin.ts           admin labels, URL-param parsing, canManage mirror, audit metadata filter
│   └── env.ts             the only place env vars are read
├── schemas/               Zod form schemas (mirror the backend DTOs; the backend stays authoritative)
└── proxy.ts               404s /dev-login in production
docs/                      tasks.md (progress tracker), frontend-design-system.md
e2e/                       Playwright specs (auth, vault, portals, admin, production)
```

## Design system

The app matches the WordPress marketing site: its aubergine/petal palette, Cormorant + Figtree fonts, pill buttons,
logo and photography. Every value (and whether it was verified on the live site or inferred) is in
[`docs/frontend-design-system.md`](docs/frontend-design-system.md); tokens live only in `src/app/globals.css`. Read it
before building new pages (sections 9–10 cover the vault and portal patterns).

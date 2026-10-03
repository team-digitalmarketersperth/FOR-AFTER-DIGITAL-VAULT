# 🔎 Step 23 — Full application audit

> Audit, bug bash, security hardening and "vibe-code" review of everything built through Step 22. No new features.
> Date: 2026-10-03. Local development environment only (PostgreSQL, Redis `for-after-redis`, Backblaze bucket
> `for-after-dev`); every account, message and case created during the audit is fictional (`@example.test`).

## 1. Method

Two passes. **Pass A** (no code changes): quality gates, static review of both repositories, a scripted live probe of the
API (79 checks), data-integrity queries against the development database, concurrency races, a scripted browser audit
of every page at 375 px and 1440 px (console errors, overflow, raw enums, landmarks/headings), simulated API failures in
the browser, and the full Playwright suite with every flow enabled (a fictional admin per
[admin.md §11](admin.md), OTP codes read from the API's development log). **Pass B**: fixes in priority order, then every
gate and journey again.

Only issues backed by code, a failing check, a browser reproduction or database state are listed.

## 2. Baseline (Pass A, before any change)

| Gate                                  | Result                                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend unit (`npm test`)             | PASS — 621                                                                                                                                            |
| Backend e2e (`npm run test:e2e`)      | PASS — 185                                                                                                                                            |
| Backend lint / `tsc --noEmit` / build | PASS / PASS / PASS                                                                                                                                    |
| Frontend unit (`npm test`)            | PASS — 202                                                                                                                                            |
| Frontend lint / typecheck / build     | PASS / PASS / PASS                                                                                                                                    |
| Playwright                            | Not a clean baseline: the first full run hit the local API on :4000 going down mid-run (`ECONNREFUSED`) and `next dev` first-compile timeouts; see §6 |

Git: branch `step-21-verified-baseline`; Step 22 committed as `d4afa1f` before the audit. No TODO/FIXME/HACK,
`@ts-ignore`, `@ts-expect-error` or `any` in production code. The only production type escapes are four casts of
node-redis `multi().exec()` replies (typing only; errors still throw).

## 3. Issue register

| ID       | Sev | Area          | Finding                                                                                                                                                                                                                                                                                                                                  | Evidence                                                                                                                 | Status                                                                                                                         |
| -------- | :-: | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| SEC-002  | P2  | CSRF          | State-changing requests with a foreign `Origin` were accepted, including `application/x-www-form-urlencoded` bodies (a plain HTML form, no CORS preflight). `SameSite=Lax` keeps cookies off cross-_site_ requests, but not off same-site ones: another `*.forafter.com.au` subdomain in production, any `localhost` port in development | Live probe: `POST /recipients` with `Origin: http://evil.example` and the session cookie → `201` (JSON and form-encoded) | ✅ Fixed                                                                                                                       |
| SEC-001  | P2  | Secrets       | The initial commit (`a5f36f2`, `docs/development-guide.md`) contains a local Postgres connection string with a real-looking 8-character password. It differs from the current local `.env`; the repository has a GitHub remote                                                                                                           | `git log -p` secret-pattern scan (value not printed)                                                                     | ⏸ Deferred: rotate that password wherever it was used; history is not rewritten (needs explicit approval)                      |
| AUTH-001 | P2  | Sessions      | Customers and admins share the `for_after_session` cookie, so an admin sign-in in one browser profile replaces the Customer session there (known since Step 21). Not a privilege issue: the role is re-read every request, `AdminGuard` requires completed MFA, `CustomerGuard` refuses admins                                           | `config/app.setup.ts` (one `express-session`), `admin-mfa` → `establishSession`                                          | ⏸ Deferred: a second cookie means a second session middleware and changes to every admin gate and test; not a contained change |
| CODE-001 | P3  | Backend       | Nest scaffold left in: `GET /api/v1` → `"Hello World!"` (`AppController`/`AppService` + spec)                                                                                                                                                                                                                                            | Live probe                                                                                                               | ✅ Fixed                                                                                                                       |
| A11Y-001 | P3  | Accessibility | A detail page whose item is missing (or fails to load) had no `h1`: `QueryView`'s not-found/error state used `h2`, and the page's `PageHeader` only renders with data                                                                                                                                                                    | Browser audit: `/messages/<unknown>`, `/people/not-a-uuid`, `/admin/users/<unknown>` → `h1 count 0`                      | ✅ Fixed                                                                                                                       |
| TEST-001 | P3  | Tests         | `account.spec` (Step 22) ran in the `development` project against `next dev`; the first compile of `/settings` can exceed the 20 s expect timeout (edit routes measured 19–52 s), so it failed on a cold dev server while passing on a production build                                                                                  | Two cold runs failed at `toHaveURL(/settings/)`; 3/3 on the production build                                             | ✅ Fixed (own project, see §4)                                                                                                 |
| TEST-002 | P3  | Tests         | The portal OTP Playwright flows need the API's console teed to a file; with the API running in a terminal that wasn't teed they could only be skipped                                                                                                                                                                                    | `portals.spec.ts`                                                                                                        | ✅ Improved: optional `E2E_OTP_API`                                                                                            |
| CODE-002 | P3  | Backend       | Stale comment: disabled death-notice delivery called "the safe default until Step 17" (notifications are roadmap phase 20)                                                                                                                                                                                                               | `death-verification-notice.ts`                                                                                           | ✅ Fixed                                                                                                                       |
| DATA-001 | P3  | Media         | 7 `PENDING_UPLOAD` rows older than a day in the dev database (abandoned uploads). They block scheduling of their message until removed, as designed, and the UI offers removal                                                                                                                                                           | DB query                                                                                                                 | ⏸ Deferred: already an open item (task.md phase 12, `media-storage.md` "Pending-upload cleanup")                               |
| OPS-001  | P3  | Rate limits   | Login/register throttling is in memory per instance and shared by Customers and admins per IP                                                                                                                                                                                                                                            | `auth.controller.ts` (`ponytail:` comment)                                                                               | ⏸ Deferred: already open (task.md phase 04)                                                                                    |
| ENV-001  | P3  | Local config  | The local `.env` sets `DEATH_VERIFICATION_SAFEGUARD_SECONDS` twice (14 days, then 60 s)                                                                                                                                                                                                                                                  | `.env` (untracked)                                                                                                       | ⏸ Deferred: local file, known since Step 21                                                                                    |

**By severity:** P0 0 · P1 0 · P2 3 (1 fixed, 2 deferred) · P3 8 (5 fixed, 3 deferred).

## 4. Fixes

**SEC-002 — Origin check.** `configureApp` (`src/config/app.setup.ts`) now refuses `POST/PUT/PATCH/DELETE` whose
`Origin` header is present and not in the same allowlist as CORS (`FRONTEND_URL`, `WORDPRESS_URL`): `403
{"message":"Request origin not allowed."}`, before the session is read. `Origin: null` is refused. Requests without
`Origin` (curl, Postman, server-to-server) and safe methods are unaffected, so local development, Postman and the e2e
suites keep working. Affected surface: every state-changing API route. No migration. **Production note:** every origin
that legitimately posts to the API (the app, the WordPress login forms of FE-29) must be in `FRONTEND_URL` /
`WORDPRESS_URL`, as CORS already requires. Tests: 4 in `auth.controller.spec.ts` (foreign and `null` origins refused and
nothing created, form-encoded refused, allowed origin and no-origin accepted, GET/preflight never blocked); live probe
re-run 79/79.

**CODE-001.** Removed `AppController`, `AppService` and their spec; `test/app.e2e-spec.ts` now boots the whole
`AppModule` and checks real `/health/database` + `/health/redis` and that `/` is `404`.

**A11Y-001.** `EmptyState` and `ErrorState` take `heading: 'h1' | 'h2'` (default `h2`); `QueryView` uses `h1` when it
has `notFound` (only full-page detail views pass it). Regression assertion in `people.test.tsx`.

**TEST-001.** New Playwright project `account` (production build on :3000 like the vault suites, `dependencies:
['vault']` so its 4 logins never share the 5/min window with `vault-setup`; alone: `--project=account --no-deps`).
`development` now ignores it.

**TEST-002.** `portals.spec.ts`: when `E2E_OTP_API` is set (e.g. a second API instance on :4001 whose output is in
`E2E_BACKEND_LOG`), only the `request-otp` call is routed there; challenges and sessions live in the shared Redis.

## 5. What was checked and held

- **Authorization / IDOR (live):** Customer B against Customer A's recipient, trusted contact, message, schedule,
  media (list, access URL, complete, delete, upload URL), memory item and media, story answer — every `GET/PATCH/DELETE/
POST` → `404`, A's data unchanged. Unauthenticated → `401` everywhere. Customer cookie on admin routes → `401/403`, on
  Recipient/Trusted Contact routes → `401`. Admin password alone never opens the portal (Playwright).
- **Mass assignment:** `ownerUserId`, `status`, `releasedAt`, `role`, `status` on register, `storageKey` → `400`
  (global `whitelist` + `forbidNonWhitelisted`); no DTO is spread into a Prisma write.
- **Input:** malformed UUIDs → `400`, unknown prompt → `404`, malformed JSON → `400`, 300 kB body → `4xx`, SVG and
  10 GB uploads refused, `complete` without an object refused — none leak Prisma/stack/driver text.
- **Cookies:** `HttpOnly`, `SameSite=Lax`, `Secure` in production (`isProd`), 7-day TTL, regenerated on login and
  password change, destroyed on logout. Helmet headers present, no `x-powered-by`.
- **CORS:** a foreign origin gets no `Access-Control-Allow-Origin`; the app origin gets it with credentials; no `*`.
  Bucket CORS (`backblaze/cors-rules.json`): `http://localhost:3000`, `s3_put`, `content-type` only; bucket private.
- **Secrets / logging:** no `console.*` in production code; the only code-bearing logs are `[DEV ONLY]` OTP and safety
  notice lines, and their factories refuse `console` mode unless `NODE_ENV=development`. Emails in logs are masked. No
  secrets in `NEXT_PUBLIC_*`; `.env` files are not tracked.
- **Data integrity (dev DB):** 0 SCHEDULED without schedule, 0 RELEASED without release, 0 release/grant mismatches, 0
  PASSED without VERIFIED case (and vice versa), 0 PASSED owners with ON_DEATH messages still scheduled, 0 overdue
  FIXED_DATE, 0 cross-owner media, 0 activations on non-VERIFIED cases. Constraints back the invariants (one schedule,
  release and activation per message; unique grants; one case per owner; one report per case and contact; append-only
  audit trigger).
- **Concurrency (live):** 4 simultaneous schedules → `201,409,409,409`; edit while scheduled → `409`; 3 simultaneous
  unschedules → `204,404,404`, back to DRAFT; double delete → `204,404`.
- **Death verification (real workflow):** Trusted Contact report → safety notice → 60 s safeguard → `READY_FOR_REVIEW`
  → admin verify: owner `PASSED`, case `VERIFIED`, ON_DEATH message `RELEASED` with exactly one release, one grant, one
  activation. Reject: owner stays `ACTIVE`, nothing released. The frontend has no route that changes these states.
- **BullMQ:** PostgreSQL is authoritative; deterministic job ids per message, exponential backoff, bounded history, a
  reconciler re-enqueues missing/late jobs at startup and on an interval, an early job is re-delayed, failed retry is
  allowlisted and never forces a release.
- **Frontend failure handling (browser):** API unreachable → "We couldn't load your account", session cookie kept,
  Try again recovers; 500 with a Prisma message in the body → fixed copy only; HTML 502 → fixed copy; 403 → "Access
  denied" without sign-out; 429 → rate-limit copy, no retry.
- **Browser audit (prod build, 375 px and 1440 px, 26 pages incl. admin):** no horizontal overflow, no raw enums or
  `undefined`/`[object Object]`, no page errors; console only shows expected `401/404/400` network lines (session
  checks, deliberate not-found URLs). Admin tables become stacked cards on phones.
- **Copy:** no "seamless/effortless/take control/manage your…" phrasing; customer-visible enums go through label maps.

## 6. Verification (Pass B)

| Gate                                            | Result                                                                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend unit                                    | PASS — 624                                                                                                                                                                                        |
| Backend e2e                                     | PASS — 186                                                                                                                                                                                        |
| Backend lint / TypeScript / build               | PASS / PASS / PASS                                                                                                                                                                                |
| Frontend unit/component                         | PASS — 202                                                                                                                                                                                        |
| Frontend lint / typecheck / build               | PASS / PASS / PASS                                                                                                                                                                                |
| Playwright                                      | PASS — 34 passed, 0 failed, 0 skipped: `vault` + `production-build` 27 (with the fictional admin, both review cases and the OTP log), `account` 3, `development` (`auth.spec`, real `next dev`) 4 |
| PHOTO / AUDIO upload (real bucket)              | PASS (incl. failed PUT → retry, browser recorder)                                                                                                                                                 |
| Message scheduling / release / Recipient access | PASS (FIXED_DATE released by the worker, read by the Recipient)                                                                                                                                   |
| Trusted Contact flow / Customer safety flow     | PASS                                                                                                                                                                                              |
| Admin auth / death review                       | PASS (enrolment, wrong code, refresh, suspend → Customer 401 → reactivate, verify, reject, queues, sign out)                                                                                      |
| Authorization isolation                         | PASS (live probe 79/79 after fixes)                                                                                                                                                               |

Environment notes from the run: the API on :4000 and `next dev` on :3000 stopped during the audit (not caused by the
app); `next dev` first compiles took up to 52 s per route. Real-backend suites were run against production builds, as the
README prescribes.

## 7. Accepted / deferred

SEC-001, AUTH-001, DATA-001, OPS-001, ENV-001 above, plus already-tracked roadmap items: Content-Security-Policy, the
production cookie domain, Redis-backed throttling, pending-upload/orphan-object cleanup, standalone "sign out all
devices".

## 8. Vibe-code review

| Area                  | Signs of rushed/AI development | Evidence                                                                                                                       |
| --------------------- | :----------------------------: | ------------------------------------------------------------------------------------------------------------------------------ |
| Backend architecture  |              LOW               | One module per domain, guards per principal, shared OTP engine instead of copies, owner-scoped queries, explicit DTOs          |
| Frontend architecture |              LOW               | One API client, one query-key registry with per-principal namespaces, shared states/forms/dialogs; no direct `fetch`, no `any` |
| Design consistency    |              LOW               | Shared tokens and components; the Recipient/Trusted Contact/admin portals reuse the same system                                |
| Copy consistency      |              LOW               | Human labels for every enum; no generic SaaS phrasing found                                                                    |
| Error handling        |              LOW               | Typed `ApiError`, fixed copy for 429/5xx, network ≠ 401, safe API errors                                                       |
| Test quality          |              LOW               | Real-HTTP e2e with DB assertions; Playwright uses roles/labels; one dev-server-sensitive spec fixed (TEST-001)                 |
| Security boundaries   |              LOW               | All probes held; the CSRF gap was defence in depth and is closed                                                               |
| Code duplication      |              LOW               | No material duplication found worth abstracting                                                                                |
| Hardcoded values      |              LOW               | Timeouts and limits are env-configured with defaults; localhost only in `.env.example` and test config                         |
| Temporary hacks       |              LOW               | The Nest scaffold was the only leftover and is removed                                                                         |
| Product polish        |              LOW               | Remaining gaps are documented roadmap items, not placeholders or fake data                                                     |

## 9. Remaining production blockers (unchanged by this step)

Production email provider (OTP, safety notices), Stripe billing, WordPress login + shared cookie domain, CSP, staging and
production infrastructure, rotating the historical credential in SEC-001 if it was ever reused.

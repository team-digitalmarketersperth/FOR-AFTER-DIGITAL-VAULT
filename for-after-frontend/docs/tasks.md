# 🕊️ For After — Frontend Task Tracker

> Progress for the Next.js app (`for-after-frontend`). The full-stack roadmap, including backend phases, is
> [`for-after-backend/docs/task.md`](../../for-after-backend/docs/task.md); its **FE-n** numbers are used here.

| | |
|---|---|
| **Last updated** | 2026-10-03 |
| **Latest step** | Step 23: full application audit + fixes (no new features); report: `for-after-backend/docs/step-23-audit.md` |
| **Tasks** | **27 of 30** built and verified ✅ (FE-1–19, FE-21–28) |
| **Open** | FE-20 billing (no backend yet), FE-29/30 WordPress login |
| **Unit / component tests** | **204 passing** (14 files, Vitest + React Testing Library) |
| **Playwright** | **36 passing, 0 failing, 0 skipped** (Step 24, 2026-10-03, real local API with `EMAIL_PROVIDER=console`, PostgreSQL, Redis, development bucket, a fictional admin and failed job): `development` 4 · `vault` + setup 27 · `account` 3 · `production-build` 2 |
| **Blocker** | None for the built scope |
| **Design system** | [`frontend-design-system.md`](frontend-design-system.md) |

## 📖 How to read this file

| Symbol | Meaning |
|:--:|---|
| ✅ | Built, and verified by passing tests |
| 🧪 | Built and component-tested; its Playwright (real backend) run is still pending (none today) |
| 🟡 | Partly built |
| ⬜ | Not started |

---

## 📊 Tasks at a glance

| Group | Tasks | Status |
|---|:--:|---|
| A. Foundation (FE-1–6) | 6 | ✅ 6 of 6 |
| B. Customer account (FE-7–9) | 3 | ✅ 3 of 3 |
| C. Customer vault (FE-10–20) | 11 | ✅ 10 of 11 · ⬜ FE-20 |
| D. Recipient portal (FE-21–23) | 3 | ✅ 3 of 3 |
| E. Trusted Contact portal (FE-24–27) | 4 | ✅ 4 of 4 |
| F. Admin portal (FE-28) | 1 | ✅ 1 of 1 |
| G. WordPress (FE-29–30) | 2 | ⬜ |
| **Total** | **30** | **27 built and verified** |

## ✅ All tasks

| # | Task | Status | Step | Where |
|:--:|---|:--:|:--:|---|
| FE-1 | Next.js app with the planned stack | ✅ | 17 | `package.json`, `src/app` |
| FE-2 | API client with cookies, typed `ApiError` (400/401/403/404/409/429/5xx/network) | ✅ | 17 | `src/lib/api/client.ts`, `errors.ts` |
| FE-3 | Auth-aware layout (`/auth/me` 401 → `/login`, 403 access denied, admins kept out) | ✅ | 17 | `components/auth/auth-gates.tsx` |
| FE-4 | Dashboard shell: sidebar, mobile sheet, header with account menu | ✅ | 17 | `components/layout/dashboard-shell.tsx` |
| FE-5 | Dashboard home (no invented statistics) | ✅ | 17 | `app/(dashboard)/dashboard` |
| FE-6 | Shared loading / error / empty states | ✅ | 17 | `components/shared/states.tsx` |
| FE-7 | `/dev-login`, real 404 in production builds | ✅ | 17 | `app/(auth)/dev-login`, `src/proxy.ts` |
| FE-8 | Register / login pages | ✅ | 17 | `app/(auth)` |
| FE-9 | Account settings: name, read-only email, password change | ✅ | 22 | `components/account/account-settings.tsx`, `app/(dashboard)/settings` |
| FE-10 | People I Love: list (25 per page, Previous / Next), add, view, edit, remove, private photo (Phase 09) | ✅ | 18 | `components/people/recipients.tsx`, `person-card.tsx` |
| FE-11 | Trusted Contacts (Customer side): list, add, edit, remove; Phase 10: max 2, invitation status, send/resend | ✅ | 18, Phase 10 | `components/people/trusted-contacts.tsx` |
| FE-12 | Messages: drafts, content type, recipients | ✅ | 18 | `components/messages/` |
| FE-13 | Message media: direct upload with progress + cancel, previews, delete | ✅ | 18 | `components/media/media-manager.tsx` |
| FE-14 | Browser audio recorder | ✅ | 18 | `components/media/audio-recorder.tsx` (E2E with Chromium's fake microphone) |
| FE-15 | Schedule picker: FIXED_DATE (+ timezone offset), ON_DEATH, AFTER_DEATH; change; unschedule | ✅ | 18 | `components/messages/schedule-panel.tsx` |
| FE-16 | Status views + explicit "unschedule to edit" | ✅ | 18 | `message-detail.tsx`, `LockedNotice` |
| FE-17 | Memory Vault: category filter, CRUD, photo/audio | ✅ | 18 | `components/memory-vault/memories.tsx` |
| FE-18 | My Story: prompts by category, answer/edit/delete | ✅ | 18 | `components/prompts/prompts.tsx` |
| FE-19 | My Wishes: same, with the exact non-legal disclaimer | ✅ | 18 | `components/prompts/prompts.tsx` |
| FE-20 | Plan / billing pages (Stripe) | ⬜ | — | Backend not built (phase 21) |
| FE-21 | Recipient sign-in: email → 6-digit code | ✅ | 19 | `components/portals/otp-sign-in.tsx`, `recipient.tsx` |
| FE-22 | Released messages list + message page | ✅ | 19 | `components/portals/recipient.tsx` |
| FE-23 | Photo/audio via short-lived signed URLs | ✅ | 19 | `MediaManager` (view-only scope) |
| FE-24 | Trusted Contact sign-in: email → 6-digit code | ✅ | 19 | `components/portals/trusted-contact.tsx` |
| FE-25 | Accounts list (name, preserved-content flag, case status) | ✅ | 19 | `AccountList` |
| FE-26 | Death report form (date, note, summary, explicit confirmation, 409 states) | ✅ | 19 | `ReportForm` |
| FE-27 | Case status page (all six statuses); Phase 10: "Submit a new death report" after a closed case (API `canReport`) | ✅ | 19, Phase 10 | `AccountStatus`, `lib/death-verification.ts` |
| — | Phase 10: invitation page `/trusted-contact/invitation?token=…` (view, accept, decline; no session) | ✅ | Phase 10 | `TrustedContactInvitation` |
| FE-28 | Admin portal: password + mandatory TOTP sign-in/enrolment (+ recovery codes), users, death-verification review, audit log, queues | ✅ | 20 | `components/admin/`, `app/admin/` |
| FE-29 | WordPress login/signup forms | ⬜ | — | WordPress side |
| FE-30 | Shared `.forafter.com.au` cookie + redirect to the app | ⬜ | — | Deployment config |

Also built, outside the FE list: the Customer death-verification **safety banner** with "I'm still alive"
(`components/layout/safety-banner.tsx`, Step 19).

Also built (backend Phase 04): `/verify-email`, `/forgot-password` and `/reset-password` in `app/(auth)` with
`components/auth/account-links.tsx`. Verify runs once from the emailed link (signed in or not) and offers a new link
when it is used or expired; resend and forgot-password always show the API's generic answer (no account enumeration),
resend then has a 60 s cooldown; reset reuses the registration password rule, signs nobody in and points to `/login`.
Register → `/login?registered=1` now says a verification link is being emailed; login links to "Forgotten your
password?". Tests: `account-links.test.tsx` (10) and `e2e/account-recovery.spec.ts` (4, needs an API with
`EMAIL_PROVIDER=console`: `E2E_BACKEND_LOG` + `E2E_EMAIL_API`).

---

## 🗓️ Step history

### Step 17 — Foundation, Customer auth, dashboard shell
- Next.js 16 + React 19 + TypeScript + Tailwind 4 + shadcn/ui (Radix) + TanStack Query + React Hook Form + Zod + Lucide.
- One API client (`credentials: 'include'`), `ApiError`, `/auth/me` as the only Customer auth source; no tokens or storage.
- `/login`, `/register`, `/dev-login` (404 in production via `src/proxy.ts`), protected dashboard, logout clears the cache.
- Tests: 50 unit/component + 6 Playwright, all passing.

### Step 17 refinement — WordPress-matched design
- Palette, fonts (Cormorant + Figtree), pill buttons, inputs, logo and photography taken from the live WordPress site;
  verified vs inferred values documented in `frontend-design-system.md`.
- Header redesigned as an account menu (avatar, name, email → "Signed in as" card + Log out).

### Step 18 — Customer vault (FE-10 to FE-19)
- People I Love, Trusted Contacts, Messages (drafts, content types, recipients, readiness, schedule, unschedule-to-edit),
  photo/audio direct uploads with progress and cancel, browser recorder, Memory Vault, My Story, My Wishes.
- Shared: `PageHeader`, `ConfirmDialog`, `QueryView`, `ChoiceGroup`, `FilterChips`, `TextAreaField`, toasts (`sonner`).
- A 401 from any Customer call clears private data and returns to `/login`.
- Tests: 99 unit/component passing at the end of the step. Playwright `e2e/vault.spec.ts` (9 tests) written, **not run**.

### Step 19 — Portals and safety (FE-21 to FE-27)
- Recipient portal (`/recipient/...`) and Trusted Contact portal (`/trusted-contact/...`): each has its own OTP sign-in,
  session gate, query namespace and sign-out. A 401 in one never signs out the Customer or the other portal.
- Recipients see only released, granted messages (text, photos with lightbox, audio on demand).
- Trusted Contacts see accounts, a status page in plain words, and a report form that says report ≠ verification ≠ release.
- Customer safety banner + "I'm still alive" confirmation on every dashboard page while a case is open.
- Bug found by tests and fixed: a pasted "123 456" code was truncated by `maxLength` before spaces were stripped.
- Tests: 134 unit/component passing. Playwright `e2e/portals.spec.ts` (4 tests; 2 need `E2E_BACKEND_LOG`) written, **not run**.

### Step 20 — Admin Portal (FE-28)
- Separate portal under `/admin` with its own gate (`GET /admin-auth/me`), shell, navigation (Overview · Users · Death
  verification · Audit logs · Queues) and `['admin', …]` query namespace. No Customer navigation, no invented sections.
- Sign-in: password → in-memory challenge → first-time enrolment (setup key + locally drawn QR via `qrcode.react` →
  first code → 10 recovery codes shown once) or TOTP / recovery-code verification → `/admin-auth/me` → portal. A 401
  goes to `/admin/login` (never `/login`), a 403 shows "Access denied" without signing out, the server's idle timeout
  shows "Your admin session expired".
- Users (server search/filter/paging, metadata + counts only, suspend with reason, reactivate, no action for PASSED,
  DELETED, self, other admins as ADMIN, or SUPER_ADMIN), death-verification review (reports, real event timeline,
  verify with an explicit offset timestamp + confirmation, reject, 409 "case changed" + refetch, terminal read-only),
  audit log list/detail (URL filters, secret-looking metadata keys never rendered), queue summary, failed jobs, retry.
- Shared: `CodeField` (extracted from the portal OTP step), `ConfirmDialog` takes form fields and scrolls on phones.
- Tests: 43 new component tests (184 total). Live run against the real API with fictional data: enrolment, wrong code,
  refresh, suspend → Customer session 401 → reactivate → login, confirm-alive race → 409 → CANCELLED, verify → PASSED +
  ON_DEATH release by the backend, reject, audit events, idle timeout (server set to 30 s on a second local instance),
  logout, Customer → Access denied; reviewed at 375/768/1440 px. `e2e/admin.spec.ts` passing.

### Step 21 — Stabilisation, real-backend verification, git baseline
- No new features. Everything built through Step 20 verified against the real local API, PostgreSQL, Redis and the
  `for-after-dev` bucket, with the dev OTP log and fictional data only.
- **Selector issue:** `getByLabel(/^Message/)` also matched the detail page's `<section aria-label="Message">`; the spec
  uses `getByRole('textbox', { name: /^Message/ })` and waits for the edit URL (test bug; the app's labels are right).
- **Bucket CORS** was already in place (`../backblaze/cors-rules.json`: `http://localhost:3000`, `s3_put`,
  `content-type`; bucket private). Verified in a real browser: preflight 200/204, `PUT` 200, `complete` 200, READY,
  photo preview decoded, audio file and recorded webm play, an unsigned GET is refused (401).
- **Bug found and fixed (FE-26):** after a successful death report the confirmation and the redirect to the status page
  were sometimes lost, and the page said "You've already submitted a report". `useDeathReport` awaited its refetch, the
  refreshed status unmounted the form, and TanStack Query skips a `mutate()` callback after an unmount. The refetch is no
  longer awaited (`hooks/use-portals.ts`); regression test in `portals.test.tsx`.
- **New E2E:** a failed storage PUT stays `PENDING_UPLOAD`, scheduling is refused (409), retry → READY, the unfinished
  attempt can be removed, and the browser recorder (fake microphone) uploads to READY (`vault.spec.ts`).
- **Other failures seen were environment, not app:** `next dev` first compiles (21 s–77 s per route) and HMR rebuilds
  aborting navigations, one Turbopack panic (`restoring failed`), one Backblaze `500` on a PUT. The real-backend suites
  now run against a production build (see the README).
- Verified live outside the specs: network unavailable (API unreachable → "We couldn't load your account", not a
  `401`, cookie kept, Try again recovers); verify → owner `PASSED` → ON_DEATH message `RELEASED` with a
  `RecipientMessageAccessGrant`; reject → `REJECTED`.
- Tests: 185 unit/component, 31 Playwright, all passing. Lint, typecheck and production build pass.

### Step 22 — Account settings (FE-9) and its backend
- Backend: `PATCH /users/me` (first/last name only; email, role, status rejected) and `POST /auth/change-password`
  (current password required, registration rule, 5/min). The browser that changes the password keeps a new session;
  every other Customer session gets 401 (`User.passwordChangedAt` vs session `authenticatedAt`). `PASSWORD_CHANGED`
  audited with actor `CUSTOMER`. Migration `add_customer_account_settings`.
- `/settings` from the account menu: *Your profile* (names, Save disabled until changed, response written into
  `['auth','me']` so header/menu/greeting update at once; email read-only text) and *Security* (current/new/confirm,
  `current-password`/`new-password`, inline "Password updated. Other devices have been signed out.").
- A wrong current password is a 400, so it never signs the browser out; 401 still returns to `/login`; network errors
  keep typed values. Admin audit log now labels the `CUSTOMER` actor and `PASSWORD_CHANGED`.
- Email change (Phase 08): the email stays read-only text with a "Change email" dialog (new address + current
  password → "Verification email sent" with the masked address, resend, cancel); `/settings/verify-email-change`
  (in `app/(auth)`, opens with or without a session) confirms, clears the private cache and asks for a sign-in with
  the new address. Tests in `account-settings.test.tsx`, `account-links.test.tsx` and `e2e/account-recovery.spec.ts`.
- Tests: 14 component tests (199 total); `e2e/account.spec.ts` 3 Playwright tests against the real API (name persists
  across reload and greeting, wrong current password, change → other device 401, old password refused, new works).
  Checked at 375/768/1280/1440 px (no horizontal scroll; panels ≤ 768 px).
- **Redesign (same step, UI only):** editorial layout (details + account summary side by side on desktop, Security
  row below), password fields moved into a "Change password" dialog, success as toasts. No API, validation or
  session change. 17 component tests (3 new: summary, dialog open/Escape, Cancel).
- Environment note: during the run the local `next dev` (:3000) and the backend watcher (:4000) stopped; both were
  restarted for verification. A freshly started `next dev` once served `/settings` as 404 before warming up (the
  production build always served it); the re-run passed.

---

### Step 23 — Audit, bug bash, hardening (no new features)
- Full audit of both apps; register and evidence in `for-after-backend/docs/step-23-audit.md`. 0 P0/P1.
- Backend: Origin check on state-changing requests (CSRF defence in depth), Nest scaffold removed.
- Frontend: a detail page whose item is missing or fails to load now has an `h1` (`EmptyState`/`ErrorState` `heading`).
- Playwright: `account.spec` moved to its own `account` project (production build, after the vault suite, 5/min
  logins); `portals.spec` can route code requests to a second API instance (`E2E_OTP_API`) whose output is the log.
- Browser audit of 26 pages at 375/1440 px, simulated API failures, live IDOR/mass-assignment/CORS probes: no other
  findings. Deferred: separate admin cookie, historical local DB password in the initial commit (rotate if reused).

### Step 23 follow-up — admin cookie, queue retry E2E, safeguard env
- Admin sessions use their own cookie `for_after_admin_session` (Customers keep `for_after_session`); admin sign-out is
  `POST /admin-auth/logout`; admin cache events only touch `['admin', …]`. A Customer and an admin can now be signed in
  in the same browser profile. A Customer on `/admin` sees the admin sign-in (no "Access denied": the Customer cookie
  is never sent to admin routes).
- Failed-job retry verified end to end in the browser with a fictional failed job.
- Local `.env`: one `DEATH_VERIFICATION_SAFEGUARD_SECONDS` (60, development only).

### Step 24 — Transactional email (backend; small frontend changes)
- Sign-in codes, "a message is waiting for you" after a release, and the account-holder safety notice are emailed
  through the backend email provider, Brevo since 2026-10-05 (backend `docs/email-production-setup.md`). No frontend copy change was needed: the code step already
  shows the API's neutral message and "Sent to …".
- Admin queues: the new `email-delivery` queue appears with its failed jobs shown as "Email <id>" (never an address).
- Playwright: `portals.spec` reads codes (and checks the release email) from the console provider's
  `[DEV ONLY] Email (<kind>) to …` lines in `E2E_BACKEND_LOG`; run the API with `EMAIL_PROVIDER=console`.
- Real email from a For After domain waits on authenticating it in Brevo (manual). The frontend never knows the provider.

---

## ⚠️ Open items

**Follow-ups found in Step 21 (not blocking the built scope)**
- [x] **Separate admin session cookie** (Step 23 follow-up): `for_after_admin_session`, own Redis prefix, read only on
  admin routes; `POST /admin-auth/logout`. Verified in one browser profile (Playwright `admin.spec`): Customer and
  admin side by side, refresh both, Customer logout → admin stays, admin logout → Customer stays.
- [x] Failed-job **retry** E2E (Step 23 follow-up): backend `scripts/dev-failed-job-fixture.mjs` makes one fictional
  failed job (development only; random message id with no row); `admin.spec` retries it through the UI
  (`E2E_ADMIN_FAILED_JOB`) and the real worker completes it as `stale`.
- [x] Local `.env` now sets `DEATH_VERIFICATION_SAFEGUARD_SECONDS` once (`60`, marked development only); production stays
  `1209600` (`.env.example`, `docs/deployment.md`).

**Before production**
- [ ] Content-Security-Policy (needs the API and storage domains).
- [ ] CSRF review for cookie-based requests (backend task, phase 05).
- [ ] Production cookie domain `.forafter.com.au` and CORS for the app domain (FE-30, deployment).
- [ ] Brand confirmation: inferred colours, and the rights to reuse the site's logo and photos in the app.

**Product decisions the frontend follows but does not make**
- Trusted Contacts: at most 2 (Phase 10); invitations by email only (no SMS), shown as pending / accepted / declined / expired / not sent / no invitation.
- No recipient downloads, no SMS codes, no evidence upload, no second-contact confirmation.
- After a case is closed without a death (CANCELLED / REJECTED), a new report starts a new case (Phase 10); after VERIFIED no report is accepted. The portal follows the API's `canReport`.

---

## 🧪 How to verify

```bash
# Unit / component (no backend needed)
npm test                       # 204 tests
npm run lint && npm run typecheck && npm run build

# Playwright (needs PostgreSQL, Redis and the NestJS API on :4000)
npx playwright test --project=development             # Step 17, against `npm run dev`
npx playwright test --project=vault --project=production-build   # Steps 18–20, against a production build on :3000
npx playwright test --project=account --no-deps                   # Step 22 alone (it otherwise runs after vault)
# Admin signed-in flows: a fictional local admin (backend docs/admin.md §11), see the README "Admin Portal" section
#   E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… [E2E_ADMIN_TOTP_SECRET=…] npx playwright test e2e/admin.spec.ts
# Portal OTP flows: tee the backend output, then point the tests at it
#   backend:  npm run start:dev | tee backend.log
#   frontend: E2E_BACKEND_LOG=../for-after-backend/backend.log npx playwright test --project=vault
```

- The production build takes ~5 minutes on this machine. Start `npm run build && npx next start -p 3100` yourself so
  Playwright reuses it.
- Login/register are throttled to 5 per minute: wait a minute or two between full runs.
- `vault.spec` uploads a few tiny test files to the development bucket; the portal specs use fictional data only.

### Manual checks with the real backend
1. **Customer:** `/register` → `/login` → dashboard; add a person, write a message, schedule it, unschedule it.
2. **Recipient:** schedule a TEXT message for a person with an email ~2 minutes ahead and wait for `RELEASED`. Then open
   `/recipient/sign-in`, enter that email, and read the code from the API console (with `EMAIL_PROVIDER=console`:
   `[DEV ONLY] Email (recipient-otp) to s***@… | … Your sign-in code is 123456 …`; the release itself also logs a
   `message-released` email). Sign in, read the message, sign out.
3. **Trusted Contact:** add a trusted contact with an email, then use `/trusted-contact/sign-in` (code from the console)
   → account → submit a fictional report → status "Report received".
4. **Safety banner:** sign in as the Customer → banner → "I'm still alive" → confirm → the banner disappears and the case
   is `CANCELLED`.
5. **Admin:** register a fictional account, promote it (`docs/admin.md` §11), sign in at `/admin/login`, enrol an
   authenticator, save the recovery codes, then: users → suspend/reactivate; a READY_FOR_REVIEW case → verify or reject;
   audit logs; queues. Sign out and confirm `/admin` returns to `/admin/login`.

---

## ⏭️ Next: Step 23 (proposal, not started)

See the backend roadmap (`for-after-backend/docs/task.md`). FE-20 (billing) and FE-29/30 (WordPress) are the remaining
frontend tasks; both wait on backend/deployment work first.

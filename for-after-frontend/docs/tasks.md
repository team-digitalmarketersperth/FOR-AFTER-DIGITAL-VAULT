# 🕊️ For After — Frontend Task Tracker

> Progress for the Next.js app (`for-after-frontend`). The full-stack roadmap, including backend phases, is
> [`for-after-backend/docs/task.md`](../../for-after-backend/docs/task.md); its **FE-n** numbers are used here.

| | |
|---|---|
| **Last updated** | 2026-11-17 (updated plans Step 7; see the section below) |
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
| FE-9 | Account settings: name, read-only email, password change; storage meter with 80/90/100 % notices (Phase 12C); Storage Manager `/settings/storage` (breakdown, files largest first, type/source filters, delete through each feature, restricted message files) | ✅ | 22 | `components/account/account-settings.tsx`, `storage-usage.tsx`, `storage-manager.tsx`, `app/(dashboard)/settings` |
| FE-10 | People I Love: list (25 per page, Previous / Next), add, view, edit, remove, private photo (Phase 09) | ✅ | 18 | `components/people/recipients.tsx`, `person-card.tsx` |
| FE-11 | Trusted Contacts (Customer side): list, add, edit, remove; Phase 10: max 2, invitation status, send/resend | ✅ | 18, Phase 10 | `components/people/trusted-contacts.tsx` |
| FE-12 | Messages: drafts, content type, recipients | ✅ | 18 | `components/messages/` |
| FE-13 | Message media: direct upload with progress + cancel, previews, delete (ImageKit + VIDEO since Phase 12) | ✅ | 18 | `components/media/media-manager.tsx` |
| FE-14 | Browser audio and video recorder (video: Phase 12A) | ✅ | 18 | `components/media/recorder.tsx` (E2E with Chromium's fake camera and microphone) |
| FE-15 | Schedule picker: NOW, FIXED_DATE (+ timezone offset), BIRTHDAY, ANNIVERSARY, CUSTOM_EVENT (local time + IANA zone), ON_DEATH, AFTER_DEATH, ANNUAL_AFTER_DEATH; missing-birthday warning; "shared with N of M" for repeating schedules; change; unschedule | ✅ | 18, Phase 16 | `components/messages/schedule-panel.tsx` |
| FE-16 | Status views + explicit "unschedule to edit" | ✅ | 18 | `message-detail.tsx`, `LockedNotice` |
| FE-17 | Memory Vault: category filter, CRUD, photo/audio; search, tags, pagination (Phase 13A); create a message from a memory (Phase 13B) | ✅ | 18 | `components/memory-vault/memories.tsx`, `memory-to-message.tsx` |
| FE-18 | My Story: prompts by category, answer/edit/delete; approved V1 catalogue (from the API), 50,000-char answers, earlier-wording notice (Phase 14A); photo/audio/video answers with recorders, linked memories, create a message (Phase 14B) | ✅ | 18 | `components/prompts/prompts.tsx`, `memory-vault/memory-to-message.tsx` |
| FE-19 | My Wishes: same, with the non-legal notice served by the API, informational only (Phase 15A; no checkbox or Continue since 2026-10-14); photo/audio/video with the shared uploader and recorders, files-only wishes, "Create message for loved ones" → existing message page for people and After-my-passing timing (Phase 15B); no AI (deferred post-MVP) | ✅ | 18 | `components/prompts/prompts.tsx`, `components/memory-vault/memory-to-message.tsx` |
| FE-20 | Plan / billing pages (Stripe) | ⬜ | — | Phase 21 built locally, billing off by default; trial restriction UI Steps 3–5 below. Not marked done here (no Stripe test-mode run) |
| FE-21 | Recipient sign-in: email → 6-digit code (2026-10-16: or mobile → SMS code) | ✅ | 19 | `components/portals/otp-sign-in.tsx`, `recipient.tsx` |
| FE-22 | Released messages list + message page | ✅ | 19 | `components/portals/recipient.tsx` |
| FE-23 | Photo/audio via short-lived signed URLs | ✅ | 19 | `MediaManager` (view-only scope) |
| FE-24 | Trusted Contact sign-in: email → 6-digit code | ✅ | 19 | `components/portals/trusted-contact.tsx` |
| FE-25 | Accounts list (name, preserved-content flag, case status) | ✅ | 19 | `AccountList` |
| FE-26 | Death report form (date, note, summary, explicit confirmation, 409 states) | ✅ | 19 | `ReportForm` |
| FE-27 | Case status page (all six statuses); Phase 10: "Submit a new death report" after a closed case (API `canReport`) | ✅ | 19, Phase 10 | `AccountStatus`, `lib/death-verification.ts` |
| — | Phase 10: invitation page `/trusted-contact/invitation?token=…` (view, accept, decline; no session) | ✅ | Phase 10 | `TrustedContactInvitation` |
| — | Delivery Timeline (2026-10-13): `/messages/timeline`, a read-only connected timeline (Coming up · When the time comes · Recently delivered), dates in each schedule’s own zone, per-Recipient birthdays, no dates for death-triggered items; dashboard “Coming up” (max 4) and “Recent changes”; `/settings/activity` | ✅ | — | `components/delivery/`, `components/activity/`; `e2e/delivery-timeline.spec.ts`, `e2e/activity.spec.ts` |
| — | Dashboard "Needs your attention" (2026-10-14): up to 4 calm rows from `GET /users/me/attention` (messages needing timing, Trusted Contact invitations, a missing birthday a scheduled birthday message needs, storage ≥ 80 %), "+N more", all-clear / loading / error states; refetched on each dashboard visit | ✅ | — | `components/dashboard/attention.tsx`; `e2e/attention.spec.ts` |
| — | Phase 19B: admin case page shows "Confirmations N of M" (pending/satisfied); Verify disabled with the reason when the requirement isn't met (the API also refuses, 409), Reject unchanged. Trusted Contact portal unchanged: the second contact uses the existing report action and sees no counts | ✅ | Phase 19B | `Confirmations`, `Decision` in `components/admin/death-verifications.tsx`; `e2e/death-confirmations.spec.ts` |
| — | Phase 19A: supporting evidence on the case page (reporter of an open case only): PDF/JPEG/PNG picker, client checks, upload progress → "checking" → "ready for review" (never "verified"), own-file list + short-lived re-view; admin "Supporting evidence" panel with secure view and timeline labels | ✅ | Phase 19A | `EvidenceSection`, `useEvidenceUpload`, `useOpenSignedFile`; admin `EvidenceList`; `e2e/death-evidence.spec.ts` |
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
- **Video recorder (Phase 12A, 2026-10-07):** `Recorder kind="VIDEO"` next to "Add a video" on editable VIDEO/MIXED
  drafts. Camera + microphone are asked for together, only on "Record a video" (no silent video: refusing either one
  is a calm error, and "Add a video" stays usable). Live preview → Start → timer and size so far → Stop → play back →
  "Use this recording" (the normal upload, so progress, cancel, Try again, server verification and the signed preview
  are the existing ones), "Record again" or Discard. Tracks are stopped and the preview URL revoked on stop, discard,
  cancel, success and leaving the page; the recording lives in memory only. Over 100 MB is refused before any upload;
  there is no duration limit. Format: WebM (VP9/VP8 + Opus) when the browser supports it, else MP4; otherwise the
  recorder says recording is not available. Verified only in Chromium (Playwright fake camera, real ImageKit); Safari
  and Firefox, and a real camera, not yet tested.
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
- Real email from a For After domain waits on live verification of the backend's Microsoft Graph setup (manual; Brevo was removed 2026-10-21). The frontend never knows the provider.

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
- No recipient downloads, no evidence upload, no second-contact confirmation. SMS codes: Recipients only
  (2026-10-16); Trusted Contacts stay email-only (SMS deferred, post-MVP).
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

## Trusted Contact readiness (2026-10-14, local)

- `/trusted-contacts`: each card shows ✓ Ready / ○ Invitation pending / ! Invitation expired / ! Needs attention
  (icon + words), a one-line detail ("Invitation accepted 12 Oct 2026", "sent …") and Send / Resend through the
  existing invitation route; a readiness summary above the cards. The contact's page shows the same in "Setup".
- Dashboard journey step: "N contacts ready" / "Waiting for your contact to accept". Trusted Contact mutations now
  invalidate the readiness query.
- Tests: `people.test.tsx`, `journey.test.tsx`.

## Draft autosave & version history (2026-10-14, local)

- Message, My Story and My Wishes editors autosave unsaved text to the API 2.5 s after typing stops
  (`useDraftEditor`), show a quiet "Autosaved …" status beside Save, and offer *Unsaved changes found*
  (Restore / Discard / preview) when reopened. Nothing private is kept in browser storage.
- Message detail: **Version history** sheet (list, preview, DRAFT-only restore with confirmation).
- Tests: `shared/draft-recovery.test.tsx`, `messages/version-history.test.tsx`, `e2e/history.vault.spec.ts`.
- Backend reference: `for-after-backend/docs/draft-recovery.md`.

## Recipient Portal redesign (2026-10-15, local)

- `/recipient/messages`: "A space shared with you" intro, released count, newest message featured (content-type art,
  no media fetched), earlier ones as a divided list; calm empty and error states.
- Message detail: serif title, "Shared with you on …", text as a letter sheet, photos then recordings/video
  (signed only when shown/played), "A private message, preserved for you."
- Tests: `portals/portals.test.tsx`. Backend reference: `for-after-backend/docs/recipient-portal.md`.

## Private notes to self (2026-10-15, local)

- Message, Memory, My Story and My Wishes editors: an optional, visually quiet *Private note to
  yourself* field (`shared/private-note.tsx`, 2,000 max, hint "Only you can see this."), saved with
  the normal Save; not autosaved. Message and Memory detail show the note to the owner.
- Recipient-facing views never receive it (the API omits it). Tests: `messages.test.tsx`,
  `memories.test.tsx`, `my-wishes-rich.test.tsx`. Backend reference: `for-after-backend/docs/private-notes.md`.

## Recipient SMS sign-in (2026-10-16, local)

- `/recipient/sign-in`: **Email | Mobile** switch (email stays the default and unchanged). Mobile: country select
  (AU, NZ, IN, UK, US/CA) + number → E.164, SMS consent line, **Text me a code** → "Check your phone", masked number
  (`+61 ••• ••• 678`), the shared 6-digit `CodeField`, 30 s resend countdown (UX only; the API limits), "Use a
  different mobile number". Success goes to `/recipient/messages` like email. No Twilio code or secrets in the frontend.
- People form: a Recipient mobile needs its country code (the API requires E.164).
- Tests: `portals/portals.test.tsx`, `people/people.test.tsx`; Playwright `e2e/recipient-sms.spec.ts` against an API
  with `SMS_VERIFY_PROVIDER=console` (never real SMS).
- **Real SMS verified 2026-10-16** (one OTP to an Indian mobile, approved, Recipient session created). Procedure:
  `for-after-backend/docs/recipient-portal.md` §3b.

## Trial restrictions Step 5: four text questions (2026-11-14, local)

Backend contract: `for-after-backend/docs/billing.md` §8 (`GET /billing` `trialCaps.questions` + `questionsAnswered`;
409 `TRIAL_LIMIT`). Shared pieces in `components/shared/trial-cap.tsx` (`useTrialQuestions`, `useQuestionGate`,
`TrialQuestions`, `QuestionGateNotice`).
- "X of 4 trial questions answered" on My Wishes (list) and My Story (workspace), and on both answer pages.
- At the cap, a question with nothing saved shows **Pro**: the My Wishes card and the My Story workspace editor open
  "Answer more questions with a plan" (View plans / Close). Saved answers stay editable; files-only answers still open
  for their files.
- A new answer waits for the plan: "Checking your plan…", or "We couldn’t check your plan just now" + "Check plan again";
  never an open form on unknown data. An open or typed-in form is never swapped away; a `TRIAL_LIMIT` refusal keeps the
  text and shows View plans. Saves and deletes re-read `GET /billing`.
- Memory links (close-out): "Choose from Memory Vault" (workspace) and "Link a memory" (answer page) show **Pro** and
  open "Available with a paid plan" when `features.memoryLinks` is false; linked memories keep Unlink.
- Workspace save fix (close-out): the question is pinned before the save request, and a save no longer waits for the
  plan refresh. Before, the refreshed list could move "first unanswered" mid-save, remounting the editor and dropping
  "Your answer and private note are saved." (found in the browser run; regression test in `story-workspace.test.tsx`).
- Paid, exempt and billing-off accounts: no counter, no Pro.
- Memory Vault: no question limit (its trial allowance is a pending product decision).
- **Verified (close-out, fresh):** full suite 58 files 833/833; isolated source typecheck exit 0 (the normal
  `tsc --noEmit` is blocked by the dev server's generated `.next/dev/types`); eslint on changed files; isolated
  production `next build` exit 0 with generated-route types valid; isolated browser run 14/14 (shared count, Pro
  dialog with keyboard and Close, editing, delete and clear free a slot, loading/retry, stale refusal keeps text,
  paid). Older editor tests route an explicit billing-off `GET /billing` (`BILLING_OFF` in `src/test/utils.tsx`).
  Report: `for-after-backend/docs/trial-step-5-closeout.md`. **Not run:** the repo's Playwright suite (it targets
  :3000/:4000 and the real development ImageKit).

## Trial restrictions Step 6: expired trial, read-only (2026-11-14, local)

Contract: `for-after-backend/docs/billing.md` §8 Step 6 (402 with `code` `TRIAL_EXPIRED` etc.). Shared pieces:
`components/shared/plan-lock.tsx` (`usePlanLock`, `PlanLockedButton`, `UpgradeDialog`, per-state copy) and
`PlanAccess` in `components/layout/dashboard-shell.tsx`.
- Notice on content pages: "Your free trial has ended" / "Choose a plan to keep creating and editing. You can still
  view, download and delete your existing content." / View plans. Other no-access states keep their own copy.
- Create/edit controls and links open the plan dialog (View plans / Close); blocked `…/new|edit|create-message` URLs
  explain and offer "View it read-only" or "Back to the list" (no redirect).
- Saved answers read-only (Edit answer → dialog, Delete stays); opening a message prompts once (View plans /
  Continue viewing); media, songs, schedule, restore, recipient photo and invitation controls locked; deletes stay.
- Open forms are never swapped; a refused save says "This wasn’t saved. What you typed is still here." with View
  plans; autosave refused with 402 says so and stops. Plan re-read at trial end, on focus and after any refusal.
- Fix: the shell keeps one stable tree, so pages are never remounted when the plan loads or changes.
- **Verified (fresh):** full suite 59 files 853/853 (new `trial-expired.test.tsx` 20); isolated source typecheck
  exit 0 (normal `tsc` blocked by the dev server's `.next/dev/types`); eslint `src` exit 0; isolated production
  `next build` exit 0 with route types valid; isolated browser 14/14 at 1280 and 390 px. **Not run:** the repo's
  Playwright suite (it targets :3000/:4000 and the real development ImageKit).

## Trial restrictions Step 7: approved refinements, consistent restriction UI (2026-11-16, local)

Contract: `for-after-backend/docs/billing.md` §8 Step 7 (five decisions approved). Shared pieces in
`components/shared/trial-cap.tsx`: `TRIAL_CAP_COPY.memories`, `TrialMemories` ("X of 1 trial memory used", from
`GET /billing` `memoriesSaved`), `useCreateGate` + `CreateGateNotice` (create pages), `ShellShowsPlanCheck`.
- Memory Vault: counter under the search row; "Save a memory" becomes the shared Pro button + dialog ("Save more
  memories with a plan", View plans → `/settings/plan`, Close; focus returns) at the cap; `/memory-vault/new` at the
  cap explains with View plans / Back to Memory Vault. Memory writes refresh the plan. Paid/exempt/billing-off: none.
- `/memory-vault/new`, `/people/new`, `/trusted-contacts/new`: one gate. Loading → "Checking your plan…"; unreadable →
  no form (the shell's single "Check plan again"); decided once, so a refetch never removes an open form; no trial cap
  → opens as soon as the plan is read.
- Unlink (My Story answer page and workspace) uses `DELETE …/response/memories` with that one id, so it works after a
  trial ends; linking stays Pro/locked as before.
- Unsaved words: when autosave is refused (402) the status reads "Not saved to your account." and a temporary copy is
  kept in `sessionStorage` (`lib/local-drafts.ts`, per account; cleared by `resetPrivateCache` on sign-in, sign-out and
  session expiry, by Discard, or once the server holds the words). Reopening the editor offers it with the same label;
  Restore fills the form and sends nothing. While read-only, the answer page, workspace, message page and Messages
  list show "Unsaved draft in this tab" with View unsaved draft (exact text, read-only) and Discard
  (`KeptDraft`, `components/shared/draft-recovery.tsx`). Copy says it is temporary and may disappear when the tab
  closes. Close-out fix: the copy is removed only on real evidence (server autosave, explicit Save, identical to the
  saved text), never because the form briefly equals the saved text while the page loads.
- Schedule panel: when locked the button reads "Unschedule" (no "to edit").
- Tests: new `components/shared/trial-step7.test.tsx`, `components/shared/kept-draft.test.tsx`; updated `people.test.tsx` (forms wait for the plan),
  `memories.test.tsx`, `my-story-rich.test.tsx`, `story-inline-media.test.tsx`, `trial-expired.test.tsx`.

## Updated plans Steps 3–4: paid recipient limit and media by tier (2026-11-16, local)

Contract: `for-after-backend/docs/billing.md` §9 (409 `PLAN_LIMIT`; 409 `TIER_REQUIRED` with `requiredTier: 'COMPLETE'`;
`GET /billing` `features.mediaKinds`).
- **Step 3:** no app code change. The recipient form already shows a `PLAN_LIMIT` message and keeps the input, with
  no "View plans" link. Pinned in `people.test.tsx`.
- **Step 4, shared pieces** (`components/shared/trial-cap.tsx`, `form-field.tsx`):
  - `ProBadge` takes a `label`, `ProButton` a `badge`, and `ChoiceGroup` locked choices a `badge`.
  - New `COMPLETE_VIDEO_COPY`, `CompleteVideoButton`, and `usePaidMedia().videoLocked`. It locks only when the plan
    says media is allowed and video isn't; an unknown plan locks nothing.
- **Where Premium sees "Complete":**
  - the media manager's Add a video and Record a video (the recorder is hidden);
  - the Video message format, unless the message is already VIDEO;
  - the My Story workspace's Add a video (its picker no longer accepts video, and a picked video is explained
    locally);
  - a story or wish video in Create a message ("Copy this video").
- `TIER_REQUIRED` refusals show the message plus View plans, keep the form, and re-read the plan
  (`FormError`, `UploadFailed`, `query-client`).
- The trial's Pro controls are unchanged.
- Tests: new `components/shared/plan-media.test.tsx` (8).
- Verified: 21 files, 329/329; eslint; isolated build; isolated browser 13/13 at desktop and phone width.

## Updated plans Step 5: AI allowance in the companion (2026-11-17, local)

Contract: `for-after-backend/docs/billing.md` §9 Step 5 (`GET /assistant/usage`; 409 `AI_ALLOWANCE_EXHAUSTED`,
409 `AI_REQUEST_DUPLICATE`, 503 `AI_USAGE_UNRECORDED`).
- `companion.tsx`:
  - each Send (and each Try again) sends a fresh `requestId`;
  - one usage line under the composer, read only while the panel is open ("X of 5 trial AI replies used" /
    "X of 50 AI replies used this month · resets 1 December"), and nothing for unmetered accounts;
  - exhaustion has its own message, with the UTC reset date, no Try again, and a note that writing can continue on
    your own;
  - the hourly 429 message is unchanged;
  - a failed request gives the typed text back;
  - nothing is resent, saved or scheduled automatically.
- `lib/api/errors.ts`: `ApiError.allowance` holds the typed, validated facts for `AI_ALLOWANCE_EXHAUSTED` only.
- `lib/api/assistant.ts`: `requestId`, `AssistantUsage`, `assistantApi.usage`. `query-client.ts`:
  `queryKeys.assistantUsage`.
- Admin AI Operations: labels for the outcomes `allowance_exhausted`, `duplicate_request` and `usage_unrecorded`.
- Tests: `companion.test.tsx`:
  - the harness gained a query client, a usage stub, and per-Send request ids recorded apart from the body (the
    existing exact-body assertions are unchanged);
  - 5 new tests.
- Verified 2026-11-17: 30 files, 365/365; eslint clean; isolated build 62/62; isolated browser 7/7 at 1280 and 390 px
  (fake provider, synthetic tiers).

## Updated plans Step 6: tier Checkout on the plan page (2026-11-17, local)

Contract: `for-after-backend/docs/billing.md` §9 Step 6 (`POST /billing/checkout { tier, interval }`,
`checkoutOptions`, `subscription.mapping`, access state `plan_unresolved`).

`plan.tsx` "Choose a plan" (a minimal change; Step 7 redesigns it):
- one row per tier, with a button per interval that the server offers;
- options that aren't on sale say "not available yet";
- no prices are shown or invented.

`plan.tsx`, other changes:
- A mapped subscription shows "For After Complete, annual". Legacy and unmapped ones keep "Monthly" / "Annual".
- `plan_unresolved` explains itself, links to support, offers no second checkout, and stops the return checks.
- The return from Checkout still polls the server and never unlocks from the URL.

Elsewhere:
- `lib/api/billing.ts`: the `CheckoutOption` / `PaidTier` types; `checkout(option)`.
- `use-billing.ts`.
- `lib/billing.ts`: `TIER_LABEL`, plus the `plan_unresolved` label and tone.
- `plan-lock.tsx`: copy for `plan_unresolved`.
- `dashboard-shell.tsx`.
- Admin Billing: the `plan_unresolved` filter and colour.

Tests: `plan.test.tsx` was updated for the new checkout body, and 2 tests were added (tier naming and legacy wording;
unresolved).

Close-out (2026-11-17):
- An unresolved account is sent to **Contact support** (`/support/new`) and never "View plans" or "Choose a plan" in:
  - the lock dialogs (`PLAN_LOCK_COPY.plan_unresolved.action`, rendered by `ProDialog` and `UpgradeDialog`);
  - a refused save (`FormError` on `PLAN_UNRESOLVED`);
  - the plan page (the generic "Choose a plan to keep adding…" note is hidden for this state).
- Tests: `plan-unresolved.test.tsx` (new, 3 tests).
- Verified: 36 files, 440/440; eslint and source typecheck clean; isolated build 62/62; isolated browser 10/10 at 1280
  and 390 px (fake Stripe, synthetic accounts; local evidence, not payment evidence).
- Evidence: `for-after-backend/docs/evidence/updated-plans-step-6/`.
- Later the same day, the backend's Prisma CLI was restored to 7.10. The frontend was not affected, so the results
  above stand (not rerun).
- Still blocked: real sandbox Checkout. Still interim: the unresolved-price rule.

## Updated plans Step 7: plans and usage experience (2026-11-17, local)

Contract: `for-after-backend/docs/billing.md` §9 Step 7. Report: `for-after-backend/docs/updated-plans-step-7-report.md`.

**Settings → Plan** (`account/plan.tsx`, rebuilt):
1. Summary: the plan comes from the tier in force, with access shown separately; dates; Start free trial (eligible
   only); Manage billing.
2. Usage: storage, People I Love, trusted contacts, AI and the trial counts.
   - Accessible bars capped at 100%, with the real values in the text.
   - Try again per source, never 0.
   - Never "unlimited".
3. Plans: three cards from the server's `planDefinitions`, plus a `<details>` comparison (removed in the
   2026-11-19 refinement below).
   - A radio interval selector shows configured options only, and sends `{ tier, interval }`.
   - Subscribers see no upgrade or second checkout.
   - No prices are shown (no pricing contract).

**Shared locks** (`shared/trial-cap.tsx`):
- `useCapCopy` and `capFor`: People I Love locks at the server's limit, including paid limits.
- Badges: "Premium" by default; "Complete" for video and Premium's 10-person limit. At Complete's 50 there is no badge
  and the dialog offers Close only.
- `ProDialog` can omit its action.
- `PeopleCounter` on the People I Love and Trusted contacts pages.

**Elsewhere:**
- Companion: "Compare plans" on trial and Premium allowance exhaustion only.
- `use-vault`: people writes refresh `/billing`. `query-client`: `PLAN_LIMIT` re-reads the plan.

**Tests:**
- `plan.test.tsx` (rewritten, 20 tests), `plan-locks.test.tsx` (new, 8), companion (+1, and the throttling check).
- Badge, copy and `requestId` updates in existing suites (`requestId` checks were stale since Step 5).

**Verified (local, fake Stripe):**
- All 53 files in the 12 affected directories pass (final run plus 3 files rerun alone after load-induced
  timeouts/worker starts).
- eslint (91 files) and typecheck clean.
- Isolated build 62/62.
- Browser 12/12 at 1280, 820, 390 and 200% zoom. Screenshots are in
  `for-after-backend/docs/evidence/updated-plans-step-7/screens/`.
- Real payments: not verified (sandbox blocked).

**Refinement (2026-11-19, local):** the three plan cards and the `<details>` comparison are removed (pricing and
comparison live on the marketing site).
- "Choose a plan" is the one authenticated Checkout entry: a panel per configured tier, with the same interval radios
  and `{ tier, interval }` payload. Shown only with billing on and no subscription held.
- One "Compare plans" link, only when `NEXT_PUBLIC_PLANS_URL` (https) is set. **Unset: no verified URL, no link.**
- Companion exhaustion link renamed "View plans".
- Verified: 53 files 746/746, tsc/eslint clean, isolated build 62/62, browser 9/9 at 1280 and 390
  (`for-after-backend/docs/evidence/updated-plans-step-7/refinement/`).
- Open: the marketing pricing URL; sandbox payments.

## Updated plans Step 8: final integration verification (2026-11-19, local)

Report: `for-after-backend/docs/updated-plans-step-8-report.md`.
- **Account management split:** `/settings/plan` keeps status, usage, Start free trial, Manage billing and one
  "Choose a plan" button (only when buying is possible). The tier/interval Checkout moved to the new authenticated
  `/settings/plan/choose` (`ChoosePlanPage`), which refuses subscribers ("You already have a subscription") and sends
  unresolved accounts to support. The external "Compare plans on our website" link lives there, only when
  `NEXT_PUBLIC_PLANS_URL` (https) is set: **unset, no verified URL**. The locked banner is hidden on both plan routes.
- **Fixed:** usage meters were stale after a plan change (Start free trial left "5.0 GB" and "Available again with an
  active plan"). `query-client.ts` now re-reads storage and AI usage when `GET /billing` changes state, access or tier.
- Verified: 64 files, 918/918; tsc/eslint clean; isolated build 63/63; browser journeys 17/17 at 1280, 820, 390 and
  200% (`for-after-backend/docs/evidence/updated-plans-step-8/`). The repo Playwright suite was not run (it uploads to
  the real development ImageKit account and can't target isolated services).
- Open: marketing pricing URL; sandbox payments; screen-reader testing.

## Updated plans Step 7 refinement 2: Settings → Plan as an account page (2026-11-20, local)

Report: `for-after-backend/docs/updated-plans-step-7-report.md` (Refinement 2).
- `account/plan.tsx`: concise dates once each ("27 Nov 2026, 9:44 am (UTC+5:30)"); a trial row only in trial states;
  "View plans" at the end of the read-only notice; "Choose a plan" and the optional external "Compare plans" moved into
  the summary card (buy-eligible accounts only; never subscribers, unresolved or billing off); usage grid
  `sm:grid-cols-2 xl:grid-cols-3`.
- Verified: 53 files, 750/750 (6 files rerun alone after worker-start failures); tsc/eslint clean; isolated build
  63/63; browser 16/16 at 1280 and 390 plus keyboard (`for-after-backend/docs/evidence/updated-plans-step-7/refinement-2/`).
- Open:
  - The marketing pricing URL (`NEXT_PUBLIC_PLANS_URL` unset).
  - No post-sign-in return to `/settings/plan/choose`.
  - Grandfathered accounts still see Choose a plan (policy open).
  - Sandbox payments.

## ⏭️ Next: Step 23 (proposal, not started)

See the backend roadmap (`for-after-backend/docs/task.md`). FE-20 (billing) and FE-29/30 (WordPress) are the remaining
frontend tasks; both wait on backend/deployment work first.

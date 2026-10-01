# 🕊️ For After — Frontend Task Tracker

> Progress for the Next.js app (`for-after-frontend`). The full-stack roadmap, including backend phases, is
> [`for-after-backend/docs/task.md`](../../for-after-backend/docs/task.md); its **FE-n** numbers are used here.

| | |
|---|---|
| **Last updated** | 2026-09-30 |
| **Latest step** | Step 19: Recipient portal, Trusted Contact portal, Customer death-verification safety banner |
| **Tasks** | **25 of 30** built (FE-1–8, FE-10–19, FE-21–27) |
| **Open** | FE-9 profile (no backend yet), FE-20 billing, FE-28 admin portal, FE-29/30 WordPress login |
| **Unit / component tests** | **134 passing** (12 files, Vitest + React Testing Library) |
| **Playwright** | 6 passing (Step 17) · 13 written for Steps 18–19, **not yet run** |
| **Blocker** | Storage bucket CORS rule missing: real browser uploads fail (see [Open items](#-open-items)) |
| **Design system** | [`frontend-design-system.md`](frontend-design-system.md) |

## 📖 How to read this file

| Symbol | Meaning |
|:--:|---|
| ✅ | Built, and verified by passing tests |
| 🧪 | Built and component-tested; its Playwright (real backend) run is still pending |
| 🟡 | Partly built |
| ⬜ | Not started |

---

## 📊 Tasks at a glance

| Group | Tasks | Status |
|---|:--:|---|
| A. Foundation (FE-1–6) | 6 | ✅ 6 of 6 |
| B. Customer account (FE-7–9) | 3 | ✅ 2 of 3 · ⬜ FE-9 |
| C. Customer vault (FE-10–20) | 11 | 🧪 10 of 11 · ⬜ FE-20 |
| D. Recipient portal (FE-21–23) | 3 | 🧪 3 of 3 |
| E. Trusted Contact portal (FE-24–27) | 4 | 🧪 4 of 4 |
| F. Admin portal (FE-28) | 1 | ⬜ next step |
| G. WordPress (FE-29–30) | 2 | ⬜ |
| **Total** | **30** | **25 built** |

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
| FE-9 | Profile and account settings | ⬜ | — | Backend not built (phase 08) |
| FE-10 | People I Love: list, add, view, edit, remove | 🧪 | 18 | `components/people/recipients.tsx` |
| FE-11 | Trusted Contacts (Customer side): list, add, edit, remove | 🧪 | 18 | `components/people/trusted-contacts.tsx` |
| FE-12 | Messages: drafts, content type, recipients | 🧪 | 18 | `components/messages/` |
| FE-13 | Message media: direct upload with progress + cancel, previews, delete | 🧪 ⚠️ | 18 | `components/media/media-manager.tsx` (needs bucket CORS) |
| FE-14 | Browser audio recorder | 🧪 | 18 | `components/media/audio-recorder.tsx` |
| FE-15 | Schedule picker: FIXED_DATE (+ timezone offset), ON_DEATH, AFTER_DEATH; change; unschedule | 🧪 | 18 | `components/messages/schedule-panel.tsx` |
| FE-16 | Status views + explicit "unschedule to edit" | 🧪 | 18 | `message-detail.tsx`, `LockedNotice` |
| FE-17 | Memory Vault: category filter, CRUD, photo/audio | 🧪 | 18 | `components/memory-vault/memories.tsx` |
| FE-18 | My Story: prompts by category, answer/edit/delete | 🧪 | 18 | `components/prompts/prompts.tsx` |
| FE-19 | My Wishes: same, with the exact non-legal disclaimer | 🧪 | 18 | `components/prompts/prompts.tsx` |
| FE-20 | Plan / billing pages (Stripe) | ⬜ | — | Backend not built (phase 21) |
| FE-21 | Recipient sign-in: email → 6-digit code | 🧪 | 19 | `components/portals/otp-sign-in.tsx`, `recipient.tsx` |
| FE-22 | Released messages list + message page | 🧪 | 19 | `components/portals/recipient.tsx` |
| FE-23 | Photo/audio via short-lived signed URLs | 🧪 | 19 | `MediaManager` (view-only scope) |
| FE-24 | Trusted Contact sign-in: email → 6-digit code | 🧪 | 19 | `components/portals/trusted-contact.tsx` |
| FE-25 | Accounts list (name, preserved-content flag, case status) | 🧪 | 19 | `AccountList` |
| FE-26 | Death report form (date, note, summary, explicit confirmation, 409 states) | 🧪 | 19 | `ReportForm` |
| FE-27 | Case status page (all six statuses) | 🧪 | 19 | `AccountStatus`, `lib/death-verification.ts` |
| FE-28 | Admin portal: TOTP sign-in, users, death-verification review, audit log, queues | ⬜ | 20 | Backend ready (Step 16) |
| FE-29 | WordPress login/signup forms | ⬜ | — | WordPress side |
| FE-30 | Shared `.forafter.com.au` cookie + redirect to the app | ⬜ | — | Deployment config |

Also built, outside the FE list: the Customer death-verification **safety banner** with "I'm still alive"
(`components/layout/safety-banner.tsx`, Step 19).

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

---

## ⚠️ Open items

**Blocking or needed soon**
- [ ] **Bucket CORS rule** on `for-after-dev` for `http://localhost:3000` (`PUT`, header `content-type`). Without it,
  real browser uploads fail (preflight 403). Later the same for `https://app.forafter.com.au`.
- [ ] **Run the Playwright suites for Steps 18–19** against the local backend (commands below). Until then FE-10–19
  and FE-21–27 stay 🧪, not ✅.
- [ ] **Put the frontend under git.** It is not in any repository yet (the root repo has no commits).

**Before production**
- [ ] Content-Security-Policy (needs the API and storage domains).
- [ ] CSRF review for cookie-based requests (backend task, phase 05).
- [ ] Production cookie domain `.forafter.com.au` and CORS for the app domain (FE-30, deployment).
- [ ] Brand confirmation: inferred colours, and the rights to reuse the site's logo and photos in the app.

**Product decisions the frontend follows but does not make**
- No Trusted Contact invitations or "invitation sent" states (no invitation API).
- No recipient downloads, no SMS codes, no evidence upload, no second-contact confirmation.
- After a case is closed (including "I'm still alive"), the backend accepts no new reports for that account.

---

## 🧪 How to verify

```bash
# Unit / component (no backend needed)
npm test                       # 134 tests
npm run lint && npm run typecheck && npm run build

# Playwright (needs PostgreSQL, Redis and the NestJS API on :4000)
npx playwright test                                   # everything
npx playwright test --project=vault                   # Steps 18–19 only
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
   `/recipient/sign-in`, enter that email, and read the code from the API console (`[DEV ONLY] Recipient OTP for
   s***@…: 123456`). Sign in, read the message, sign out.
3. **Trusted Contact:** add a trusted contact with an email, then use `/trusted-contact/sign-in` (code from the console)
   → account → submit a fictional report → status "Report received".
4. **Safety banner:** sign in as the Customer → banner → "I'm still alive" → confirm → the banner disappears and the case
   is `CANCELLED`.

---

## ⏭️ Next: Step 20 — Admin portal (FE-28)

Admin TOTP sign-in and enrolment (password → `mfaRequired` challenge), user list with suspend/reactivate,
death-verification review queue (verify/reject with confirmations), audit log viewer, and queue monitoring/retry, all on
the Step 16 admin API. Separate from the Customer app, with its own layout, gate and idle-timeout handling.

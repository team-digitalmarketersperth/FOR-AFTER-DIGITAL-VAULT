# Trial restrictions Step 6: expired trial, read-only access and upgrade (2026-11-14)

**Status: implemented and verified locally.** Billing settings, Stripe and providers were not changed. Nothing was
staged, committed, pushed or deployed. Evidence: [`evidence/trial-step-6/`](evidence/trial-step-6/).

## Completion status

- Backend: the existing 402 gate already enforced the policy for every customer content write. This step adds a
  machine-readable reason, an audit of every write route, and controlled-clock tests.
- Frontend:
  - the approved notice
  - the shared plan dialog on create/edit controls and links
  - read-only answers
  - the message prompt
  - honest refusal handling and plan refresh
  - a fix for page remounts in the shell
- Verified with unit, isolated e2e, a production build and isolated desktop and phone browser runs.
- Four policy cases are ambiguous and were kept as they were. They are listed under "Remaining decisions".

## What changed

**Backend**
- `src/billing/billing-access.ts`: `NO_ACCESS_CODES` / `noAccessCode()` map each no-access state to a stable code:
  `trial_expired` → `TRIAL_EXPIRED`, `trial_available` → `TRIAL_NOT_STARTED`, `payment_pending` → `PAYMENT_PENDING`,
  `access_ended` → `PLAN_ENDED`, anything else → `PLAN_REQUIRED`.
- `src/billing/billing.service.ts`: `writeAccess(userId, now)` returns `{ hasAccess, state }` from the central resolver
  (server time). `hasAccess()` now uses it.
- `src/billing/billing-access.interceptor.ts`: the 402 keeps its message and status and adds `error` and `code`. The
  decision is unchanged: Customer, POST/PUT/PATCH, a `@RequiresPlan` route, checked at request time.
- **Audit result:** every customer content write controller was already gated (list in `billing.md` §8 Step 6). No
  route needed a new gate, and none was opened. Never gated: reads, media access URLs, every DELETE (including
  unscheduling), auth (sign-out), profile, communication preferences, billing, support and confirm-alive. Workers,
  releases, grants and death verification are untouched.
- Tests:
  - `src/billing/billing-access.spec.ts`: the reason code for each state, plus the exact trial-end boundary on a fixed
    clock (1 ms before, at, and 1 ms after). Paid with ended dates, billing off and grandfathered keep access, and an
    ended trial is never eligible again.
  - New `test/trial-expired.e2e-spec.ts`, 8 tests. Only `Date` is faked, pinned around a fixed `END` of 2030-01-01.
    It covers:
    - the boundary, including a form opened before the end and sent after it;
    - 26 create/edit routes refused with 402 `TRIAL_EXPIRED` and nothing changed;
    - lists, details, a media access URL and storage readable;
    - account, support and preferences open;
    - deletes across modules, with ownership still returning 404;
    - checkout unavailable (503) and writes still refused afterwards;
    - paid and grandfathered accounts can still write;
    - an account that never started a trial gets `TRIAL_NOT_STARTED`;
    - "Start free trial" returns the same ended trial, with no restart.

**Frontend**
- New `src/components/shared/plan-lock.tsx`:
  - `usePlanLock()`: locked only when billing is on and the API says `hasAccess` is false. Paid, billing-off and
    grandfathered accounts are never locked. Unknown is not locked; the API still refuses.
  - Per-state copy. The expired-trial copy is the approved text, word for word.
  - `PlanLockedButton` (opens the shared dialog with View plans and Close).
  - `UpgradeDialog`: a controlled dialog that returns focus to whatever opened it.
- `src/components/layout/dashboard-shell.tsx` (`PlanAccess`):
  - Compact notice with "View plans".
  - Links to `…/new`, `…/edit` and `…/create-message` open the dialog. This is done in the capture phase, so there is
    no navigation.
  - Blocked direct URLs offer "View it read-only" or "Back to the list", with no redirect.
  - One timer re-reads the plan when an active trial ends.
  - "Check plan again" appears when the plan can't be read.
  - **Fix:** the shell now always renders the same tree. Before, a page was remounted when the plan request settled.
    Found when 22 `account-settings` tests failed; typed input would have been lost.
- Read-only answers (`useQuestionGate` returns `'readonly'`; `src/components/prompts/prompts.tsx`, `story-workspace.tsx`):
  - A saved answer shows read-only text, "Edit answer" opens the dialog, and Delete answer stays.
  - A new question offers "Write your answer", which opens the dialog.
  - A form that is already open, or has typing in it, stays open.
- Locked inline controls:
  - media add and record (`media-manager.tsx`), and the workspace "Add media" and memory picker;
  - linking and unlinking memories;
  - song add and edit (reorder hidden) (`wish-songs.tsx`);
  - schedule and change timing (`schedule-panel.tsx`), where unscheduling stays and its text no longer promises
    editing;
  - restore version (`version-history.tsx`);
  - recipient photo (`recipients.tsx`);
  - invitations (`trusted-contacts.tsx`).
- `message-detail.tsx`: opening a message shows the prompt once, decided when the plan is first known (View plans /
  Continue viewing). It never reopens on refetch.
- Refusals:
  - `FormError` adds "This wasn't saved. What you typed is still here." and "View plans" for 402.
  - `query-client.ts` re-reads the plan after any 402.
  - Autosave refused with 402 shows a plain status, stops retrying and keeps the text (`use-draft-editor.ts`,
    `draft-recovery.tsx`).
- `src/components/account/plan.tsx`: with no plan on sale and no access, the page says plans can't be bought online yet
  and links to support. The existing checkout-return checks are unchanged: a success URL grants nothing.
- Tests:
  - New `src/components/shared/trial-expired.test.tsx`, 20 tests, covering the banner, link interception and focus,
    direct routes, other states, paid/grandfathered/billing-off, unreadable plan, the trial-end timer, read-only
    answers, form opened before expiry, the message prompt not reopening, media, checkout return and the autosave
    refusal.
  - Updated: `dashboard-shell.test.tsx` (copy "Choose a plan" → "View plans"; "read" → "view").
  - Updated: `wish-songs.test.tsx`, whose "nothing but the songs API" assertion now excludes the plan read.

## Fresh test results (after the last code change)

- **Backend `tsc`:** exit 0 (after fixing a typing error in the new e2e that this run caught).
- **Backend oxlint:** exit 0. 0 errors and 5 warnings, all pre-existing and in `ip-blocks` files.
- **Backend unit:** final full run 76/76 files, **1599 passed, 0 failed**.
  - An earlier combined run had 1 failure: `src/auth/auth.controller.spec.ts` "is limited to 5 attempts per minute"
    hit the 5 s timeout.
  - Run alone it passed 3 of 3 times in 0.7–0.9 s, and it passed in the later full run.
  - The test does a sign-in plus six password changes. Each is an argon2 check, which is CPU-heavy by design.
  - The file is unchanged, and that route isn't billing-gated.
  - Classification: CPU contention during the combined run, not Step 6. Not fixed (only a longer timeout would).
- **Backend isolated e2e** (test DB `for_after_p24`, Redis :6390, fake ImageKit, scanner, email and SMS, Stripe
  unconfigured): **17 files, 199 passed**. Files:
  - new `trial-expired` (8 tests)
  - Steps 2–5: `trial-questions`, `trial-media`, `trial-people`, `trial-storage`
  - other regressions: `billing`, `my-story`, `my-story-rich`, `my-wishes`, `my-wishes-rich`, `memory-to-message`,
    `messages`, `message-schedules`, `media`, `recipients`, `trusted-contacts`, `memory-vault`
- **Frontend unit/component:** full suite **59 files, 853 passed, 0 failed**.
- **Frontend typechecks:**
  - **Normal `tsc --noEmit`:** exit 2. All 6 errors are in the running dev server's generated `.next/dev/types`
    (`routes.d.ts` 4, `validator.ts` 2), which were left untouched. Those syntax errors stop tsc before it checks
    `src`, so this run verifies nothing.
  - **Isolated source-only check** (`src`, root configs and `e2e` against the last build's `.next/types`, excluding
    `.next/dev`): exit 0, 0 errors.
  - **Build-generated route types:** tsc on the build copy's own fresh `.next/types`: exit 0; its validator covers 186
    entries.
- **Frontend eslint (`src`):** exit 0.
- **Isolated production `next build`** (Next.js 16.3.7, Turbopack): exit 0. Compiled, TypeScript passed, 62/62 pages.
  - Built in a copy at `D:\for-after-p6-buildcheck` with `node_modules` as a junction and `turbopack.root` set in the
    copy only. The copy was deleted afterwards.
  - Log: `evidence/trial-step-6/next-build.log`.
- **Isolated browser, desktop 1280×900 and phone 390×844: 14/14 passed on the first run**
  (`evidence/trial-step-6/browser-run.jsonl`).
  - Stack:
    - App: the production build on :3001.
    - API: `node dist/main` on :4001 through the isolated wrapper.
    - Providers: email disabled; Twilio, Stripe and Nest Observe keys blank.
    - Accounts: synthetic accounts from `browser-seed.mjs` with fixed past trial dates, deleted afterwards. Mid-edit
      expiry was simulated by changing the fixture's trial row.
  - Checks, at both widths where marked:
    - Banner copy and View plans, with no horizontal overflow (both).
    - "Save a memory": keyboard opens the dialog, Escape closes it, focus returns, and there is no navigation (both).
    - A direct edit URL leads to "View it read-only" and the detail page, with no loop (both).
    - The message prompt offers View plans and Continue viewing, isn't reopened after a focus refetch, and Delete is
      still offered (both).
    - A saved wish is read-only: Edit answer opens the dialog and Delete answer is offered (both).
    - A memory can still be deleted.
    - Trial ends while a form is open (phone): the save is refused, "This wasn't saved" appears, the text is kept and
      the banner appears.
    - Trial not started shows its own copy.
    - Paid with old trial dates (phone): no banner, and forms open.

## What Step 6 does, in plain language

When an enforced free trial ends and there is no paid plan, the customer keeps everything:
- They can open, read and download their messages, people, contacts, story, wishes and memories, and delete anything.
- A calm notice at the top of content pages says the trial has ended and offers View plans.
- Buttons and links that would create or change something open the same "Your free trial has ended" dialog instead of
  a form.
- Saved answers show as read-only text.
- Opening a message explains the situation once.
- If the trial ends while something is being typed, the save is refused, the page says plainly that it wasn't saved,
  and the text stays on screen. It is never sent again automatically.

The server decides every write at the moment it arrives, using server time. The trial ends exactly at its end time, and
the refusal is 402 with a reason code (`TRIAL_EXPIRED`, or `TRIAL_NOT_STARTED`, `PAYMENT_PENDING`, `PLAN_ENDED` for
other states). A paid subscription always wins over old trial dates. Billing-off and grandfathered accounts are
unaffected, and the trial is never restarted or extended. Returning from checkout unlocks editing only after the server
confirms the subscription.

## Documentation updates

- `docs/billing.md`: §3 frontend paragraph; §8 new "Step 6" section (server, route audit, ambiguous cases, frontend,
  verification).
- `docs/task.md`: changelog row, Step 6 summary, and the status-board billing row (Steps 2–6).
- `for-after-frontend/docs/tasks.md`: new Step 6 section.
- This report and `docs/evidence/trial-step-6/`.

## Failed, blocked and not-run checks

- **Failed once, not reproduced:** `auth.controller.spec.ts` rate-limit test timeout in one combined unit run
  (contention evidence above). The final full run passed.
- **Blocked by the environment:** the normal frontend `tsc --noEmit`, because of the dev server's corrupt generated
  `.next/dev/types`. Covered by the isolated source check and the build's own route-type validation.
- **Not run:**
  - The repository's own Playwright suite. It targets :3000/:4000 and the real development ImageKit, which the brief
    rules out.
  - Real downloads in the browser. Media is served by ImageKit, so the browser run didn't fetch files; the e2e covers
    the signed access URL.
  - Any Stripe test-mode checkout.
  - Billing activation in deployed environments was not checked. The local `.env` billing settings were not changed.

## Remaining decisions

1. **Draft autosave after expiry:** it is a gated write, so new typing isn't autosaved. It stays in the open form, and
   the leave-page warning applies. Allow autosave (no new content, but new stored text), or keep it as is?
2. **Unlinking memories** from a My Story answer is a PUT and is refused after expiry. Deleting the whole answer is
   allowed. Should unlinking count as "deletion"?
3. **Unscheduling** (DELETE) stays allowed, so an expired customer can stop a release but not reschedule it. Intended?
4. **Trusted-contact invitation resends** are refused after expiry (a write). Should safety invitations stay open?
5. Memory Vault's trial text-entry allowance (from Step 5) is still pending.

## Manual checklist (for a person, on a staging or local stack with billing on)

1. Expired account: Messages, People, Trusted Contacts, Memory Vault, My Story and My Wishes each show the notice, and
   existing items open.
2. "New message", "Save a memory", "Add someone", Edit links: each opens the dialog; Close and Escape return focus.
3. Type `…/new` and `…/<id>/edit` URLs directly: you get the explanation and the read-only or back link, with no loop.
4. Open a message: the prompt appears once; Continue viewing; switch tabs and come back: no new prompt.
5. Download an existing photo or recording (real storage), and delete an item in each section.
6. With a form open, end the trial (admin or DB on staging) and save: "This wasn't saved", the text stays, View plans.
7. Upgrade through test-mode checkout: editing returns only after the plan page confirms the subscription.
8. Phone width: notice, dialog and read-only pages fit without sideways scrolling; keyboard and screen reader read the
   dialog title and buttons.

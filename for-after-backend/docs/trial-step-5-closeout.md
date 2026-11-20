# Trial restrictions Step 5: close-out report (2026-11-14)

Four text questions across My Story and My Wishes during an enforced active trial (`billing.md` §8). This report covers
the close-out pass: the memory-link correction, frontend build and browser verification, and the test-reliability
investigation. Evidence files are in [`evidence/trial-step-5/`](evidence/trial-step-5/). Nothing was staged, committed,
pushed or deployed.

**Status:** Step 5 is implemented and verified locally, including an isolated production build and an isolated
browser run. No requirement mismatch is known. Open items are listed under "Still open".

## 1. What changed in this pass

### Step 5 changes

**Memory links: corrected to the latest requirement.** Before this pass, trial customers could add memory links to
an answer that had words; only memory-only answers were refused. Now:

- **New or replacement links are refused** during an enforced active trial: any `memoryVaultItemIds` entry not already
  linked to that live answer, including on a new or memory-only answer. The refusal is
  `409 { code: 'PAID_FEATURE', message: PAID_MEMORY_LINK_MESSAGE }` and happens before any write, so text sent in the
  same request is not saved either.
- **Allowed:** unchanged links in a text save (ids compared case-insensitively); text saves that omit links; removing
  links; reading and deleting answers.
- **No side effects:** memories and files are never deleted.
- **Unchanged:** paid, billing-off and grandfathered accounts.
- Backend:
  - `featureAccess()` now returns `{ media, memoryLinks }` (`src/billing/billing-access.ts`).
  - `lockQuestionCap()` became `lockAnswerEntitlements()`: the User row lock, then the access state, then the question
    cap and the memory-link permission.
  - `paidFeatureError()` takes an optional message.
  - The check sits in `MyStoryService.save` before any write (`src/my-story/my-story.service.ts`).
  - The old "words required" rule and `TRIAL_MEMORY_LINK_LIMIT` are removed.
  - `GET /billing` `features` now includes `memoryLinks`.
- Frontend: "Choose from Memory Vault" (workspace) and "Link a memory" (answer page) show **Pro** and open "Available
  with a paid plan". Linked memories keep Unlink. Files: `src/components/shared/trial-cap.tsx`
  (`usePaidMemoryLinks`, `PaidMemoryLinkButton`), `src/components/prompts/story-workspace.tsx`,
  `src/components/prompts/prompts.tsx`.
- Tests:
  - New unit block in `src/my-story/my-story.service.spec.ts` with 7 tests:
    - a new link is refused before any write (with a text change in the same save);
    - a replacement set is refused;
    - a links-only first answer is refused with no row created;
    - unchanged links are kept in a text save (any letter case), and a text-only save leaves links alone;
    - removing links touches only the links;
    - paid, grandfathered and billing-off accounts can add and replace links, and billing-off takes no lock.
  - New `memoryLinks` policy test in `src/billing/billing-access.spec.ts`.
  - The e2e memory-link test in `test/trial-questions.e2e-spec.ts` is rewritten. It covers:
    - a new link, a replacement set, a new id in another letter case, a links-only first answer and a new link on a
      memory-only answer are all refused, with nothing saved;
    - unchanged links are kept with a text save, and a text-only save keeps links and the file;
    - unlinking works, and memories and files survive;
    - re-adding a removed link is refused;
    - deleting the memory-only answer keeps its memory.
  - The paid and grandfathered e2e test now adds links (including a memory-only answer) and unlinks. Replacement for
    those accounts is covered by the unit tests.
  - `test/trial-media.e2e-spec.ts` expects the new `features` shape.
  - New frontend test: the memory-link Pro dialog with keyboard focus return, Unlink still available, and paid accounts
    keeping the picker.

**Workspace save regression: found in the browser, fixed.** Saving the first unanswered question in the My Story
workspace remounted the editor and dropped "Your answer and private note are saved." The cause was Step 5's
`useAnswerMutation` waiting for the plan refresh as well as the prompt list. The refreshed list rendered first, marked
the question answered, and moved "first unanswered" to the next question before the question was pinned.

- Fixes:
  - The question is pinned before the request (`onSaving`, `story-workspace.tsx`).
  - The save no longer waits for the plan refresh (`src/hooks/use-vault.ts`).
- Regression test: `story-workspace.test.tsx`, "saving the first unanswered question keeps it on screen…". It delays the
  plan reply as in the browser. With the old order it **fails** (status never shown); with the fix it passes.

### Separate reliability fix (not Step 5 behaviour)

- `src/config/app.setup.spec.ts`: the Express adapter is imported statically, so the test's 5 s timeout no longer counts
  module loading. No assertion or timeout changed. See §3.

## 2. Fresh test results (all runs after the last code change, run one at a time)

- **Backend `tsc`:** exit 0.
- **Backend oxlint:** exit 0, 0 errors, 5 warnings. The warnings are pre-existing and in `ip-blocks` files only.
- **Backend unit (full suite, one combined run):** 76/76 files, 1597 passed, 0 failed, 0 skipped. `app.setup.spec.ts`
  passed inside this combined run.
- **Backend isolated e2e** (test DB `for_after_p24` and Redis :6390 via `scripts/phase24/isolated-env.mjs`, fake
  ImageKit and scanner, Stripe unconfigured, email disabled): 11 files, 108 passed, 0 failed.
  - Files: `trial-questions` (12 tests), `trial-people`, `trial-media`, `trial-storage` (includes recipient photos within
    the 100 MB trial allowance), `my-story`, `my-story-rich`, `my-story-book`, `my-wishes`, `my-wishes-rich`,
    `memory-to-message`, `billing`.
- **Frontend unit/component (full suite, one combined run):** 58/58 files, 833 passed, 0 failed.
- **Frontend typechecks** (three different checks):
  - **Normal `tsc --noEmit` (project tsconfig):** exit 2. All 6 errors are syntax errors in the running dev server's
    generated `.next/dev/types/routes.d.ts` (4) and `validator.ts` (2), which were left untouched. Syntax errors stop
    tsc before semantic checking, so this run verifies nothing about `src`.
  - **Isolated source-only check** (`evidence/trial-step-5/tsconfig.src-check.json`): `src`, root configs and `e2e`,
    against the repo's last build route types (`.next/types`), excluding `.next/dev` and the real `next-env.d.ts`. Exit
    0, 0 errors. An earlier run of this check caught a type error in the new frontend test, which is fixed.
  - **Production build and generated-route type validation:** see below.
- **Frontend eslint** (changed files): exit 0.
- **Isolated production `next build`** (Next.js 16.3.7, Turbopack): exit 0. "Compiled successfully", TypeScript step
  passed, 62/62 static pages. Log: `evidence/trial-step-5/next-build.log`.
  - How it was isolated: the current source was copied to `D:\for-after-p5-buildcheck` with `node_modules` as a junction
    and `turbopack.root: 'D:/'` set in that copy's config only. Turbopack refuses a junction that points outside its
    root. The repo, the dev server's `.next` and `next-env.d.ts` were not touched, and the copy was deleted afterwards.
  - Generated-route type validation: separately from the build, `tsc --noEmit` on the copy's own freshly generated
    `.next/types` (no `.next/dev`) exited 0. Its `validator.ts` covers 186 app entries.
- **Isolated browser run:** Chromium via the project's `playwright` package; script
  `evidence/trial-step-5/trial-questions.browser.mjs`, output `evidence/trial-step-5/browser-run.jsonl`.
  - Result: **14/14 passed**.
  - Stack:
    - App: `next start -p 3001` serving that production build.
    - API: `node dist/main` on :4001 through the isolated-env wrapper (test DB and Redis).
    - Providers: email disabled; Twilio, Stripe and Nest Observe keys blanked.
    - Billing: on, with enforcement from 2026-11-01.
    - Accounts: two synthetic accounts (trial and paid) seeded by `browser-seed.mjs`, deleted afterwards.
  - Checks:
    - The count is shared: 1 seeded, then 2 and 3 of 4 through the UI in both sections, then 4.
    - A fifth answer via the API gets 409.
    - At the cap: the Pro card opens "Answer more questions with a plan" with View plans and Close.
    - Escape and Close each close the dialog and return focus to the trigger.
    - The workspace shows Pro instead of the answer box, and Pro on the memory picker.
    - An existing answer stays editable at the cap.
    - Deleting an answer frees a slot and unlocks the question.
    - A stale-limit refusal keeps the typed text and shows View plans, and the count refreshes.
    - Clearing the words of a linked answer in the UI frees a slot and keeps the link.
    - While the plan loads: "Checking your plan…" and no answer box.
    - When the plan can't be read: a retry state; "Check plan again" then opens the form.
    - Paid account: no counter, no Pro.
  - History, kept for honesty:
    - First run, 8/14: failures came from my selector (`getByLabel('Your answer')` also matched the "Your answers" tab
      panel), and later checks cascaded from it.
    - Second run, 13/14: the workspace "saved" status was missing. This was the real regression fixed in §1.
    - One run, 0/14: an old `next start` was still serving while the build was replaced under it. That was my process;
      it was stopped and restarted.
    - Final run on the rebuilt app: 14/14.

## 3. Test reliability investigation

**`src/config/app.setup.spec.ts` startup timeout: a test-design problem exposed by load; fixed separately.**

- Symptom: "Test timed out in 5000ms" in combined runs, and once when run alone. Measured test-body times before the
  fix: 10.9 s cold with the dev servers busy, 4.4 s and 2.0 s warm.
- Code evidence: `node_modules/@nestjs/core/nest-factory.js:169` does
  `await import('@nestjs/platform-express')` inside `create()`. The test's 5 s budget therefore included loading Express
  and its adapter.
- Measured with `evidence/trial-step-5/nest-boot-probe.mjs` (plain Node, three runs each way):
  - Adapter preloaded: `create()` took 22–40 ms.
  - Lazy, as in the spec: 326–926 ms warm and 3,751 ms on a cold first run.
  - Vitest's transform pipeline makes module loading slower still (its "import" phase totals ran into hundreds of
    seconds under load).
- Classification: not an application bug, since `configureApp` itself takes milliseconds. Not shared state either. It
  is a timing budget that measured module loading, so resource contention could push it over.
- Fix (separate from Step 5): a static `import '@nestjs/platform-express'` in the spec moves the load into the import
  phase. The assertions and the 5 s timeout are unchanged. After the fix the body took 158 ms, 29 ms and 47 ms in three
  runs alone, and the test passed in the full combined suite (1597/1597).

**`src/components/shared/trial-media.test.tsx` intermittent failure: resource contention; not fixed.**

- Reproduced deliberately: 6 concurrent Vitest processes running `trial-media` + `people` failed **6/6**. The other 71
  tests in those files passed every time.
- The failing step is always the file's first test, at
  `findByRole('button', { name: /Add a photo\s*Pro/ })` (line 70). That is the default 1 s Testing Library timeout. The
  DOM at failure shows "Checking your plan…" and the media skeleton: the mocked plan request had not rendered within 1
  s. The UI was in its correct intermediate state, just late.
- Without contention it passed every time: full suite 833/833, plus earlier individual and combined runs. The original
  one-off failure happened while I was running the backend suite at the same time.
- Classification: resource contention, not an application bug and not shared state between tests. Left unchanged: the
  only lever would be a longer timeout, which the brief rules out. Mitigation: run the frontend suite on its own, not
  alongside backend suites or builds.
- Separate latent risk found while reading the code, not observed to fail: Radix `FocusScope` returns focus inside a
  `setTimeout(0)` after unmount (`@radix-ui/react-focus-scope`). The same test checks `toHaveFocus()` straight after the
  dialog disappears. Wrapping that check in `waitFor` would match Radix's asynchronous contract without weakening it.
  Not changed, because no failure has been observed.

## 4. Requirement check

- Four questions in total across My Story and My Wishes, any combination; a fifth is refused with 409 `TRIAL_LIMIT`
  and nothing saved: done. Covered by e2e, unit and browser tests.
- Edits and repeated saves take no slot; clearing or deleting frees one; links and files are kept on clear: done.
- Accounts above four keep and edit their answers but can't add new questions: done (e2e).
- Concurrent saves across sections serialise on the User row lock: done (e2e, 5-way and 8-way).
- Memory links: new or replacement links refused; unchanged links kept; unlinking allowed; nothing deleted; paid,
  billing-off and grandfathered unchanged: done in this pass (unit and e2e, plus a browser Pro check).
- Memory Vault: not counted, and no limit invented. **Its trial text-entry allowance is still pending.**
- Recipient photos: allowed within the 100 MB allowance (approved; `trial-storage` e2e). Steps 2–4 regressions pass.
- Frontend: shared counter, Pro dialog, keyboard and Close, loading and retry states, typed text kept, read and delete
  open, paid without locks: done (unit and browser).
- **No known remaining mismatch.**

## 5. Documentation updated

- `docs/billing.md` §8: memory-link rule corrected (`PAID_FEATURE`, `memoryLinks`); `lockAnswerEntitlements()`;
  plan-unknown behaviour; recipient photos approved; local billing activation as read; Memory Vault allowance pending.
- `docs/task.md`: Step 5 summary corrected for memory links; close-out entry points to this report.
- `for-after-frontend/docs/tasks.md`: Step 5 section with the memory-link Pro controls and the workspace save fix.
- This report and `docs/evidence/trial-step-5/`.

## 6. Still open

- **Pending decision:** Memory Vault's trial text-entry allowance.
- **Not fixed (contention):** `trial-media` first-test timeout under heavy parallel load (§3). There is also a latent
  Radix focus-timing assertion.
- **Not run:**
  - The repository's own Playwright suite (`for-after-frontend/e2e`). It targets :3000/:4000 and the real development
    ImageKit account, so it was not run.
  - A manual check on a phone-width screen.
  - Any Stripe test-mode flow.
- **Blocked by the environment:** the normal frontend `tsc --noEmit` while the dev server's generated `.next/dev/types`
  is corrupt. The isolated source check and the build's own type validation stand in for it.
- **Not checked:** billing activation in any deployed environment. Locally, `.env` has `BILLING_ENABLED=true` and
  `BILLING_ENFORCE_FROM=2026-11-12T11:24:49Z`, unchanged by this work.
- The final expired-trial experience is a later step (not built).

## 7. Safety

- Nothing was staged, committed, pushed or deployed.
- No billing settings, Stripe objects or providers were changed. No live provider was contacted: email was disabled,
  Twilio, Stripe and Nest Observe keys were blanked for the isolated API, and no uploads were made.
- Only synthetic accounts in the isolated test database were created, and all were deleted afterwards. No real
  customer data was touched.
- The user's dev servers (:3000 `next dev`, :4000 `nest --watch`) and their generated files were left alone. My own
  servers on :3001 and :4001 were stopped, and the temporary build copy was removed.

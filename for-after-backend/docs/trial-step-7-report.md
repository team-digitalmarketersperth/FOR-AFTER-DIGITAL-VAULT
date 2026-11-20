# Trial restrictions Step 7: approved refinements and consistent restriction UI (2026-11-16)

**Status: implemented and verified locally.** Billing activation, trial duration/start, Stripe prices, paid storage and
retention were not changed. No live provider was contacted. Nothing was staged, committed, pushed or deployed.
Evidence: [`evidence/trial-step-7/`](evidence/trial-step-7/).

## Close-out pass (2026-11-16, after the first report)

The close-out supersedes the earlier results below where they differ. **One item is blocked: the sandbox Checkout
flow.**

| Item | Result |
|---|---|
| All 19 backend e2e files together, fresh | **19 files, 229/229 passed**, one combined run (`evidence/trial-step-7/e2e-combined.log`, exit 0) |
| Frontend suite, final run alone | **61 files, 875/875 passed; 0 worker-start failures; 0 assertion failures** |
| Frontend eslint `src` / isolated source typecheck | exit 0 / exit 0 |
| Isolated production build (rebuilt after the fix) | exit 0, compiled, TypeScript passed, 62/62 pages (`next-build-closeout.log`) |
| Isolated browser, desktop + phone | **15/15** on the final run (`browser-run-closeout.jsonl`); two earlier attempts kept, see below |
| Sandbox Checkout → signed webhook → entitlement → UI unlock | **Blocked: not verified** (see below) |
| `D:\for-after-p7-buildcheck` | Inspected and confirmed temporary; **not deleted** (harness blocks it): please delete |

**Frontend failures, separated by kind (all runs this step):**
- **Worker-start failures** (Vitest "Failed to start forks worker … Timeout waiting for worker to respond"; the file
  never ran, so it is not an assertion result):
  - Run 1 (eslint running alongside): `people`, `announcements`, `account-settings`.
  - Run 3 (final pre-close-out run): the same three files. Re-run alone, they passed 108/108.
  - Final close-out run: **none**.
- **Assertion failures:**
  - Run 1 only: 5, all expected contract changes, since fixed:
    - `my-story-rich` and `story-inline-media`: the old unlink PUT;
    - `trial-expired`: the old autosave wording;
    - `memories`: the form now waits for the plan;
    - `trial-media` "Add a photo Pro": the known contention timeout from Step 5.
  - Then 16 in `people.test.tsx` from synchronous form queries, fixed by awaiting the form.
  - Final run: **none**.

**Tab-only recovery (sessionStorage), verified** (`src/components/shared/kept-draft.test.tsx`, 9 tests, and the
browser run):
- **Exact text:** spaces, blank lines, a tab, curly quotes, an em dash, an emoji and trailing spaces all survive. They
  are stored, restored into the editor, and shown by "View unsaved draft" byte for byte (unit and browser).
- **Account isolation:**
  - keys include the account id;
  - another account's copy is never offered or shown;
  - signing in as another account removes copies that aren't theirs.
- **Clearing events, each tested:**
  - sign-in as another account;
  - sign-out, through the real account-menu Log out in the browser;
  - session expiry (any 401 on a private request);
  - Discard, in the recovery notice and in the read-only view;
  - the explicit Save succeeding;
  - a successful server autosave;
  - a copy identical to the saved text.
  - Closing the tab is the browser's own sessionStorage behaviour, and the app says the copy "may disappear when you
    close the tab".
- **Never submitted automatically:** Restore fills the form and sends nothing. The browser run waits past the autosave
  delay and sees no answer request. Viewing sends no writes at all.
- **Bug found and fixed in this pass (browser only):** after a reload the copy was deleted before it could be offered.
  - The account id arrived before the server draft lookup finished. For that moment there was no offer and the form
    equalled the saved text, so the old rule ("the server holds the words when the form equals the saved text")
    removed the copy.
  - Fix (`src/hooks/use-draft-editor.ts`): the copy is removed only on real evidence (a successful autosave or the
    explicit Save), or at read time when it matches the saved text.
  - Regression test: it fails with the old rule and passes with the fix; both were run.
  - Browser attempt 1 (`browser-run-closeout-attempt1.jsonl`) shows the bug: 3 failures. Attempt 2 failed 1 check, on
    my own ambiguous selector (`attempt2`). The final attempt passed 15/15.

**"View unsaved draft" while read-only (new):** `KeptDraft` in `components/shared/draft-recovery.tsx`.
- Where it appears:
  - the My Wishes / My Story answer page;
  - the My Story workspace;
  - the message page, for an edit (that edit page is closed without a plan);
  - the Messages list, for a new message.
- What it shows: "Unsaved draft in this tab", labelled "Not saved to your account.", and says it is temporary and "may
  disappear when you close the tab".
- What it offers:
  - **View unsaved draft** (`aria-expanded`): the exact text, read-only;
  - **Discard**.
- What it never does: the answer stays read-only, and there is no Save or Restore. The workspace no longer offers
  Restore into a locked box, and stops autosave while read-only.
- Paid accounts get the normal recovery offer instead.
- The recovery notice's copy now also says the copy is temporary and may disappear when the tab closes.

**Sandbox Checkout: blocked.**
- What is missing:
  - The local backend `.env` has no `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY` or
    `STRIPE_PRICE_ANNUAL` (checked by name, values not printed).
  - The Stripe CLI (v1.55.11) is installed but not logged in (no test-mode key in its config), so `stripe listen`
    can't forward signed webhooks.
- What hasn't been shown: real Checkout → signed webhook → `BillingAccount` entitlement → UI unlock. The earlier upgrade
  checks inserted a subscription row, which is a simulation and **not checkout evidence**.
- To unblock:
  - put sandbox keys and price ids in the local `.env` (or a separate isolated env);
  - run `stripe login`;
  - run `stripe listen --forward-to localhost:<api>/api/v1/webhooks/stripe` and use its `whsec_` as the webhook
    secret;
  - then run Checkout with a test card against the isolated stack.

**Build-copy inspection (`D:\for-after-p7-buildcheck`):**
- No links or junctions remain. The temporary `node_modules` junction was removed after each build with
  `rmdir`, which removes only the link; the repo's real `node_modules` is intact.
- No files exist that aren't also in the repo (compared with literal paths and SHA-256).
- Differences from the repo:
  - my two intended build edits (`.env.local` with the isolated API URL, and `turbopack.root` in `next.config.ts`);
  - the build-generated `next-env.d.ts`;
  - `docs/tasks.md`, which I edited in the repo after copying.
- It is safe to delete. The harness refuses recursive removal at a drive-root path, and I did not work around that.

**Other close-out notes:**
- Leftover servers from my first browser run were still holding :3001/:4001; their command lines were confirmed as
  mine before they were stopped.
- After the runs: :3001 and :4001 are stopped, and there are **0 synthetic users** (`browser.s7.%`, `trialstep7.%`) in
  `for_after_p24`.

## Completion status

- All five policy decisions are **approved** and recorded in `billing.md` §8 Step 7.
- Backend: the Memory Vault trial cap, `memoriesSaved`, and a removal-only unlink route. Unscheduling and resends already
  behaved as approved, so they are now tested, not changed.
- Frontend: the Memory Vault counter and Pro, one shared create gate for the three `/new` pages, unlink after expiry, the
  tab-only copy of refused autosaves, one "Check plan again" inside the shell, and the locked "Unschedule" label.
- Verified with unit tests, isolated e2e, a production build in an isolated copy, and isolated browser runs at desktop
  and phone widths.

## What changed and key files

**Backend**
- `src/billing/billing-access.ts`:
  - `TRIAL_MEMORIES = 1`. `creationCaps()` now includes `memories`, but only for an enforced `trial_active`.
  - New `TRIAL_MEMORY_LIMIT` message.
- `src/memory-vault/memory-vault.service.ts`: `create` works like recipients:
  - with billing on, it locks the User row (`FOR UPDATE`), reads `trialCap(…, 'memories')`, counts live memories, and
    refuses with 409 `TRIAL_LIMIT` before any row is written;
  - with billing off, it takes no lock;
  - `update` is unchanged, so editing never needs a slot.
  - Audit result: this is the only path that creates a memory. There is no copy or restore; conversions create
    messages; uploads attach to an existing memory, and media stays paid-only.
- `src/billing/billing.service.ts`: `GET /billing` adds `memoriesSaved`, the live count.
- `src/my-story/*`: new `DELETE /my-story/prompts/:promptKey/response/memories` (`RemoveMemoryLinksDto`, `unlinkMemories`).
  - The body takes ids only, and any other field is a 400.
  - Every id must already be linked to that live answer, else 400.
  - It runs in one transaction and refuses to leave the answer empty.
  - It removes link rows only and records activity `STORY_RESPONSE_UPDATED`.
  - The interceptor never gates DELETE; `PUT …/response` stays gated.
- Tests:
  - new `test/trial-step7.e2e-spec.ts` (12 tests);
  - a new unit block in `memory-vault.service.spec.ts` (7 tests);
  - updated expectations in `billing-access.spec.ts` and `trial-people.e2e-spec.ts`;
  - `trial-media.e2e-spec.ts` and `trial-questions.e2e-spec.ts` now expect the cap. Their trial account already held a
    seeded memory, and they then created a second one.

**Frontend**
- `components/shared/trial-cap.tsx`:
  - `TRIAL_CAP_COPY.memories` and `TrialMemories`;
  - `useCreateGate` and `CreateGateNotice` replace `useLockedAtOpen`;
  - `ShellShowsPlanCheck` stops a page from repeating the shell's retry.
- `components/memory-vault/memories.tsx`: counter, Pro "Save a memory" (list and empty state), and the gated
  `NewMemory`.
- `components/people/recipients.tsx` and `trusted-contacts.tsx` use the shared gate. The two-contact maximum page is
  unchanged.
- `components/prompts/prompts.tsx`, `story-workspace.tsx`, `hooks/use-vault.ts` (`useUnlinkMemory`) and
  `lib/api/prompts.ts`: Unlink is always available and uses the new route.
- New `lib/local-drafts.ts`; changes to `hooks/use-draft-editor.ts`, `components/shared/draft-recovery.tsx` and
  `lib/query/query-client.ts` (`resetPrivateCache` clears copies). These add the tab-only copy of a refused autosave.
- `components/layout/dashboard-shell.tsx`: provides `ShellShowsPlanCheck`.
- `components/messages/schedule-panel.tsx`: "Unschedule" when locked.
- Tests:
  - new `components/shared/trial-step7.test.tsx` (13 tests);
  - updated `people.test.tsx`: forms wait for the plan, and the SSR test seeds it;
  - updated `memories.test.tsx`, `my-story-rich.test.tsx`, `story-inline-media.test.tsx` (unlink contract) and
    `trial-expired.test.tsx` (autosave copy).

## Fresh test results (after the last code change unless stated)

- **Backend `tsc`:** exit 0.
- **Backend oxlint (`--type-aware src/ test/`):** 0 errors. One warning was mine, an unused import in the new e2e; I fixed
  it. The rest are the pre-existing `ip-blocks` warnings.
- **Backend unit, full suite:** 76 files, **1606 passed, 0 failed**.
- **Backend isolated e2e** (DB `for_after_p24`, Redis :6390, fake ImageKit, scanner, email and SMS, Stripe
  unconfigured), 19 files:
  - Files: `trial-step7`, `trial-expired`, `trial-questions`, `trial-media`, `trial-people`, `trial-storage`, `billing`,
    `my-story`, `my-story-rich`, `my-wishes`, `my-wishes-rich`, `memory-to-message`, `messages`, `message-schedules`,
    `media`, `recipients`, `trusted-contacts`, `memory-vault`, `draft-recovery`.
  - Combined run: 227 passed and 2 failed. The two failures were the Step 4/5 tests described above. After updating
    them to the approved cap, those two files passed 23/23 on their own.
  - The other 17 files were not re-run after that test-only edit; no application code changed in between.
  - `trial-step7` passed 12/12. Its first run had 2 failures from my own test mistakes, a wrong wish key and contact
    creation already sending an invitation; both were fixed.
- **Frontend unit/component, full suite:** **60 files, 866 passed, 0 failed**, from two runs:
  - Final full run: 57 files, 758/758. Vitest couldn't start workers for three files ("Timeout waiting for worker to
    respond", machine load): `people`, `account-settings` and `announcements`.
  - Those three re-run alone: 108/108.
  - An earlier full run, before the unschedule test and label change, passed 60 files, 866/866.
  - The run before that was contended (eslint running alongside): 3 workers failed to start, plus the expected
    contract failures, all fixed since.
- **Frontend eslint (`src`):** exit 0.
- **Frontend typechecks:**
  - Isolated source-only check (`src`, root configs, `e2e` and the last build's route types; excludes `.next/dev`):
    exit 0.
  - The normal `tsc --noEmit` was not run. It is blocked by the dev server's generated `.next/dev/types`, as in Steps
    5–6.
- **Isolated production `next build`** (Next.js 16.3.7, Turbopack): exit 0. It compiled, the TypeScript step passed, and
  62/62 pages were generated.
  - Built in the copy `D:\for-after-p7-buildcheck`, with `node_modules` as a junction and `turbopack.root` set in the
    copy only.
  - Log: `evidence/trial-step-7/next-build.log`.
- **Isolated browser, desktop 1280×900 and phone 390×844: 12/12 passed on the first run**
  (`evidence/trial-step-7/browser-run.jsonl`, script `step7.browser.mjs`, fixtures `browser-seed.mjs`).
  - Stack: `next start` :3001 on that build, and `node dist/main` :4001 through the isolated wrapper. Email was
    disabled; Twilio, Stripe and Observe were blank.
  - Accounts: 5 synthetic accounts, deleted afterwards (`{"deleted":5}`).
  - Checks:
    - Counter, Pro, dialog via keyboard, Escape and focus return, with no expired banner during an active trial (both
      widths).
    - Direct `/memory-vault/new` at the cap (both widths).
    - Editing the trial memory.
    - First memory saved through the UI, then 1 of 1 and Pro.
    - Expired account: unlink at both widths.
    - Expired account: "Unschedule" works, and Change timing opens the dialog.
    - Trial ends mid-typing: "Not saved to your account." and one tab copy. After an upgrade and a reload, the copy is
      offered and Restore sends no save.
    - Log out removes the copy.
    - Paid account: no counter.
  - Note: the first unlink check's name says "text stays read-only", but it only asserted the banner, the remaining link
    and the memory still in the vault.

## What customers see

- During a free trial you can keep **one written memory** in your Memory Vault, alongside your four questions. The vault
  shows "1 of 1 trial memory used". "Save a memory" then shows **Pro** and explains that a plan is needed. You can still
  open, edit and delete your memory, and deleting it lets you save a new one.
- Once the trial ends you can still **unlink** memories from a My Story answer. Nothing else in the answer changes, and
  the memory and its files stay. You can also **unschedule** a message so it won't be sent. Scheduling again, and
  resending a trusted-contact invitation, need a plan.
- If the trial ends while you are typing, the page says **"Not saved to your account."** This browser tab keeps a
  temporary copy until you close it or sign out. When you can edit again, the app offers the copy back. It is never
  saved for you: you still press Save.
- "Add someone", "Add a trusted contact" and "Save a memory" pages wait for the plan to be read ("Checking your plan…")
  instead of opening a form the plan may not allow. If the plan can't be read, there is one "Check plan again" at the
  top.
- Paid, billing-off and grandfathered accounts see no trial counters or Pro marks.

## Failed, blocked and not-run checks

- **Failed, then fixed:**
  - the two Step 4/5 e2e tests above;
  - frontend tests that relied on the old unlink PUT, the old autosave wording, or a form appearing before the plan was
    read;
  - two mistakes in my own new e2e.
- **Blocked:**
  - The normal frontend `tsc` is blocked by `.next/dev/types`; the isolated check stands in for it.
  - Deleting `D:\for-after-p7-buildcheck`: the harness refused recursive removal at that drive-root path. I removed
    only its `node_modules` junction, and the real `node_modules` is intact. **Please delete the folder yourself.**
- **Not run:**
  - the repo's own Playwright suite (it targets :3000/:4000 and the real development ImageKit);
  - real downloads and uploads;
  - any Stripe checkout;
  - a real upgrade (simulated by inserting a subscription row);
  - screen-reader testing;
  - the 17 other e2e files after the test-only edit (see above);
  - Step 8's full validation, which is out of scope.

## Remaining issues and manual checklist

- ~~A tab copy is not shown on the read-only view.~~ Resolved in the close-out: "View unsaved draft" (read-only) and
  Discard.
- No browser-local draft layer existed before this step. "Existing local draft recovery" in the brief was taken to mean
  the existing server recovery flow, which the new tab copy reuses.
- The Memory Vault count includes every live memory, including any excess from earlier. That matches "block additional
  creation".
- Manual checklist (staging or local, billing on):
  1. In a trial, save one memory, see "1 of 1", then confirm Pro and the dialog. Delete it and save another.
  2. Open `/memory-vault/new` directly while at the cap.
  3. Expired account: unlink a memory, unschedule a message, and confirm Change timing and Resend invitation offer
     plans.
  4. End the trial while typing, reload, upgrade in Stripe test mode, reopen the answer, Restore, then Save.
  5. Log out and confirm nothing is offered for the next person.
  6. Phone width: counter, Pro button, dialogs and notices fit with no sideways scroll.
  7. Paid account: no counters.

# Updated Plans Step 4: media capabilities by tier (2026-11-16)

**Status: complete (local).** Tiers are synthetic in every test (set directly on `BillingAccount.tier`). Nothing assigns
a tier from Stripe yet, so no real account has these limits.

Nothing was staged, committed, pushed or deployed. No billing settings, customer data, Stripe objects or live providers
were touched. Evidence: [`evidence/updated-plans-step-4/`](evidence/updated-plans-step-4/). Policy:
[`billing.md`](billing.md) §9 Step 4.

## What changed

**Backend**
- `src/billing/billing-access.ts`:
  - `allowedMediaKinds()`: none for a trial; the definition's kinds for an entitled mapped tier; all kinds otherwise.
  - `TIER_REQUIRED` / `videoRequiresCompleteError()`.
  - `PLAN_IN_EFFECT.PREMIUM` includes `contentMedia`.
- `src/billing/paid-features.service.ts`: `mediaRefusal / mediaAllowed / assertMedia(owner, needed, tx?)`, where
  `needed` is the kinds added, or `'any'`.
- Call sites:
  - upload start and upload completion in `media`, `memory-vault-media`, `my-story-media` and `my-wishes-media`;
  - `messages.service` (create, edit);
  - `message-versions.service` (restore);
  - `message-snapshot.service` (conversions).
- `formatMediaKinds()` in `message-versions.ts`: VIDEO needs video, PHOTO and AUDIO need their kind, MIXED needs some
  media and never implies video.
- `GET /billing` adds `features.mediaKinds`.

**Frontend:** shared Complete badge, dialog and button; Premium video controls show "Complete"; refusals keep the
form. See `for-after-frontend/docs/tasks.md`.

## Protected write paths

| Path | Rule |
|---|---|
| Upload start (messages, My Story, My Wishes) | declared kind, before reservation, row or signed upload |
| Upload completion | the row's kind, at the moment it would become READY (the declared MIME is verified against the file's signature) |
| Message create | by format (VIDEO needs video; MIXED is 'any') |
| Message edit / version restore | only a switch to a format the message doesn't have; versions carry no files |
| Conversions into messages | every copied file's stored kind plus the format's |

Existing behaviour that already covered the rest:
- The Memory Vault never accepts video, for any plan (validation plus a database constraint).
- Recipient photos and death-verification evidence are not content media.

## Existing video and mid-upload downgrade

- Existing videos stay listed, viewable, downloadable and removable.
- Text edits that keep a VIDEO format and its video are allowed, and so is VIDEO → MIXED (the same file is kept).
- Upload, replacement, copying and switching to VIDEO are refused on Premium.
- **A video reserved under Complete and completed under Premium:**
  - refused with `TIER_REQUIRED`;
  - the pending row is soft-deleted, so its reservation is released once and the file is purged by `MediaCleanup`;
  - it is never scanned or made READY;
  - a repeat call returns 404 and changes nothing;
  - pre-existing media is untouched.
- An allowed photo completes once, with no second charge.
- If access ends mid-upload, completion is refused at the gate (402) and the row stays pending for the existing
  cleanup.

**Memory links:** a memory can't hold video, and a link exposes only the memory's id, title and category. The answer
and the book read none of its files, and conversion accepts only the answer's own files. Both points are tested.

## Fresh results

**Backend**
- `tsc`: exit 0. oxlint: exit 0, 0 errors; only the pre-existing `ip-blocks` warning.
- Unit tests: **77 files, 1631/1631.** This run came after the final application-code change.

**Isolated e2e, one combined run** (`e2e-combined.log`):
- **24 files, 290 passed, 0 failed, 0 skipped, exit 0; no worker-start failures.**
- Started at 15:32:20, after the last application change (15:20) and the corrected assertions (15:31:57). No other
  backend file changed in between.
- Files:
  - `plan-media`, `plan-tiers`, `plan-limits`, `billing`;
  - the six `trial-*` files;
  - `storage-quota`, `storage-manager`, `recipients`, `trusted-contacts`, `memory-vault`, `admin`;
  - `media`, `memory-to-message`, `my-story`, `my-story-rich`, `my-wishes`, `my-wishes-rich`, `messages`,
    `message-schedules`.

**Combined run before that (`e2e-combined-attempt1.log`):** 3 assertion failures and no infrastructure failures, all
from exact `toEqual` checks of `/billing` `features` in `trial-media` (2) and `trial-questions` (1), which broke on the
additive `mediaKinds`.
- Fixed by asserting the exact intended value: trial `[]`, paid and grandfathered `['PHOTO','AUDIO','VIDEO']`. Still
  exact `toEqual`, not loosened.

**Close-out coverage addition (test only):** My Story and My Wishes completion after a downgrade. Run as
`plan-media` alone: **13/13** (`e2e-plan-media-closeout.log`). No application code changed after the combined run.

**Frontend**
- Relevant folders (shared, media, messages, memory-vault, prompts, people): **21 files, 329/329**, no worker-start
  failures.
- eslint on the changed files: exit 0. Isolated source typecheck: exit 0.

**Isolated production build** (Next.js 16.3.7, Turbopack): exit 0, 62/62 pages (`next-build.log`). Built in the
temporary copy `D:\for-after-p7-buildcheck` with a temporary `node_modules` junction, removed afterwards.

**Isolated browser**: **13/13** on the final run (`browser-run.jsonl`; script `media.browser.mjs`, fixtures
`browser-seed.mjs`).
- **Stack:**
  - `next start` on :3001;
  - `node dist/main` on :4001 through the isolated wrapper. `dist` was confirmed to contain the Step 4 code.
  - Test database and Redis; email disabled; Stripe, Twilio and Observe blank.
- **Checks, at desktop and phone width unless marked:**
  - Premium photo and audio controls normal; "Add a video" and "Record a video" show Complete; the dialog opens from
    the keyboard, Escape closes it and focus returns (both).
  - The new-message Video format shows Complete and the typed title is kept (both).
  - Story → message offers the photo and shows "Copy this video" Complete for the video (both).
  - The workspace "Add a video" shows Complete (desktop).
  - Editing a VIDEO message's title keeps its video (desktop).
  - The existing video can be removed (desktop).
  - A direct API request is refused with `TIER_REQUIRED` (desktop).
  - Complete keeps the normal video controls (phone).
  - A server refusal after a mid-session plan change shows the message and View plans and keeps the typed title
    (phone).
  - The trial still shows Pro (phone).
  - No horizontal overflow at phone width.
- **Attempt 1 (`browser-run-attempt1.jsonl`): 12/13.** The failure was a bug in my fixture helper (the `tier` command
  read the wrong argument), not the app. Fixed, and the whole script was re-run on fresh fixtures.
- **Cleanup:** fixtures deleted, with 0 synthetic users left in `for_after_p24`. My servers (:3001, :4001 and the
  orphaned API child) were stopped. The dev API, worker and `next dev` were left running and untouched.

## Failed, blocked, skipped and not run

- **Failed, then fixed:** the 3 e2e assertions and the browser fixture helper (both above).
- **Skipped:** none.
- **Not run:**
  - the full frontend suite (only the relevant folders ran, because of low memory);
  - the repo's Playwright suite;
  - real uploads to ImageKit;
  - any Stripe flow.
- **Development database:** `prisma migrate status` reports up to date (checked read-only).
- `D:\for-after-p7-buildcheck` still exists. It was confirmed temporary earlier, and its junction is removed. The
  harness won't let me delete it.

## Remaining gaps

- No real account gets a tier until Stripe mapping is built and the legacy-mapping decision is made.
- AI allowances and support priority are not built (later steps).

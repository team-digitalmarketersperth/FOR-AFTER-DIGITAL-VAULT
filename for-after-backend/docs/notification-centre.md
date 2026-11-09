# Notification centre — operator runbook

> **Status (2026-11-04):** the owner's policy is implemented (optional product news: consent, unsubscribe,
> suppression, death-report exclusion) with a **pilot audience**. One owner-approved **local pilot run** (1 recipient)
> was accepted by Microsoft Graph on 2026-11-04 (§14); the gate was removed afterwards, so **customer broadcasting is
> disabled** again. No all-eligible broadcast has ever been sent. Progress log: [`task.md`](task.md).

## 1. What it does

Super admins write an email announcement, preview it, send themselves a test, review the audience, and (once allowed)
queue it to eligible Customers. Admin UI: **Operations → Notification centre** (`/admin/announcements`), a four-step
wizard: Write → Preview & test → Audience → Review & send, then a "Customer send" progress card.

| Piece | Where |
| --- | --- |
| API (all routes) | `src/announcements/announcements.controller.ts` — `admin/announcements/*` |
| Drafts, preview, test requests | `announcements.service.ts` |
| Audience counts + communication policy | `announcement-audience.service.ts` (`POLICY_BLOCKERS`, `AnnouncementPolicy`) |
| Review, confirm, progress, stop | `announcement-broadcast.service.ts` |
| Worker: test emails | `announcement-test.processor.ts` (queue `announcement-test-email`) |
| Worker: broadcasts | `announcement-broadcast.processor.ts` (queue `announcement-broadcast`) |
| Consent, unsubscribe, suppression | `src/communications/` (`/users/me/communication-preferences`, `POST /communications/unsubscribe`) |
| Tables | `EmailAnnouncement`, `AnnouncementTestSend`, `AnnouncementSendRun`, `AnnouncementRunRecipient`, `AnnouncementPilotMember`, `EmailSuppression`; `User.marketingConsentAt` |
| Renderer | `announcement()` in `src/email/email-templates.ts` (escaped plain text, allowlisted button) |

## 2. Access

Every route: signed-in **SUPER_ADMIN**, account ACTIVE, admin two-factor completed in this session
(`SessionAuthGuard` + `AdminGuard` + `SuperAdminGuard`; role and status re-read on every request). Customers,
Recipients, Trusted Contacts, ordinary admins, password-only admin sessions, signed-out, demoted or suspended admins
all get 401/403 (verified in `test/announcement-workflow.e2e-spec.ts`). Global Origin check on writes, `Cache-Control:
no-store`, strict DTOs (unknown fields → 400). Per-IP limits: writes 30/min, preview 60/min, test 10/min (plus 3 per
admin / 20 shared per 10 min), audience and send review 20/min, confirm 5/min, stop 10/min.

No route accepts a recipient. Test emails go only to the requesting admin's own verified address (server-side).

## 3. Feature gate

`ANNOUNCEMENT_BROADCAST_ENABLED` (API **and** worker; restart both after changing it):

| Value | Effect |
| --- | --- |
| unset / anything else (default) | **off**: no review token, confirmation refused, the worker stops any run (BLOCKED) |
| `pilot` | only **pilot-group** sends; an all-eligible draft gets "only pilot sends"; an all-eligible run is stopped |
| `true` | pilot and all-eligible sends |

Read on every review, confirmation and before every send. Turning it off mid-run ends the run **BLOCKED**
(`broadcast_disabled`, remaining recipients SKIPPED) — it does **not** pause it; a stopped run is final (a new
announcement is needed). It is not set in any environment file.

## 4. Communication policy (owner decision, 2026-11-03)

Announcements are **optional product news**, never essential service email: they need the Customer's **marketing
consent**, carry an **unsubscribe link**, and are never sent to suppressed addresses or to Customers with an open,
unverified death report. Account, sign-in, security and release emails are separate code paths and are not affected.
`POLICY_BLOCKERS` is empty because each rule is implemented; the policy version is `optional-consent-v1-2026-11-03`
(runs confirmed under another version stop as BLOCKED).

- **Consent:** `User.marketingConsentAt`, null by default (registration never grants it). Only the Customer sets it:
  Account settings → Email preferences → "Product news and updates from For After". Grant/withdraw audited
  (`MARKETING_CONSENT_GRANTED/_WITHDRAWN`, source + wording version `product-news-v1`).
- **Unsubscribe:** every announcement email (HTML and text) ends with "You're receiving this because you chose to hear
  news from For After. Unsubscribe" — a per-recipient signed link (account + hash of the address it was sent to; key
  derived from `SESSION_SECRET`, so rotating that secret invalidates old links). The `/unsubscribe` page only acts on its
  button (mail scanners opening links change nothing); the API withdraws consent and suppresses that address,
  idempotently. Graph cannot set a `List-Unsubscribe` header (custom headers must start with `x-`).
- **Suppression list** (`EmailSuppression`, keyed by sha256 of the lower-cased address; no address stored): reasons
  UNSUBSCRIBED (unsubscribe link), HARD_BOUNCE (a provider "invalid recipient" failure during a send), COMPLAINT
  (reason exists; **no automatic source** — Microsoft gives this app no complaint feedback loop). A stronger reason
  replaces a weaker one. Opting in again lifts only the Customer's own UNSUBSCRIBED row.
- **Death reports:** Customers with an open, unverified death report are excluded until it is resolved.

## 5. Eligibility and audience

Customers only. One primary reason each, in this order (`reasonSql`, used by review counts, pilot status and run
preparation, mirrored by `skipReason` before every send): account unavailable → email missing/invalid → email not
verified → open death report → suppressed → no consent → eligible. Billing state is **not** a rule. Recipients and
Trusted Contacts are never in the audience.

**Audience scope** (per draft, default **Pilot group**): the super admin adds up to **10** existing Customer accounts by
exact address in the Audience step (each shows its status); or **All eligible customers**. The review token binds the
scope and the exact pilot member set; a change means "review again". A pilot run is **prepared at confirmation** (the
eligible members at that moment, frozen; the pilot group then cannot change). All-eligible runs are prepared by the
worker in keyset batches of 500 for Customers created up to the confirmation time. **Before every send** the account is
checked again; a changed address, withdrawn consent, new suppression or death report → SKIPPED with that reason, never
redirected.

## 6. Workflow and states

1. Review and send (`POST …/broadcast-review`): fresh counts, blockers, the exact email; a signed review token valid
   **10 minutes**, bound to admin, announcement, saved version, eligible count and policy version.
2. Queue announcement (`POST …/broadcasts`, explicit checkbox in the UI): re-checks everything; refuses a different
   version, an expired/forged token, a larger (or >10 % smaller) audience, a second run for the same announcement,
   or another active run. Same `clientOperationId` → same run.
3. Worker: PREPARING → SENDING → COMPLETED | CANCELLED | BLOCKED.

Recipient states: QUEUED, PROCESSING, **ACCEPTED (accepted by the email provider — not "delivered")**, FAILED,
UNKNOWN (may have been accepted), SKIPPED, CANCELLED (before any attempt). COMPLETED means processing finished, not
that every Customer received the email. There is no open/read tracking.

## 7. Retries and unknown outcomes

| Provider result | Outcome |
| --- | --- |
| 202 accepted | ACCEPTED (+ Graph request id as `providerMessageId`) |
| Permanent (400, 403, 404, …) | FAILED after one attempt |
| Timeout, network error, 5xx | **UNKNOWN** — Graph may have accepted it and has no idempotency key; never retried automatically |
| 429 throttling / 401 / token unavailable (provably not accepted) | back to QUEUED with backoff (Retry-After, else 30 s × 2ⁿ), max 3 attempts, then FAILED. A 429 pauses the whole run until Retry-After |
| Worker died after claiming a recipient | next lease holder marks it **UNKNOWN** (`worker_interrupted`), never resent |
| Database error before the provider call | recipient returned to QUEUED (not an attempt); the run resumes after the lease |

There is no manual resend or "retry unknown" tool. Check an UNKNOWN outcome with Microsoft using the request id if
needed; do not resend blindly.

## 8. Recovery

- **Queue publication fails** after the run is committed: the run stays PREPARING with no lease; the worker reconciler
  (every `EMAIL_RECONCILE_INTERVAL_SECONDS`) re-queues active runs whose lease has lapsed. No second run is created.
- **Worker stops** (crash or shutdown): graceful shutdown finishes and records the in-flight email; the lease (2 min)
  lapses and the reconciler resumes. Preparation resumes from the stored cursor (no duplicates; unique per run+user).
- **Redis down**: nothing is lost (PostgreSQL is the source of truth); runs resume when Redis and the worker are back.
- **Paused**: the progress card says "Paused until …" (throttling or the daily limit). Sending resumes on its own.

## 9. Stopping a run

"Stop sending" (`POST …/broadcasts/:runId/cancel`): no new preparation, never-attempted recipients → CANCELLED, no new
provider attempt. An email already handed to Microsoft keeps its real outcome; **accepted emails cannot be recalled**.
Repeated stops are no-ops (one audit row); a finished run returns 409. History is never deleted.

## 10. Throughput

One email at a time (global: one active run, one driver per run). Spacing = 60 s / `ANNOUNCEMENT_BROADCAST_RATE_PER_MINUTE`
(default **10**, max 30). `ANNOUNCEMENT_BROADCAST_DAILY_LIMIT` attempts per rolling 24 h (default **2000**, max
10,000); reaching it pauses 15 min at a time. Exchange Online allows a mailbox 30 messages/min and 10,000 recipients/day
in total, shared with OTPs, invitations and release emails, which use other code paths and are never queued behind
broadcasts. A local run of 200 fictional Customers with the fake provider (2026-11-03) prepared in ~0.15 s and sent
one at a time; at the default rate that is ~20 minutes. This is not a production capacity figure.

## 11. Troubleshooting (safe metadata only)

| Symptom | Look at |
| --- | --- |
| Run stuck in "Preparing audience" | progress `lastUpdatedAt`; worker logs `announcement_broadcast_*`; Admin → System health (worker heartbeat). The card warns after 5 min without progress |
| Queue publication failure | API log `announcement_broadcast_queue_add_failed run <id>`; reconciler log `announcement_broadcast_reconciled` |
| Worker unavailable | Admin → System health; the card's "No progress … check System health" note |
| Provider throttling | card "Paused until …" and "Waiting to send: Email provider throttling (n)"; worker log `email_send_failed … rate_limit_exceeded, retry-after` |
| Permanent failures | card "Failed: <code> (n)"; Graph code only |
| Unknown outcomes | card "Outcome unknown: <code> (n)"; `providerMessageId`/client request id in logs for Microsoft support |
| Daily limit reached | worker log `announcement_broadcast_daily_limit`; card "Paused until …" |
| Cancelled work | card "Stopped"; audit `ANNOUNCEMENT_BROADCAST_CANCEL_REQUESTED` / `_FINISHED` |

Audit events (`AuditLog`, ids/counts/codes only): `ANNOUNCEMENT_DRAFT_CREATED/_UPDATED`, `ANNOUNCEMENT_TEST_REQUESTED/
_COMPLETED`, `ANNOUNCEMENT_AUDIENCE_REVIEWED`, `ANNOUNCEMENT_BROADCAST_REQUESTED/_QUEUED/_CANCEL_REQUESTED/_FINISHED`.
Logs never contain subjects, bodies, review tokens or customer addresses (test email logs mask the admin's address).
The broadcast queue is not shown in Admin → Queues or dead letters (state lives in the run tables).

## 12. Known limitations

- No automatic complaint ingestion and no asynchronous bounce processing (only synchronous "invalid recipient"
  failures become HARD_BOUNCE); required before a wide all-eligible rollout.
- No recent-two-factor step-up for confirmation (the existing admin MFA session is required).
- No manual review/retry of UNKNOWN outcomes; no resend (a new announcement is needed to send again).
- No dedicated preview-text (preheader) field: inboxes show the message's opening line.
- Live Microsoft Graph delivery of a **customer** announcement has never been tested; production credentials and
  SPF/DKIM/DMARC are open ([`email-production-setup.md`](email-production-setup.md)).

## 13. Future controlled live smoke test (checklist only — not executed)

- [ ] Written authorization from the product owner for this specific test, naming the date and the people involved.
- [ ] Policy blockers resolved and implemented, or explicitly waived **for this staging test only** in code review.
- [ ] Non-production environment (staging) with its own database; never production.
- [ ] Only controlled test Customer accounts whose inboxes the team owns (1–3); verify no other Customer is eligible
      (audience review count must equal the test accounts).
- [ ] `EMAIL_PROVIDER=microsoft` with the approved sender; SPF/DKIM/DMARC checked for the sending domain.
- [ ] Send a test email first; confirm subject, content, button link and footer.
- [ ] Set `ANNOUNCEMENT_BROADCAST_ENABLED=true` and `ANNOUNCEMENT_BROADCAST_RATE_PER_MINUTE=2` on API **and** worker;
      restart both.
- [ ] Review and send: confirm the exact subject, content and recipient count, then queue.
- [ ] Record provider acceptance (progress "Accepted by email provider", request ids) **separately** from inbox receipt
      (check each inbox and spam folder by hand).
- [ ] Exercise "Stop sending" on a second small run.
- [ ] Set `ANNOUNCEMENT_BROADCAST_ENABLED` back to empty and restart both processes; confirm a new review shows
      "Customer broadcasting is turned off on this server".
- [ ] Record results in `task.md` (live delivery verified only for what was actually observed).

## 14. Live test log

| Date | Scope | Status |
| --- | --- | --- |
| 2026-11-03 | One test email (Step 6) from local development to the signed-in super admin | **Not executed.** Prerequisites checked (worker, queues, Graph config present, broadcasting off). Blocked: the only SUPER_ADMIN account's email is unverified, so `POST …/test-sends` returns 409. Provider acceptance and inbox receipt: none |

| 2026-11-03 10:30 UTC | One test email (Step 6), local development, draft `7cdde7c1…` v2, to the signed-in super admin | **Accepted by Microsoft Graph** (10:30:33; request id stored). Inbox receipt: **confirmed by the user** (2026-11-03 10:35 UTC) |
| 2026-11-03 10:32 UTC | First customer announcement (Step 7) | **Not executed.** Blocked by the five policy blockers (§4), no real content, all-eligible-only audience; gate off; 0 runs |
| 2026-11-04 06:31 UTC | Test email of the approved pilot content, draft `4a119432…` v1, to the super admin | **Accepted by Microsoft Graph** (06:31:43). Inbox receipt and formatting: **confirmed by the user** (2026-11-04) |
| 2026-11-04 06:59 UTC | **First pilot announcement** (owner-approved, local development): draft `4a119432…` v1 "A warm welcome from For After", no button; run `fd0837f0-9879-4281-97ca-ea9de78344c6`, audience PILOT, 1 recipient (pilot group of one opted-in Customer) | **Provider outcome:** run COMPLETED 06:59:45 (created 06:59:37); recipient ACCEPTED by Microsoft Graph (1 attempt, provider message id stored; 202 = accepted, not proof of delivery); 0 skipped, 0 failed, 0 unknown. Audit: REQUESTED, QUEUED, FINISHED (1 each). Gate `ANNOUNCEMENT_BROADCAST_ENABLED=pilot` set for this run only and removed after it finished. **Inbox receipt:** awaiting the owner's confirmation |

Planned test (awaiting a verified owned inbox and explicit approval): draft "Notification Centre controlled test",
subject "Notification Centre connection check" (sent as "[TEST] Notification Centre connection check"), the fictional
three-paragraph message, no button, one test operation, from "For After <info@forafter.com.au>".

# Phase 24 — Critical security test matrix

> Every case in [`PROJECT_OVERVIEW.md` §50](../PROJECT_OVERVIEW.md#50-critical-security-test-cases), plus the
> Phase 24 review areas A–G, mapped to the test that proves it. Results are from the runs recorded in
> [`phase-24-results.md`](phase-24-results.md) (2026-10-21, local, isolated test PostgreSQL + Redis).

|                    |                                                                                                    |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| **Scope**          | Local verification only. Staging and production were not tested.                                   |
| **Environment**    | `for_after_p24` (PostgreSQL 18.6) + dedicated Redis 7.4.11 on `127.0.0.1:6390`, via `scripts/phase24/isolated-env.mjs` |
| **New tests**      | `test/security-critical.e2e-spec.ts` (13), one race test in `test/death-verification.e2e-spec.ts`, `scripts/phase24/imagekit-expired-url-check.mjs` (live provider check) |
| **Status codes**   | Each rejection asserts its exact contract (401 no/foreign session, 404 not yours or not released, 409 state conflict, 400 validation, 403 Origin, 429 limit), never "any 4xx" |

---

## 1. §50 cases

| # | §50 case | Tests (file › test) | Expected response and side effects | Result |
| --- | --- | --- | --- | --- |
| 1 | User attempts another user's message | `messages` › *isolates users: John gets a plain 404 for Lisa's message*; `message-composition` › *G — cross-user: John gets 404 everywhere; admins get 401*; `media` › *isolates users… message and media*, *John cannot delete Lisa's message or reach its media*; `message-schedules` › *isolates users…*; `message-versions` › *another Customer can't list, read or restore…*; `draft-recovery` › *another Customer can't read, overwrite or discard…*; `private-notes` › *…other Customer 404* | 404 (same as missing), nothing changed, nothing signed | ✅ pass |
| 2 | Recipient changes recipient ID | `recipient-portal` › *detail returns released text; draft, scheduled, other recipient, guessed → 404*, *another recipient → 404 and nothing signed*, *released, but another recipient → 404 and nothing signed*; **new** `security-critical` › *own released message + another message's media id → 404, nothing signed*, *a recipientId/email supplied by the client selects nothing: ignored on reads, refused on sign-in* | 404 on reads; 400 for identity fields in sign-in bodies (whitelist); `createAccessUrl` never called | ✅ pass |
| 3 | Trusted Contact tries to read unreleased media | **new** `security-critical` › *a Trusted Contact session opens no message, media or URL on any route (401), and nothing is signed*, *the Trusted Contact portal itself exposes no message or media data*, *the same person signed in as a Recipient sees only the released message (control)*; `account` › *Recipient and Trusted Contact sessions → 401* | 401 on every Recipient and owner route (released or not); TC portal bodies hold no message/media ids; no URL signed | ✅ pass |
| 4 | Expired signed URL reused | **new** `security-critical` › *access URLs are short-lived and re-authorised on every request; deletion stops new ones*; `imagekit-media-storage.service.spec` › *access: a signed, expiring URL of the private original*; **live** `scripts/phase24/imagekit-expired-url-check.mjs` | URL lifetime = `MEDIA_ACCESS_URL_TTL_SECONDS`; a new URL needs a new authorised request (404 once deleted). Real ImageKit: unsigned 403, valid 200, tampered `ik-t` 403, **reused after expiry 403** | ✅ pass |
| 5 | OTP brute-force attempt | **new** `security-critical` › *after 5 wrong codes the challenge is dead: the right code is refused and no session exists*, *one email gets at most 5 codes per window: the 6th request is 429 and sends nothing*; `recipient-portal` › *wrong code → 401 generic; … reuse → 401*, *too many requests for one email → 429*, SMS equivalents; `trusted-contact-portal` › same for Trusted Contacts; `recipient-auth.service.spec` › *after max attempts…*, *verification is rate-limited per IP*; `admin` › *5 wrong codes invalidate the challenge* | Production limits (5 attempts, 5 codes per 15 min per address, 20 requests / 30 verifies per IP): 401 without cookie, then the right code is still 401; 6th request 429, nothing sent | ✅ pass |
| 6 | Fake death report | `trusted-contact-portal` › report tests with `releaseState()` before/after; `death-verification` › *report starts the safeguard only after the safety notice is sent*, *admin cannot verify during the safeguard (409), no override exists*, *REJECTED: … A report alone: no PASSED, no release*; `death-confirmations` › A–D; `my-wishes-rich` › *safeguard and READY_FOR_REVIEW release nothing* | A report releases nothing and changes no account; safety notice first; safeguard; admin verification required; Customer can cancel | ✅ pass |
| 7 | Duplicate death approval | **new** `death-verification` › *two admins verifying at once: one VERIFIED, one 409; one activation, one release, one grant*; `death-verification` › *a verified case accepts no decisions or reports (409)*, *race: confirm-alive vs admin verify*; `admin` › *… PASSED cannot be reactivated*; `death-confirmations` › *verify racing the second report…* | Exactly one 200, the other 409; one `ADMIN_VERIFIED` audit event, one activation, one release, one grant, also after a later reconcile | ✅ pass |
| 8 | Stripe webhook replay | — | Not applicable: Stripe billing (phase 21) is not built; no webhook route exists | ⛔ N/A (blocked by phase 21) |
| 9 | BullMQ duplicate retry | `recipient-portal` › *re-running the release does not duplicate grants*; `email-delivery` › *releasing, enqueueing and reconciling again sends nothing new*, *re-running release, both reconcilers and the enqueue sends nothing new*; `dead-letters` › *admin retry → … releases once; a second retry is 409*, *admin retry reuses the notification row*; `worker-process` › *worker restart: state persists and nothing happens twice*; `recurring-schedules` › *Redis flushed: … without duplicates*; **load** `dup-cancel` and `recovery` profiles | One release, one grant per Recipient, one notification row per grant; see the crash-window caveat in §3 | ✅ pass |
| 10 | Upload URL reused by another user | **new** `security-critical` › *John's own upload cannot be completed with Lisa's uploaded file: 409, stays PENDING, never readable*; `media` › *complete needs a valid provider file id; one for another path → 409*, *isolates users…* (complete on Lisa's asset → 404); `imagekit-media-storage.service.spec` › *upload: a V2 JWT … fixing path*, *verify: the file must sit at exactly this key* | 409, asset stays `PENDING_UPLOAD` with no provider id, access-url 409, nothing signed; Lisa's asset untouched | ✅ pass |
| 11 | Deleted recipient attempts old access | `recipient-portal` › *a removed Recipient (no grant on the mobile) cannot sign in*, *editing or deleting the Recipient after release does not move or revoke access*, *a deleted message is no longer accessible*; `recurring-schedules` › *a Recipient deleted before their day gets no access and no future years*; `delivery-timeline` › *removed Recipients and deleted messages drop out* | Deleted before release: no grant, cannot sign in. Deleted **after** release: access kept by approved policy (grants are snapshots; revocation is post-MVP, `recipient-portal.md`) | ✅ pass (policy as approved) |
| 12 | Unauthorized admin action | `admin` › *the password alone gives a challenge, no session*, *Customer: 401 on admin APIs*, *Trusted Contact session: 401 on admin APIs and MFA routes*, *unauthenticated: 401 everywhere*, *role safety: …*, *rows are append-only*; `dead-letters` › *only admins: …*; `death-verification` › *authorization: Customer, Trusted Contact and no session all 401* | 401 without a full (password + TOTP) admin session; role rules 403/409; audit rows immutable | ✅ pass |

---

## 2. Review areas A–G

| Area | Requirement | Tests | Result / note |
| --- | --- | --- | --- |
| A | Customer isolation across recipients, messages, schedules, memories, story, wishes, media | `recipients`, `messages`, `message-schedules`, `memory-vault` (×2), `my-story`, `my-wishes`, `my-story-rich`, `my-wishes-rich`, `media`, `storage-manager` (×2), `recurring-schedules`, `delivery-timeline`, `trusted-contacts` isolation tests | ✅ 404 everywhere, no writes |
| A | ID / ownership-field tampering | `messages` › *refuses another customer's recipient with a generic 400 and writes nothing*; `death-confirmations` › *a report cannot carry requiredConfirmations or other injected fields*; `trusted-contact-portal` › *400 for … injected fields*; global `ValidationPipe({ whitelist, forbidNonWhitelisted })` | ✅ |
| B | Only granted, released content; media authorised server-side | §50 rows 2, 3, 11; `recipient-portal` media tests (*unreleased (SCHEDULED): the intended recipient gets 404 and nothing is signed*) | ✅ |
| C | Trusted Contacts: no content, no customer/admin functions; removal ends access; a report is not a verification | §50 rows 3, 6; `trusted-contact-portal` › *removing the contact ends access at once, whatever the sign-in method*, *a deleted relationship is excluded and cannot sign in*; `admin` › TC 401 | ✅ |
| D | Password-only / incomplete MFA admin; challenge attempts, replay, expiry | `admin` › *the password alone…*, *5 wrong codes invalidate the challenge*, *the same code cannot be replayed*, *recovery code signs in once; reuse fails*; `admin-mfa.service.spec` › *expired challenge is rejected*, *an idle admin session is destroyed (401)* | ✅ |
| D | Session revocation: logout, reset, password change, suspension | `account` › *success: this session stays, other Customer sessions end, portals unaffected*, *a suspended Customer is locked out*; `account-recovery` › *a valid link resets once (races too), ends every session*; `admin` › *suspension locks the Customer out at once*, *each logout ends only its own session*; `death-verification` › *the verified Customer can no longer sign in or use an old session* | ✅ |
| D | Principals cannot substitute for one another | `admin` › *a cookie only works under its own name*; `account` › Recipient/TC/admin 401; `trusted-contact-portal` › Customer cookie 401 on TC routes; **new** TC cookie 401 on Recipient routes | ✅ |
| E | Thresholds, boundary, block, recovery | `account-recovery` › *two API instances share one counter: 5 logins a minute in total* (boundary 5→429, shared Redis), *the window resets after its TTL*, *forgot-password is limited per IP (10 an hour)* | ✅ |
| E | Two API instances share counters | same test (two booted apps, one Redis) | ✅ |
| E | Fail closed on Redis failure | **new** `security-critical` › *Redis down: throttled routes fail closed (500), sign nothing in and send nothing* | ✅ 500, no cookie, no OTP sent, no internals in the body |
| E | Visitor IP and forged forwarding headers | **new** `security-critical` › *without a trusted proxy (development), X-Forwarded-For is ignored*, *production (trust proxy = 1 hop): only the address the load balancer appends counts; forged entries are ignored* | ✅ for the documented topology; see §3 |
| F | Disallowed-origin state changes | `error-boundary` › *real routes keep their statuses…: 403*; **new** `security-critical` › *a state change from a disallowed Origin is 403 and writes nothing* | ✅ |
| F | Invalid input cannot set protected fields | Area A tampering row; `media` › *rejects invalid upload requests (400) without signing anything* | ✅ |
| F | Pending / rejected uploads never readable; scan failure | `media` › *scanner outage → 503 generic, stays PENDING_UPLOAD*; `memory-vault` › *AUDIO and a wrong-size upload: FAILED, never READY*; `death-evidence` › *MIME spoof*, *malware → 400, FAILED, file removed, never viewable*; `message-composition` › *E — pending (and failed) media block scheduling*, *M — … infected or unscanned file blocks*; §50 row 10 | ✅ |
| G | Safety notice, safeguard, confirmations, admin verification | §50 rows 6, 7; `death-confirmations` A–D; `email-delivery` › *a death report emails the account holder once, then the safeguard starts* | ✅ |
| G | Cancellation before release prevents release | `message-release` › *unscheduling removes the job; a stale job still cannot release*; `death-verification` › *SAFEGUARD_ACTIVE → CANCELLED…*; `email-delivery` › *a notice … never sent after the Customer confirmed alive (race)*; **load** `dup-cancel` (unscheduled before due and while due-but-waiting) | ✅ |
| G | Concurrency within the transaction boundary | `death-confirmations` › *two contacts reporting at once…*, *verify racing the second report…*; `death-verification` › 3 race tests + **new** duplicate approval; `storage-quota` › *concurrent uploads … cannot oversubscribe*; `recipients` › *two uploads completed at once leave exactly one current photo*; `account-recovery` › reset races | ✅ |
| G | Retries / reconcilers never duplicate grants or logical notifications | §50 row 9; load profiles (0 duplicate grants, 0 grants with > 1 notification row in every run) | ✅ |

Tests with a test-only setting (documented, not a production change): the death-verification suites use a 2 s
safeguard so the real worker can advance a case (the production window is untouched; the *cannot verify during the
safeguard* test runs while it is active). Suites other than `security-critical` raise OTP IP limits in their own process
for repeated local runs; `security-critical` uses the production defaults.

---

## 3. Findings and gaps (not new policy)

1. **Login is throttled per IP only** (5/min). There is no per-account lockout, so a distributed attacker is limited only
   by the number of source IPs. Password-reset and verification emails do have a per-account cap (3 an hour). Whether to
   add an account-level limit is a product/security decision; not invented here.
2. **Proxy topology.** `trust proxy = 1` is correct for the documented production topology (one AWS load balancer,
   `authentication.md`). Two consequences that the tests make explicit: (a) if the API is reachable directly, bypassing
   the load balancer, a client can choose its own limiter identity with `X-Forwarded-For`; (b) the Railway client demo
   proxies `/api/v1` through the Next.js server (`API_PROXY_TARGET`), which adds a hop, so the API may key every visitor
   by the frontend server's address (one shared 5/min login bucket). Neither was measured on Railway; verify before
   staging sign-off.
3. **OTP brute force bound**: 5 attempts × 5 codes per address per 15 minutes = at most 25 guesses per address per
   window against a 10⁶ code space (plus 30 verifies per IP), and a dead challenge cannot be revived.
4. **Stripe webhook replay** cannot be tested until phase 21 exists; it stays open.
5. **Test hygiene defect fixed**: e2e suites left `DeadLetterJob` rows (no foreign key) after deleting their test users;
   a worker later started on the same database alerted `OPS_ALERT_EMAIL` about them. 24 such rows per full run in the
   test database; **285** were found in the development database `for_after` (read-only census). Fixed for future runs
   in `test/setup-e2e.ts` (each file removes its own orphaned dead letters). The existing development rows were not
   deleted; `node scripts/dev-clean-orphan-queue-data.mjs` removes them.

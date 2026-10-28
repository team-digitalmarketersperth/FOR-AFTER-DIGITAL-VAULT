# 💌 For After — Recipient Portal (Step 13)

> Passwordless email-code sign-in for Recipients ("People I Love") and **read-only** access to Messages that have been
> **released** to them. The Customer Portal and Recipient Portal are separate: different routes, guards, cookies and
> Redis sessions.

| | |
|---|---|
| **Status** | ✅ Built in Step 13 · OTP code shared with Trusted Contacts since Step 14 (`src/otp-auth/`) |
| **Frontend** | Step 19 (`for-after-frontend`): `/recipient/sign-in` (email → 6-digit code), `/recipient/messages`, `/recipient/messages/[id]` with photos and audio via short-lived signed URLs; its own session gate and sign-out |
| **SMS sign-in** | 2026-10-16: mobile → SMS code through **Twilio Verify** (§3b), same session as email. Automated tests pass; **real SMS verified 2026-10-16** |
| **Sender name** | 2026-10-17 (Phase 18): each released Message shows who it is from, snapshotted at release (§2A) |
| **Post-MVP (decided)** | Grant revocation and read receipts (§2B), by product decision 2026-10-17 |
| **Email provider** | Microsoft Graph (`EMAIL_PROVIDER=microsoft`, 2026-10-21); setup in [email-production-setup.md](email-production-setup.md) |
| **Related** | [Message release](message-release.md) · [Authentication](authentication.md) · [Trusted Contact auth](trusted-contact-auth.md) |

## 🧭 Contents

1. [Principles](#1-principles)
2. [Access grants](#2-access-grants-recipientmessageaccessgrant)
3. [Email OTP](#3-email-otp)
4. [Recipient session](#4-recipient-session)
5. [Endpoints](#5-endpoints)
6. [Logging](#6-logging)
7. [CSRF review](#7-csrf-review)
8. [Configuration](#8-configuration)
9. [Code and tests](#9-code-and-tests)
10. [Not in Step 13](#10-not-in-step-13)

---

## 1. Principles

- **A Recipient is not a User.** No `User` row, no password, role, status or account. `Recipient` is unchanged: a
  contact record owned by one Customer.
- **Access needs all of:** a Recipient session (verified email) + a `RecipientMessageAccessGrant` for that email + the
  Message `RELEASED` + the Message not deleted. Knowing a `messageId`, `recipientId`, `mediaAssetId` or `ownerUserId`
  grants nothing.
- **`MessageRecipient` = pre-release assignment. `RecipientMessageAccessGrant` = post-release authorization.** The portal
  never authorizes from `MessageRecipient` or from the live `Recipient.email`.
- **Read-only.** No Memory Vault, My Story, My Wishes, Trusted Contacts, other recipients, sender account data or schedules.
  The one sender detail shown is the display name snapshotted at release (§2A).
  A Message made from a story or a wish (Phase 14B / 15B) is an ordinary Message with its own copied files.

> ℹ️ A Step 14 death report never creates grants. Grants still come **only** from a successful release.

## 2A. Sender display name (Phase 18, 2026-10-17)

- **What the Recipient sees:** "From Lisa Bridgett" in the letter header, and a quiet "From …" line in the list. That
  is the Customer's `firstName` + `lastName` (whitespace collapsed; either may be missing). Never their email, mobile,
  id, settings, Trusted Contacts or anything else; there is no sender lookup endpoint.
- **Snapshot at release:** `createAccessGrants()` reads the owner's name inside the release transaction and writes
  `senderDisplayNameSnapshot` on each new grant. Every trigger goes through it: NOW, FIXED_DATE, CUSTOM_EVENT, ON_DEATH,
  AFTER_DEATH (one release for all Recipients) and BIRTHDAY, ANNIVERSARY, ANNUAL_AFTER_DEATH (per Recipient occurrence).
- **Immutable:** grants are inserted with `skipDuplicates`, never updated, so a retried job, a later recurring year or
  a Customer rename never changes a delivered Message's sender. New releases use the name at their own release.
- **Recurring triggers:** one grant per Recipient, created at that Recipient's first delivered occurrence, so the name
  is the one from that first delivery. Later years add only a "message is waiting" email; the Message (and its sender
  line) is the same one the Recipient already has.
- **Authorization unchanged:** the name comes from the grant row the portal already uses to authorize, so it is only
  ever returned with a Message the Recipient may open. No grant, no name (`404` as before).
- **Older grants (before 2026-10-17):** `senderDisplayNameSnapshot` is null and the API returns
  `senderDisplayName: null`; the portal keeps "Shared with you" and shows no sender. No backfill and no live-name
  fallback: the name at that time is not known, so none is guessed. (The Step 13 backfill script, if ever run, records
  the name at backfill time, like its other "current value" snapshots.)
- **Customer with no name:** null, same display as an older grant.

## 2B. Grant revocation and read receipts: post-MVP (product decision, 2026-10-17)

- **Grant revocation is not in the MVP.** Once a Message is released and a grant exists, access stays under the rules
  above (contact edits and Recipient removal do not move or remove it). No revoke API, field, status or button exists.
- **Read receipts are not in the MVP.** Opening a Message records nothing: no `readAt`/`openedAt`/`viewedAt`, counts,
  tracking pixels or analytics used as receipts, and the Customer sees no "seen" state. Request logs are operational
  only (`recipient_message_access_granted`, ids only) and are not a product read receipt.
  `recipient-portal.e2e-spec.ts` asserts that opening a Message leaves the grant row unchanged.

---

## 2. Access grants (`RecipientMessageAccessGrant`)

Created inside the Step 12 release transaction (`MessageReleaseService.release`), in this order, all-or-nothing:

1. lock the Message row and re-check it is due (unchanged Step 12 logic);
2. create `MessageRelease`;
3. read the live (`deletedAt: null`) assigned Recipients and create one grant per Recipient (`createAccessGrants`);
4. set `Message.status = RELEASED`.

| Column | Notes |
|---|---|
| `messageReleaseId`, `messageId`, `recipientId` | Which release, Message and Recipient. `@@unique([messageReleaseId, recipientId])` |
| `recipientEmailNormalized` | Snapshot of `Recipient.email` at release: trimmed + lowercased (`emailKey`, the same rule as every DTO) |
| `recipientMobileNormalized` | Snapshot of `Recipient.mobile` at release with spaces/dots/dashes/brackets removed. Recipient mobiles are E.164 since 2026-10-16, so this is what SMS sign-in matches |
| `senderDisplayNameSnapshot` | Phase 18: the Customer's display name when this grant was created (§2A); null on older grants |

Only contact details and the sender's display name are copied: never `privateNote`, `birthday`, `relationship`, the
Recipient's name or content. The grant itself is internal; the API returns only `senderDisplayName` from it.

### Grant rules

| Situation | Behaviour |
|---|---|
| **Retries** | Idempotent: retries see `already_released` before any write; `createMany({ skipDuplicates: true })` plus the unique key is the backstop. Exactly 1 `MessageRelease` + 1 grant per Recipient. |
| **Contact edited after release** | Access does **not** move to the new address; the old address keeps it. Released content must not silently follow a later edit. |
| **Recipient soft-deleted** | The grant stays. Grant revocation is post-MVP by product decision (§2B). |
| **Owner account deleted** | Messages, releases and grants go too (FK `onDelete: Cascade`; `Restrict` would block account deletion). |
| **Mobile-only Recipient** | Grant with a mobile snapshot and no email. Signs in by SMS code (§3b). A mobile saved before E.164 was required (no `+country code`) cannot be matched until the Customer re-saves it. |
| **No contact details at all** | Grant created with both snapshots `null`; unreachable until another identity proof exists. Release not blocked. |
| **Same email twice on one Message** | Two grants, listed once in the portal. |

### Backfill for releases made before Step 13

`src/message-release/backfill-access-grants.ts` finds `MessageRelease` rows with no grants (Message `RELEASED`, not
deleted) and creates grants from the **current** live assignments and contact details, one transaction per release,
idempotently.

```bash
npm run build
npm run backfill:access-grants            # dry run: lists candidate release/message ids, writes nothing
npm run backfill:access-grants -- --apply # writes grants; safe to re-run
```

> ⚠️ **Limitation:** pre-Step 13 releases never snapshotted contacts, so a Recipient edited since release gets the
> edited address, and one deleted since release gets no grant. The backfill never runs automatically; review the dry
> run first in production.

---

## 3. Email OTP

```text
POST /recipient-auth/request-otp {email}             → 202 {challengeId, message}  (code sent only if the email has released content)
POST /recipient-auth/verify-otp  {challengeId, code} → 200 + Set-Cookie for_after_recipient_session
GET  /recipient/messages …                           (cookie)
```

The OTP and session logic lives in the shared engine `src/otp-auth/otp-auth.service.ts` (Step 14);
`RecipientAuthService` supplies only the Recipient settings and eligibility rule. Redis keys and log names are
unchanged from Step 13.

| Aspect | Detail |
|---|---|
| **Code** | 6 digits from `crypto.randomInt` |
| **Ids** | challengeId and session id: 32 bytes from `crypto.randomBytes`, base64url |
| **Storage** | Redis hash `for_after:recipient_otp:<challengeId>` = `{ email, otpHash, attempts }` with TTL `RECIPIENT_OTP_TTL_SECONDS`. Never PostgreSQL; the plaintext code is never stored |
| **Hashing** | `HMAC-SHA256(RECIPIENT_OTP_PEPPER, challengeId + ":" + code)`, compared with `timingSafeEqual`. Pepper required (32+ characters) or the app will not start; never logged |
| **Attempts** | Incremented atomically before comparing. At `RECIPIENT_OTP_MAX_ATTEMPTS` wrong codes the challenge is deleted |
| **Single use** | A correct code deletes the challenge; only the request whose `DEL` succeeds gets a session |
| **Re-checks** | Access is re-checked at verify, and grants on every content request |
| **Resend** | Call `request-otp` again (new challenge, new code). There is no resend endpoint |

### Anti-enumeration

Every valid `request-otp` returns the same `202` body: known email, unknown email, no released content, no grants. A
challenge is created in every case; a code is only delivered when access exists, and delivery is not awaited, so
timing and delivery failures do not leak it either. Every verify failure (wrong, expired, unknown, reused, exhausted,
no access) returns `401 "The code is invalid or has expired. Request a new code."`.

### Rate limits (Redis, shared by all instances)

Fixed windows of `RECIPIENT_OTP_REQUEST_WINDOW_SECONDS` (default 900 s):

| Limit | Default |
|---|:--:|
| request-otp per email (`RECIPIENT_OTP_REQUEST_LIMIT`) | 5 |
| request-otp per IP (`RECIPIENT_OTP_IP_REQUEST_LIMIT`) | 20 |
| verify-otp per IP (`RECIPIENT_OTP_VERIFY_IP_LIMIT`), on top of the per-challenge attempt limit | 30 |

Over the limit → `429`. Key names hold a SHA-256 of the email/IP, never the address. (Earlier `docs/api.md` drafts
planned "3 OTP requests per minute"; the per-15-minute limits above replace that.)

### Delivery (provider-neutral)

`RecipientOtpDelivery` (`sendOtp({ email, code, expiresInSeconds })`) is the only seam. Since Step 24 it emails the
code through `EMAIL_PROVIDER` (`microsoft`; `console` prints it in development; `disabled` sends nothing),
directly rather than through a queue, so the plaintext code never sits in Redis. See
[email-production-setup.md](email-production-setup.md). A released message also sends the Recipient one
"A message is waiting for you" email (no content, a link to `/recipient/sign-in`).

> The production provider is Microsoft Graph (2026-10-21), shared by Recipients and Trusted Contacts. Changing
> provider = a new `EmailProvider` implementation; the auth flow does not change. Setup and verification:
> [email-production-setup.md](email-production-setup.md).

---

## 3b. SMS sign-in (Twilio Verify)

Added 2026-10-16. An additional way in, not a replacement: email sign-in is unchanged.

```text
Browser ──mobile──► POST /recipient-auth/request-sms-otp ──(eligible only)──► Twilio Verify ──SMS──► phone
Browser ──mobile + code──► POST /recipient-auth/verify-sms-otp ──► Twilio VerificationCheck (approved?)
        ──► same RecipientAuthService.createSession ──► for_after_recipient_session ──► /recipient/messages
```

- **Twilio generates, sends, stores and checks the code.** For After never sees it: nothing about the code is in
  PostgreSQL, Redis or logs. No BullMQ: the request is interactive (browser → API → Twilio → response).
- **One integration point:** `src/sms/sms-verification.ts`, `SmsVerification` with `send(to)` and `check(to, code)`.
  It knows nothing about Recipients, so Trusted Contact SMS can reuse it. Twilio errors become a safe code
  (`twilio_60200`); no SID, URL, message or provider response leaves it.
- **E.164 only.** The API strips spaces/dots/dashes/brackets and requires `+<country code><number>`; no country-code
  guessing. Customers must enter Recipient mobiles with a country code (the same rule).
- **Eligibility = the email rule on the mobile snapshot:** a grant with `recipientMobileNormalized` = the mobile, on a
  `RELEASED`/`SCHEDULED`, non-deleted Message. Checked on request, before the Twilio check, and again after approval.
  Several Recipients may share a mobile (like an email): the session sees every grant on that mobile.
- **No SMS relay:** Twilio is only called for eligible mobiles, so an arbitrary number costs nothing and is never texted.
  An ineligible mobile at verify gets `401` without a Twilio call.
- **Anti-enumeration:** `request-sms-otp` always answers `202 {message}` with the same text; sending is not awaited, so
  timing does not reveal eligibility. Wrong, expired, reused and ineligible all get the generic `401` (`INVALID_CODE`).
  A Twilio outage at verify → `503` "Text message sign-in is unavailable right now…", never a provider detail.
- **Rate limits** (same Redis fixed windows and env as email, hashed keys, `429`): request per IP (shared with email)
  and per mobile (`RECIPIENT_OTP_REQUEST_LIMIT`); verify per IP (`RECIPIENT_OTP_VERIFY_IP_LIMIT`) and per mobile
  (`RECIPIENT_OTP_MAX_ATTEMPTS × RECIPIENT_OTP_REQUEST_LIMIT`). Twilio adds its own limits (5 checks per verification,
  send limits per number). The frontend's 30 s resend countdown is UX only.
- **Session reuse:** the session stores `{ mobile, authenticatedAt }` instead of `{ emailNormalized, … }`; same cookie,
  Redis namespace, TTL, fixation handling, logout and guard. `/recipient-auth/me` returns
  `{ authenticated: true, mobile: "+61******678" }` (masked).
- **Logs:** `recipient_sms_otp_requested|invalid|verified|delivery_failed|check_failed|rate_limited` with the mobile
  masked (`+61******678`) and a safe error code; never the code, full number, SIDs or token.

### Provider selection (`SMS_VERIFY_PROVIDER`)

| Value | Behaviour |
|---|---|
| unset | `twilio` when all three `TWILIO_*` are set, else `disabled` |
| `twilio` | Twilio Verify. Startup fails naming any missing `TWILIO_*` variable (names only). Logs `Twilio Verify: configured` |
| `console` | `NODE_ENV=development` only: logs `[DEV ONLY] SMS to +61******678 \| Your For After code is 123456` and accepts that code once. For local E2E; never texts |
| `disabled` | Nothing is sent; verify → `503`. Backend E2E always runs with this (fakes override the provider) |

### Twilio trial accounts

On a trial account Twilio only texts **verified caller IDs** (numbers added in the Twilio Console) and prefixes the
message. Other numbers fail inside Twilio (logged as `recipient_sms_otp_delivery_failed … twilio_<code>`) while the
browser still sees the generic `202`. That is a trial limit, not an app bug.

### Real-provider status (2026-10-16)

| | |
|---|---|
| Implementation | Complete; unit, backend e2e and Playwright (console provider) pass |
| Real SMS | **Verified 2026-10-16**, locally: one OTP to an Indian (+91) mobile through `/recipient/sign-in` → Mobile. Twilio Verify: delivery `CONFIRMED`, conversion `converted` (approved); an existing-store Recipient session `{ mobile, authenticatedAt }` with the 7-day TTL was created |
| Earlier blocker (resolved) | `401` / `20003` from Twilio: first the account was suspended (lack of funds), then the `.env` credentials did not match the reactivated account. Fixed in `.env` and the Console, not in code |
| If `20003` comes back | The app still answers `request-sms-otp` with the generic `202` and logs `recipient_sms_otp_delivery_failed +91******xxx twilio_20003`; `verify-sms-otp` answers `503`. Check the account status and that SID + Auth Token are the current Live pair, then restart the API |

`Twilio Verify: configured` at startup only means the three variables are present; it does not contact Twilio.

### Manual real-SMS test (local only; passed 2026-10-16, rerun after credential or account changes)

Run once, in order; stop at the first failure. Do not repeat sends (each one costs money).

1. Confirm the Twilio Console no longer shows the account as suspended.
2. Restart the local API (`.env` is read only at startup).
3. Do one read-only authentication/service check (fetch the account and the Verify Service; no SMS).
4. Confirm `20003` is gone.
5. Make sure the test Recipient's mobile is the right E.164 number (on a trial account, also a Verified Caller ID)
   and that a Message assigned to them has been released.
6. Open `http://localhost:3000/recipient/sign-in`.
7. Choose **Mobile**.
8. Choose the country and enter the eligible mobile.
9. **Text me a code**.
10. Confirm the real SMS arrives.
11. Enter the real code.
12. Confirm Twilio approves (API log `recipient_sms_otp_verified +61******xxx`).
13. Confirm the Recipient session cookie `for_after_recipient_session` is set.
14. Confirm `/recipient/messages` loads with the released Message.
15. Sign out, request one new code and enter a wrong one.
16. Confirm the wrong code gives the generic error and creates no session (`/recipient/messages` → sign-in).

Only when all 16 pass may [`task.md`](task.md) Phase 18 move from 6 / 7. Trusted Contact SMS stays deferred
(post-MVP); no Railway deployment has been made for SMS.

## 4. Recipient session

- Opaque 32-byte id in cookie **`for_after_recipient_session`** (never `for_after_session`). Stored in Redis as
  `for_after:recipient_sess:<sha256(id)>` → `{ emailNormalized, authenticatedAt }` (or `{ mobile, authenticatedAt }`
  after SMS sign-in, §3b), TTL `RECIPIENT_SESSION_TTL_SECONDS`
  (7 days). No message content, URLs, grants or recipient ids in the session.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production`, `Domain=RECIPIENT_COOKIE_DOMAIN`
  (empty = host-only on localhost; `.forafter.com.au` in production). Not signed: the id is 256 random bits and only
  its hash is stored.
- No JWT, nothing in `localStorage`, no tokens in URLs.
- `verify-otp` and `verify-sms-otp` destroy any Recipient session the browser already had (fixation). `logout` deletes the Redis session
  and clears the cookie with the same attributes; `204` with or without a session.
- `RecipientSessionAuthGuard` reads only the Recipient cookie and sets `req.recipient` (`@CurrentRecipient()`), never
  `req.user`.

> 🔒 **Three separate principals.** Customer, Recipient and (since Step 14) Trusted Contact sessions each get `401` on
> the others' routes. A browser can hold all three cookies at once without any affecting another.

---

## 5. Endpoints

Prefix `/api/v1`.

| Method | Path | Auth | Result |
|---|---|---|---|
| POST | `/recipient-auth/request-otp` | none | `202 {challengeId, message}`; `400` invalid email/extra fields; `429` |
| POST | `/recipient-auth/verify-otp` | none | `200 {authenticated: true, email}` + cookie; `400` malformed; `401`; `429` |
| POST | `/recipient-auth/request-sms-otp` | none | `{mobile}` (E.164, example `+61400000000`) → `202 {message}` for any valid mobile; `400` not E.164/extra fields; `429` |
| POST | `/recipient-auth/verify-sms-otp` | none | `{mobile, code}` → `200 {authenticated: true, mobile}` (masked) + the same cookie; `400`; `401`; `429`; `503` provider unavailable |
| GET | `/recipient-auth/me` | Recipient | `200 {authenticated: true, email}` or `{authenticated: true, mobile}` (masked); `401` |
| POST | `/recipient-auth/logout` | optional | `204` |
| GET | `/recipient/messages` | Recipient | `200 [{id, title, contentType, releasedAt, hasMedia, senderDisplayName}]`, newest release first |
| GET | `/recipient/messages/:messageId` | Recipient | `200 {id, title, contentType, textContent, releasedAt, hasMedia, senderDisplayName}`; `404` |
| GET | `/recipient/messages/:messageId/media` | Recipient | `200 [{id, kind, originalFileName, mimeType, sizeBytes, uploadedAt}]`; `404` |
| GET | `/recipient/messages/:messageId/media/:mediaAssetId/access-url` | Recipient | `200 {url, expiresAt}`; `404` |

### Rules

- `404 "Message not found."` for draft, scheduled, cancelled, deleted, unknown and other people's Messages alike; never
  `403`, which would confirm someone else's released content exists. Malformed UUIDs → `400`.
- **Media:** only `READY`, non-deleted `PHOTO`/`AUDIO`/`VIDEO` (Phase 12) assets of that Message. Pending, failed, deleted or other
  Messages' assets → `404 "Media not found."` and nothing is signed. The URL is a short-lived signed GET
  (`MEDIA_ACCESS_URL_TTL_SECONDS`), created only after the grant check, never stored or logged.
- `hasMedia` counts the same visible media.
- The only sender data returned is `senderDisplayName` (the release-time snapshot, §2A, or null). No other Customer data.
- **Same email, several Customers:** a verified email sees every Message released to it by any Customer. Nothing else
  about those Customers is exposed.
- No PATCH/DELETE/POST routes under `/recipient/messages` (unknown routes → `404`).

---

## 6. Logging

Nest Logger → Nest Observe. Categories:

`recipient_otp_requested` · `recipient_otp_verified` · `recipient_otp_invalid` (with reason) ·
`recipient_otp_rate_limited` · `recipient_otp_delivery_failed` · `recipient_session_created` ·
`recipient_session_logout` · `recipient_message_access_granted` · `recipient_message_access_denied` ·
`recipient_media_access_granted` · `recipient_release_grants_created` (release worker)

| ✅ Logged | ❌ Never logged |
|---|---|
| masked email (`s***@example.com`), 8-character challenge prefix, message/media ids, counts | the code (except dev console delivery), OTP hash, pepper, session id, full email, message text, signed URLs, storage keys |

---

## 7. CSRF review

No new CSRF framework; same model as the Customer session ([authentication.md](authentication.md)): `SameSite=Lax`
cookie, CORS limited to `FRONTEND_URL`/`WORDPRESS_URL` with credentials, JSON APIs.

| Route | Assessment |
|---|---|
| `request-otp` | Needs no session and only sends a code to the typed address (rate-limited) |
| `logout` | A cross-site POST carries no `Lax` cookie, so it cannot log someone out from another site |
| `verify-otp` | "Login CSRF": another site could sign a browser into the *attacker's own* Recipient session. Low impact (it shows the attacker's own released Messages, nothing of the victim); the same applies to Customer and Trusted Contact login today |
| Content routes | GET and read-only |

Same-site subdomains (`forafter.com.au`, `app.`, `api.`) are trusted for `Lax`. The open task "CSRF review for
cookie-based requests from WordPress and Next.js domains" ([task.md](task.md)) covers all portals; if a token/Origin
check is adopted, apply it to all three.

---

## 8. Configuration

| Variable | Default | Notes |
|---|:--:|---|
| `RECIPIENT_OTP_PEPPER` | — | **Required**, 32+ random characters. Secret |
| `RECIPIENT_OTP_TTL_SECONDS` | 600 | Code lifetime |
| `RECIPIENT_OTP_MAX_ATTEMPTS` | 5 | Wrong codes per challenge |
| `RECIPIENT_OTP_REQUEST_LIMIT` | 5 | request-otp per email per window |
| `RECIPIENT_OTP_REQUEST_WINDOW_SECONDS` | 900 | Window for all three limits |
| `RECIPIENT_OTP_IP_REQUEST_LIMIT` | 20 | request-otp per IP per window |
| `RECIPIENT_OTP_VERIFY_IP_LIMIT` | 30 | verify-otp per IP per window |
| `RECIPIENT_SESSION_TTL_SECONDS` | 604800 | Session and cookie lifetime |
| `RECIPIENT_COOKIE_DOMAIN` | empty | `.forafter.com.au` in production |
| `SMS_VERIFY_PROVIDER` | see §3b | `twilio` \| `console` (development only) \| `disabled` |
| `TWILIO_ACCOUNT_SID` | — | Twilio account. Secret: backend `.env` only, never `NEXT_PUBLIC_*` |
| `TWILIO_AUTH_TOKEN` | — | Secret. Never logged |
| `TWILIO_VERIFY_SERVICE_SID` | — | The Verify Service (6-digit codes, the Twilio default) |

---

## 9. Code and tests

### Code

| Path | Contents |
|---|---|
| `src/otp-auth/otp-auth.service.ts` | Shared OTP + session engine, delivery abstraction, cookie reader (Step 14 extraction) |
| `src/recipient-auth/` | `RecipientAuthService` (Recipient settings + eligibility), `RecipientAuthController`, `RecipientSessionAuthGuard` + `@CurrentRecipient()`, `RecipientOtpDelivery` token, DTOs |
| `src/sms/` | `SmsVerification` (Twilio Verify, console, disabled) + `SmsModule` (2026-10-16) |
| `src/recipient-portal/` | `RecipientMessagesService` + controller |
| `src/message-release/message-release.service.ts` | `createAccessGrants` inside the release transaction; `backfill-access-grants.ts` |
| Migrations | `add_recipient_portal_access` (new table), `recipient_grant_owner_deletion` (grant → Recipient FK to `CASCADE`) |

### Tests

- **Unit:** `src/recipient-auth/recipient-auth.service.spec.ts` (OTP, HMAC, TTL, attempts, reuse, rate limits, delivery
  modes, sessions, guard, logs), `src/recipient-portal/recipient-messages.service.spec.ts`, `src/message-release/*.spec.ts`
  (grants, idempotency, rollback, backfill), `src/sms/sms-verification.spec.ts` (Twilio SDK mocked). Cross-principal checks live in `src/trusted-contact-auth/trusted-contact-auth.service.spec.ts`.
- **E2E:** `test/recipient-portal.e2e-spec.ts`: real app, PostgreSQL and Redis; a fake OTP delivery captures codes in
  the test process (never through the API); a fake `SmsVerification` stands in for Twilio; storage mocked; releases
  executed through `MessageReleaseService`.
- **Postman:** folders `12-Recipient-Auth` and `13-Recipient-Portal` of the FOR-AFTER collection.

---

## 10. Not in Step 13

SMS OTP / Twilio (added 2026-10-16, §3b), a production email provider (Microsoft Graph, added 2026-10-21), Recipient passwords/accounts/profiles, replies, comments, read receipts (post-MVP, §2B),
download tracking, grant revocation (post-MVP, §2B), sharing Memory Vault / My Story / My Wishes, death **verification**,
`ON_DEATH`/`AFTER_DEATH` execution, admin portal, billing, AI features, frontend, VIDEO.

> ✅ Trusted Contact sign-in and death report **intake** were added in Step 14 ([trusted-contact-auth.md](trusted-contact-auth.md)).

## Portal design (2026-10-15)

Frontend only; the API, grants and DTOs are unchanged.

- **List (`/recipient/messages`):** a short intro ("A space shared with you"), the real count of released
  messages the session can open, the newest release as a featured card, and earlier ones as a divided list (title,
  "Photo message"/"Voice message"/…, shared date, Open). The featured message is simply the first item of the
  newest-first list: no featured flag, no extra query.
- **Summary vs detail:** the list uses `GET /recipient/messages` (id, title, type, releasedAt, hasMedia: no text);
  only the detail fetches text and media.
- **Media previews:** there are no thumbnails, so cards show a drawn treatment per content type. Nothing is signed for
  the list; on the detail, photos sign when shown and audio/video only when played, as before.
- **Sender:** since Phase 18 (2026-10-17) the letter header reads "From *Name*" (serif, under the title) and list
  items add a quiet "From …" line; older Messages without a snapshot keep "Shared with you" (§2A).
- **Empty state:** "Nothing has been shared with you yet." Never a hint that unreleased content exists.
- **Errors:** list failure shows a fixed message with Try again, never the API's text; one file failing stays local.
- **Mobile:** art above content in the featured card, rows stay single-column, the email hides below `md`.
- **Never shown:** private notes, versions, autosaves, schedules, Trusted Contact or death-verification data, sender
  account data beyond the display name (the API does not send them; `recipient-portal.e2e-spec.ts` asserts the absence).

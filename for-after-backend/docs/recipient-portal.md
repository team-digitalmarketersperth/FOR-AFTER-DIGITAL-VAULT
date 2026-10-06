# 💌 For After — Recipient Portal (Step 13)

> Passwordless email-code sign-in for Recipients ("People I Love") and **read-only** access to Messages that have been
> **released** to them. The Customer Portal and Recipient Portal are separate: different routes, guards, cookies and
> Redis sessions.

| | |
|---|---|
| **Status** | ✅ Built in Step 13 · OTP code shared with Trusted Contacts since Step 14 (`src/otp-auth/`) |
| **Frontend** | Step 19 (`for-after-frontend`): `/recipient/sign-in` (email → 6-digit code), `/recipient/messages`, `/recipient/messages/[id]` with photos and audio via short-lived signed URLs; its own session gate and sign-out |
| **Not yet** | SMS OTP, a production email provider, grant revocation |
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

> ℹ️ A Step 14 death report never creates grants. Grants still come **only** from a successful release.

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
| `recipientMobileNormalized` | Snapshot of `Recipient.mobile` at release, trimmed. No phone normalization yet (SMS is deferred) |

Only contact details are copied: never `privateNote`, `birthday`, `relationship`, names or content. The grant is
internal and never returned by the API.

### Grant rules

| Situation | Behaviour |
|---|---|
| **Retries** | Idempotent: retries see `already_released` before any write; `createMany({ skipDuplicates: true })` plus the unique key is the backstop. Exactly 1 `MessageRelease` + 1 grant per Recipient. |
| **Contact edited after release** | Access does **not** move to the new address; the old address keeps it. Released content must not silently follow a later edit. |
| **Recipient soft-deleted** | The grant stays. Explicit revocation is a later design. |
| **Owner account deleted** | Messages, releases and grants go too (FK `onDelete: Cascade`; `Restrict` would block account deletion). |
| **Mobile-only Recipient** | Grant with a mobile snapshot and no email. The release does not fail; they cannot sign in until SMS OTP exists. |
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
code through `EMAIL_PROVIDER` (`brevo`; `console` prints it in development; `disabled` sends nothing),
directly rather than through a queue, so the plaintext code never sits in Redis. See
[email-production-setup.md](email-production-setup.md). A released message also sends the Recipient one
"A message is waiting for you" email (no content, a link to `/recipient/sign-in`).

> ⚠️ No email provider is chosen or wired in yet (Postmark or AWS SES are candidates). Adding one = a new delivery
> implementation and mode; the auth flow does not change. One provider can serve both Recipients and Trusted Contacts.
> Until then the portal cannot be used in production.

---

## 4. Recipient session

- Opaque 32-byte id in cookie **`for_after_recipient_session`** (never `for_after_session`). Stored in Redis as
  `for_after:recipient_sess:<sha256(id)>` → `{ emailNormalized, authenticatedAt }`, TTL `RECIPIENT_SESSION_TTL_SECONDS`
  (7 days). No message content, URLs, grants or recipient ids in the session.
- Cookie: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV=production`, `Domain=RECIPIENT_COOKIE_DOMAIN`
  (empty = host-only on localhost; `.forafter.com.au` in production). Not signed: the id is 256 random bits and only
  its hash is stored.
- No JWT, nothing in `localStorage`, no tokens in URLs.
- `verify-otp` destroys any Recipient session the browser already had (fixation). `logout` deletes the Redis session
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
| GET | `/recipient-auth/me` | Recipient | `200 {authenticated: true, email}`; `401` |
| POST | `/recipient-auth/logout` | optional | `204` |
| GET | `/recipient/messages` | Recipient | `200 [{id, title, contentType, releasedAt, hasMedia}]`, newest release first |
| GET | `/recipient/messages/:messageId` | Recipient | `200 {id, title, contentType, textContent, releasedAt, hasMedia}`; `404` |
| GET | `/recipient/messages/:messageId/media` | Recipient | `200 [{id, kind, originalFileName, mimeType, sizeBytes, uploadedAt}]`; `404` |
| GET | `/recipient/messages/:messageId/media/:mediaAssetId/access-url` | Recipient | `200 {url, expiresAt}`; `404` |

### Rules

- `404 "Message not found."` for draft, scheduled, cancelled, deleted, unknown and other people's Messages alike; never
  `403`, which would confirm someone else's released content exists. Malformed UUIDs → `400`.
- **Media:** only `READY`, non-deleted `PHOTO`/`AUDIO` assets of that Message. Pending, failed, deleted, VIDEO or other
  Messages' assets → `404 "Media not found."` and nothing is signed. The URL is a short-lived signed GET
  (`MEDIA_ACCESS_URL_TTL_SECONDS`), created only after the grant check, never stored or logged.
- `hasMedia` counts the same visible media.
- No sender name or Customer data is returned (open product decision).
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

---

## 9. Code and tests

### Code

| Path | Contents |
|---|---|
| `src/otp-auth/otp-auth.service.ts` | Shared OTP + session engine, delivery abstraction, cookie reader (Step 14 extraction) |
| `src/recipient-auth/` | `RecipientAuthService` (Recipient settings + eligibility), `RecipientAuthController`, `RecipientSessionAuthGuard` + `@CurrentRecipient()`, `RecipientOtpDelivery` token, DTOs |
| `src/recipient-portal/` | `RecipientMessagesService` + controller |
| `src/message-release/message-release.service.ts` | `createAccessGrants` inside the release transaction; `backfill-access-grants.ts` |
| Migrations | `add_recipient_portal_access` (new table), `recipient_grant_owner_deletion` (grant → Recipient FK to `CASCADE`) |

### Tests

- **Unit:** `src/recipient-auth/recipient-auth.service.spec.ts` (OTP, HMAC, TTL, attempts, reuse, rate limits, delivery
  modes, sessions, guard, logs), `src/recipient-portal/recipient-messages.service.spec.ts`, `src/message-release/*.spec.ts`
  (grants, idempotency, rollback, backfill). Cross-principal checks live in `src/trusted-contact-auth/trusted-contact-auth.service.spec.ts`.
- **E2E:** `test/recipient-portal.e2e-spec.ts`: real app, PostgreSQL and Redis; a fake OTP delivery captures codes in
  the test process (never through the API); storage mocked; releases executed through `MessageReleaseService`.
- **Postman:** folders `12-Recipient-Auth` and `13-Recipient-Portal` of the FOR-AFTER collection.

---

## 10. Not in Step 13

SMS OTP / Twilio, a production email provider, Recipient passwords/accounts/profiles, replies, comments, read receipts,
download tracking, grant revocation, sharing Memory Vault / My Story / My Wishes, death **verification**,
`ON_DEATH`/`AFTER_DEATH` execution, admin portal, billing, AI features, frontend, VIDEO.

> ✅ Trusted Contact sign-in and death report **intake** were added in Step 14 ([trusted-contact-auth.md](trusted-contact-auth.md)).

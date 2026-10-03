# 🤝 For After — Trusted Contact Authentication & Portal (Step 14)

| | |
|---|---|
| **Status** | ✅ Built in Step 14 · 20 e2e + 23 unit tests · Postman folders 14–15 |
| **Frontend** | Step 19 (`for-after-frontend`): `/trusted-contact/sign-in`, `/trusted-contact/accounts`, account status page, death-report form with explicit confirmation; its own session gate and sign-out |
| **Not yet** | Email provider, SMS OTP, invitations, evidence upload (death verification itself was built in Step 15) |
| **Related** | [Death verification](death-verification.md) · [Authentication](authentication.md) · [Recipient Portal](recipient-portal.md) |

## 🧭 Contents

1. [Three separate principals](#1-three-separate-principals)
2. [Shared OTP engine](#2-shared-otp-engine)
3. [Endpoints](#3-endpoints)
4. [OTP flow](#4-otp-flow)
5. [Delivery](#5-delivery)
6. [Accounts](#6-accounts)
7. [Logging](#7-logging)
8. [Configuration](#8-configuration)
9. [Not built yet](#9-not-built-yet)

---

A **Trusted Contact** is a person a Customer nominates (`/trusted-contacts`, Step 4) to notify the platform of their
passing. Step 14 lets that person sign in with an **email one-time code** and file a **death report**
(`docs/death-verification.md`). Nothing else.

- A Trusted Contact is **not a User**: no password, role, status or account row. The `TrustedContact` table has no
  auth columns; sessions live only in Redis.
- A Trusted Contact gets **no access to the Customer's content**: no Messages, media, Memory Vault, My Story or My
  Wishes, before or after a report.
- A report does **not** verify death, mark anyone dead, or release anything. Since Step 15 it starts the account
  holder's safety notice and safeguard window; only an admin can then verify ([death-verification.md](death-verification.md)).
- Trusted Contacts **cannot** verify, reject or release anything, and they never see other reporters, the report count,
  the verified time of death or admin notes. Their status view (`status`, `reportedByYou`, `openedAt`) may now show any
  of `PENDING_VERIFICATION`, `SAFEGUARD_ACTIVE`, `READY_FOR_REVIEW`, `VERIFIED`, `REJECTED`, `CANCELLED`.
- While the case is open (pending, safeguard, review), further contacts can still add their own report; once it is
  closed, reports get `409`.

## 1. Three separate principals

| Principal | Cookie | Sign-in | Guard | Request field |
| :-- | :-- | :-- | :-- | :-- |
| Customer | `for_after_session` | email + password (`/auth`) | `SessionAuthGuard` + `CustomerGuard` | `req.user` |
| Recipient | `for_after_recipient_session` | email OTP (`/recipient-auth`) | `RecipientSessionAuthGuard` | `req.recipient` |
| Trusted Contact | `for_after_trusted_contact_session` | email OTP (`/trusted-contact-auth`) | `TrustedContactSessionAuthGuard` | `req.trustedContact` |

Each guard reads only its own cookie and sets only its own request field. None substitutes for another (all return
`401`). Recipient and Trusted Contact OTP use separate peppers, Redis namespaces, session keys and cookies, so a
Recipient challenge or session can never authenticate a Trusted Contact, or the reverse.

## 2. Shared OTP engine

`src/otp-auth/otp-auth.service.ts` holds the one implementation of email OTP + opaque Redis sessions, extracted from
Step 13. `RecipientAuthService` and `TrustedContactAuthService` subclass it and supply only:

| | Recipient | Trusted Contact |
| :-- | :-- | :-- |
| Env prefix | `RECIPIENT_` | `TRUSTED_CONTACT_` |
| Redis challenge key | `for_after:recipient_otp:<challengeId>` | `for_after:trusted_contact_otp:<challengeId>` |
| Redis session key | `for_after:recipient_sess:<sha256(sessionId)>` | `for_after:trusted_contact_sess:<sha256(sessionId)>` |
| Rate-limit keys | `for_after:recipient_rl:<scope>:<sha256>` | `for_after:trusted_contact_rl:<scope>:<sha256>` |
| Eligible email | has a grant for a RELEASED Message | is an active TrustedContact of an active Customer |

Recipient key names and log categories are unchanged from Step 13.

## 3. Endpoints

Base: `/api/v1`.

| Method | Path | Auth | Result |
| :-- | :-- | :-- | :-- |
| `POST` | `/trusted-contact-auth/request-otp` | none | `202 {challengeId, message}` for every valid email |
| `POST` | `/trusted-contact-auth/verify-otp` | none | `200 {authenticated: true, email}` + cookie; any failure `401` |
| `GET` | `/trusted-contact-auth/me` | TC session | `200 {authenticated: true, email}` |
| `POST` | `/trusted-contact-auth/logout` | none | `204`, session destroyed, cookie cleared |
| `GET` | `/trusted-contact/accounts` | TC session | the Customers who list this email |
| `POST` | `/trusted-contact/accounts/:trustedContactId/death-reports` | TC session | `201` report receipt |
| `GET` | `/trusted-contact/accounts/:trustedContactId/death-verification` | TC session | high-level case status |

## 4. OTP flow

1. **Request.** Body `{ "email": "david@example.com" }`, normalized (trim + lowercase) with the same `normalizeEmail`
   used for Recipients and Trusted Contacts. Invalid email → `400`. Every valid email gets the same
   `202 {challengeId, message: "If this email is registered as a trusted contact, a verification code has been sent."}`.
   A code is sent only if the email is **eligible**: at least one `TrustedContact` with that email, `deletedAt = null`,
   whose Customer is not deleted. No death report or released content is needed. Sending is not awaited, so response
   time does not reveal eligibility either.
2. **Code.** 6 digits from `crypto.randomInt`; `challengeId` is 32 bytes from `crypto.randomBytes` (base64url).
3. **Storage.** Redis hash `{email, otpHash, attempts}` with a TTL (`TRUSTED_CONTACT_OTP_TTL_SECONDS`, default 600).
   `otpHash = HMAC-SHA256(TRUSTED_CONTACT_OTP_PEPPER, "<challengeId>:<code>")`. The plaintext code is never stored.
4. **Verify.** Body `{challengeId, code}`. The attempt is counted atomically before comparing (timing-safe compare).
   Wrong, expired, unknown, reused, exhausted (`TRUSTED_CONTACT_OTP_MAX_ATTEMPTS`, default 5) and no-longer-eligible
   all return the same `401 "The code is invalid or has expired. Request a new code."`. Success deletes the
   challenge (single use; only the request that deletes it may continue) and re-checks eligibility.
5. **Session.** A new opaque 32-byte session id, stored in Redis as `{emailNormalized, authenticatedAt}` under a hashed
   key with `TRUSTED_CONTACT_SESSION_TTL_SECONDS` (default 7 days). A session id the browser already had is destroyed
   (fixation). No TrustedContact ids are kept in the session: relationships are re-read from PostgreSQL on every
   request, so removing a contact takes effect immediately.

**Cookie** `for_after_trusted_contact_session`: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production,
`Domain` from `TRUSTED_CONTACT_COOKIE_DOMAIN` (empty on localhost).

**Rate limits** (Redis fixed windows of `TRUSTED_CONTACT_OTP_REQUEST_WINDOW_SECONDS`, default 900 s, shared by all API
instances): 5 requests per email, 20 per IP, 30 verifies per IP → `429`. Keys hold hashes, never email addresses.

## 5. Delivery

Provider-neutral `TrustedContactOtpDelivery.sendOtp({email, code, expiresInSeconds})`. Since Step 24 it emails the
code through `EMAIL_PROVIDER` (see [email-production-setup.md](email-production-setup.md)); `console` (development
only) prints it to the API terminal.

Startup also fails if `TRUSTED_CONTACT_OTP_PEPPER` is missing or shorter than 32 characters.

## 6. Accounts

`GET /trusted-contact/accounts` returns every active relationship for the signed-in email (the same person can be a
Trusted Contact for several Customers):

```json
[
  {
    "trustedContactId": "uuid",
    "accountHolder": { "displayName": "Lisa Test" },
    "relationship": "Friend",
    "hasPreservedContent": true,
    "deathVerificationStatus": null
  }
]
```

- `displayName` is the Customer's first + last name (fallback `Account holder`). Never the Customer's email, mobile or id.
- `hasPreservedContent` is a boolean only: whether the Customer has any non-deleted Message, Memory Vault item, My Story
  answer or My Wishes answer. Computed with `take: 1` existence probes; no counts, titles, categories, recipients or
  dates are read into the response.
- `deathVerificationStatus` is the case status or `null`.

For `/trusted-contact/accounts/:trustedContactId/...`, the id must be a UUID (`400`) and must be a TrustedContact whose
email is the signed-in email, not deleted, with a non-deleted Customer. Anything else is `404 Account not found.`
(never `403`).

## 7. Logging

Categories: `trusted_contact_otp_requested`, `trusted_contact_otp_verified`, `trusted_contact_otp_invalid`,
`trusted_contact_otp_rate_limited`, `trusted_contact_session_created`, `trusted_contact_session_logout`,
`trusted_contact_accounts_viewed`, `death_report_submitted`, `death_report_duplicate`,
`death_verification_status_viewed`. Logs carry masked emails, an 8-character challenge prefix and row ids only. Never
the code (outside dev console mode), its hash, the pepper, session ids, report notes or Customer content.

## 8. Configuration

See `.env.example`: `TRUSTED_CONTACT_OTP_TTL_SECONDS`, `TRUSTED_CONTACT_OTP_MAX_ATTEMPTS`,
`TRUSTED_CONTACT_OTP_REQUEST_LIMIT`, `TRUSTED_CONTACT_OTP_REQUEST_WINDOW_SECONDS`,
`TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT`, `TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT`, `TRUSTED_CONTACT_OTP_PEPPER` (required),
`TRUSTED_CONTACT_SESSION_TTL_SECONDS`, `TRUSTED_CONTACT_COOKIE_DOMAIN`.

## 9. Not built yet

SMS OTP, a real email provider, invitations to Trusted Contacts, Trusted Contact editing of Recipient details, any
content access or sharing, evidence upload, second-contact confirmation. The verification workflow itself (safety
notice, safeguard, admin decision) was built in Step 15 (`docs/death-verification.md`).

Tests: `src/trusted-contact-auth/trusted-contact-auth.service.spec.ts`, `test/trusted-contact-portal.e2e-spec.ts`.

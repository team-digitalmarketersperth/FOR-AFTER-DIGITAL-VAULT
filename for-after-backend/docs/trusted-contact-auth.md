# 🤝 For After — Trusted Contacts: Authentication, Portal, Invitations (Step 14, Phase 10)

| | |
|---|---|
| **Status** | ✅ Step 14 (email OTP + portal), Step 24 (email delivery), Phase 10 (maximum 2, email invitations, permission model, new case after a closed one) |
| **Frontend** | Step 19: `/trusted-contact/sign-in`, `/trusted-contact/accounts`, account status page, death-report form. Phase 10: `/trusted-contact/invitation?token=…`, invitation status + resend and the 2-contact limit in FE-11 |
| **Deferred** | ⏸️ SMS OTP and SMS invitations (no Twilio, no `SmsProvider`) · evidence upload |
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
9. [Maximum per Customer (Phase 10)](#9-maximum-per-customer-phase-10)
10. [Email invitations (Phase 10)](#10-email-invitations-phase-10)
11. [Permission model (Phase 10)](#11-permission-model-phase-10)
12. [Deferred / not built](#12-deferred--not-built)

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
  the verified time of death or admin notes. Their status view (`status`, `reportedByYou`, `openedAt`, `canReport`)
  describes the Customer's **current (newest)** case and may show any of `PENDING_VERIFICATION`, `SAFEGUARD_ACTIVE`,
  `READY_FOR_REVIEW`, `VERIFIED`, `REJECTED`, `CANCELLED`.
- While the case is open (pending, safeguard, review), further contacts can still add their own report (one each).
  **Phase 10:** after a `CANCELLED` or `REJECTED` case, a report from any active Trusted Contact opens a **new** case
  that runs the full workflow again; after `VERIFIED` reports get `409` ([death-verification.md](death-verification.md) §1).

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
| `GET` | `/trusted-contact/accounts/:trustedContactId/death-verification` | TC session | high-level status of the current case + `canReport` |
| `POST` | `/trusted-contacts/:id/invitation` | Customer | Phase 10: send/resend the email invitation → `200` contact |
| `POST` | `/trusted-contact/invitation/view` | none (token) | Phase 10: `{status, accountHolder}` |
| `POST` | `/trusted-contact/invitation/accept` | none (token) | Phase 10: `PENDING → ACCEPTED`; no session |
| `POST` | `/trusted-contact/invitation/decline` | none (token) | Phase 10: `PENDING → DECLINED` |

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
code through `EMAIL_PROVIDER` (see [email-production-setup.md](email-production-setup.md)): `brevo` delivers it to the
inbox; `console` (development only) prints it to the API terminal. Ineligible emails get the same `202` and no code.

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
`death_verification_status_viewed`, `death_case_reopened`, `trusted_contact_invitation_sent`,
`trusted_contact_invitation_failed`, `trusted_contact_invitation_accepted`, `trusted_contact_invitation_declined`. Logs carry masked emails, an 8-character challenge prefix and row ids only. Never
the code (outside dev console mode), its hash, the pepper, session ids, report notes or Customer content.

## 8. Configuration

See `.env.example`: `TRUSTED_CONTACT_OTP_TTL_SECONDS`, `TRUSTED_CONTACT_OTP_MAX_ATTEMPTS`,
`TRUSTED_CONTACT_OTP_REQUEST_LIMIT`, `TRUSTED_CONTACT_OTP_REQUEST_WINDOW_SECONDS`,
`TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT`, `TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT`, `TRUSTED_CONTACT_OTP_PEPPER` (required),
`TRUSTED_CONTACT_SESSION_TTL_SECONDS`, `TRUSTED_CONTACT_COOKIE_DOMAIN`, `TRUSTED_CONTACT_INVITATION_TTL_SECONDS`
(Phase 10, default 604800 = 7 days: a technical default, no product-approved lifetime exists).

## 9. Maximum per Customer (Phase 10)

**Product decision (final for V1): at most 2 active Trusted Contacts per Customer.** Active = `deletedAt = null`;
removed (soft-deleted) contacts do not count, so removing one frees a place. Editing is always allowed.

- `POST /trusted-contacts` returns `409 You can nominate up to 2 trusted contacts. Remove one to add someone else.` for
  a third. The API is authoritative; FE-11 hides "Add" at the limit and explains it (`MAX_TRUSTED_CONTACTS`, one
  constant per repo).
- **Concurrency:** the count and the insert run in one transaction that first takes `SELECT … FROM "User" WHERE id = $owner
  FOR UPDATE`. Concurrent creates for the same Customer are serialised, so a plain count-then-insert race cannot end
  with 3. Other Customers are not blocked. The same row lock serialises invitation sends and death reports for that
  Customer. (e2e: five concurrent creates at 1 contact → exactly one `201`, four `409`.)

## 10. Email invitations (Phase 10)

**Email only.** SMS invitations are deferred: a mobile-only contact is a valid record, but no invitation can be
delivered (`invitation.status = UNAVAILABLE`, `POST …/invitation` → `409`), and nothing pretends one was sent.

```text
Customer adds a contact with an email ──► invitation PENDING + email (EmailProvider → Brevo)
                                           │  link: ${APP_BASE_URL}/trusted-contact/invitation?token=<token>
invitee opens the link ──► view ──► accept → ACCEPTED   (no session; sign-in stays email OTP)
                                 └─► decline → DECLINED  (no access; the Customer may resend)
```

- **Model** `TrustedContactInvitation`: `trustedContactId`, `emailNormalized` (the address it was sent to), `tokenHash`
  (unique), `status` (`PENDING | ACCEPTED | DECLINED | CANCELLED`), `expiresAt`, `acceptedAt`, `declinedAt`,
  `cancelledAt`. `EXPIRED` is not stored: it is a `PENDING` row past `expiresAt`. A partial unique index allows at most
  one `PENDING` row per contact. Migration `20261006050907_trusted_contact_invitations_and_case_history`.
- **Token:** 32 bytes from `crypto.randomBytes`, base64url. Only its SHA-256 is stored; the raw token exists only in the
  email. It is never logged, audited, queued or returned by the API. Sent straight through `EmailProvider` (template
  `trusted-contact-invitation`), not the email queue, so it never sits in Redis job data (same rule as Phase 04 links).
- **Send / resend** (`POST /trusted-contacts/:id/invitation`, owning Customer only; foreign/removed id → `404`): cancels
  any `PENDING` invitation and issues a new token in one transaction, so only the newest link works. At most 3 per
  contact per hour (`429`). Already `ACCEPTED` → `409`. Allowed again after `DECLINED` or expiry. If the email cannot be
  sent, the new link is cancelled and the API answers `503` (on create the contact is kept and shows `NOT_SENT`).
- **Accept / decline** (token in the POST body, never the URL path): one conditional update, so exactly one answer wins.
  It only succeeds while the invitation is `PENDING`, unexpired, and the relationship still exists (contact not deleted,
  Customer not deleted) **with the same email it was sent to**. Changing a contact's email or removing the contact
  therefore makes the old link unusable (removal also marks it `CANCELLED`). The answer returns the resulting view; the
  page shows `ACCEPTED`, `DECLINED`, `EXPIRED` or `CANCELLED` states without a name once the link is dead.
- **Accepting grants nothing.** It records consent. The Trusted Contact still signs in by email OTP, and every portal
  request still re-checks the live `TrustedContact` row.
- **What the Customer sees** (`invitation` on every `/trusted-contacts` response): `{status, sentAt}` with status
  `PENDING | ACCEPTED | DECLINED | EXPIRED | NOT_SENT | UNAVAILABLE`. Never the token or its hash.
- **Audit** (`AuditLog`): `TRUSTED_CONTACT_INVITATION_SENT` (actor `CUSTOMER`), `…_ACCEPTED` / `…_DECLINED` (actor
  `TRUSTED_CONTACT`, no user id), subject `TrustedContact/<id>`. No addresses, tokens or session ids.

## 11. Permission model (Phase 10)

**Product decision (V1).** Enforced server-side by the guards and queries above; the frontend only mirrors it.

| A Trusted Contact **may** | A Trusted Contact **may not** |
| :-- | :-- |
| sign in with the existing email OTP (own cookie, own session) | read any Message (body, title), media or signed URL |
| see the Customer's display name (and the relationship label: existing behaviour, still an open product question) | see Recipients or their email/mobile |
| see `hasPreservedContent` (a boolean only) | open Memory Vault, My Story or My Wishes |
| see the current case status (+ `reportedByYou`, `openedAt`, `canReport`) | see Customer settings, schedules or private notes |
| report the Customer's death; add a supporting report to an open case | see other Trusted Contacts or other reporters |
| start a **new** case after a `CANCELLED` / `REJECTED` one | verify, reject, release or mark anyone `PASSED` |
| accept or decline their invitation | bypass the safety notice, the safeguard or admin review; use any admin route |

"Report / verify death" here means **reporting and confirming the claim**: the report opens (or joins) a case that then
runs the same safety notice → safeguard → admin review. Only an admin's verification sets `VERIFIED`, `PASSED`,
`verifiedDeathAt` and activates ON_DEATH / AFTER_DEATH releases ([death-verification.md](death-verification.md)).

## 12. Deferred / not built

- ⏸️ **SMS OTP for mobile-only Trusted Contacts:** deferred (post-MVP). Sign-in is email only; a mobile-only contact
  cannot sign in yet.
- ⏸️ **SMS invitations:** deferred. No Twilio, no `SmsProvider`.
- Not built: Trusted Contact editing of Recipient details, any content access or sharing, evidence upload,
  second-contact confirmation logic.

Tests: `src/trusted-contact-auth/trusted-contact-auth.service.spec.ts`,
`src/trusted-contacts/trusted-contacts.service.spec.ts`, `src/trusted-contacts/trusted-contact-invitations.service.spec.ts`,
`test/trusted-contact-portal.e2e-spec.ts`, `test/trusted-contact-invitations.e2e-spec.ts` (maximum + invitations),
`test/death-verification.e2e-spec.ts` (new case after a closed one). Frontend: `e2e/trusted-contacts.spec.ts`.

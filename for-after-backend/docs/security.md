# 🔒 For After — Security

> The security principles, measures and practices across For After. Sections 14–17 describe what the Recipient Portal
> (Step 13), Trusted Contact portal (Step 14), death verification (Step 15) and admin backend (Step 16) actually enforce
> today.

| | |
|---|---|
| **Principles** | Defense in depth · assume breach · deny by default · `404` never `403` |
| **Related** | [Threat model](../threat-model.md) · [Admin backend](admin.md) · [Authentication](authentication.md) · [Authorization](authorization.md) · [Incident response](incident-response.md) |

## 🧭 Contents

| Foundations | Controls | Portals (as built) |
|---|---|---|
| [1 Philosophy](#1-security-philosophy) · [2 Passwords](#2-password-security) · [3 Sessions](#3-session-security) · [4 Encryption](#4-data-encryption) | [5 Rate limiting](#5-rate-limiting) · [6 Input validation](#6-input-validation) · [7 CORS](#7-cors-configuration) · [8 Headers](#8-http-security-headers) · [9 Idempotency](#9-idempotency-keys) · [10 Media](#10-media-security) · [11 Audit](#11-audit-logging) · [12 Dependencies](#12-dependency-security) · [13 Admin](#13-admin-security) | [14 Recipient Portal](#14-recipient-portal-step-13-as-built) · [15 Trusted Contacts & death reports](#15-trusted-contact-portal--death-reports-step-14-as-built) · [16 Death verification](#16-death-verification-step-15-as-built) · [17 Admin backend](#17-admin-backend-step-16-as-built) |

---

## 1. Security Philosophy

- **Defense-in-depth**: Rely on multiple overlapping security layers rather than a single point of failure.
- **Assume Breach**: Systems and architecture are built with the mindset that networks and components may be compromised.

## 2. Password Security

- **Hashing Algorithm**: Argon2id (memory-hard, resistant to GPU cracking). Cost factor of 12.
- **Complexity**: Minimum 8 characters required.
- **Data Handling**: Passwords are never returned in API responses or written to application logs.

## 3. Session Security

- **Cookies**: Sessions are maintained using `HttpOnly`, `Secure`, and `SameSite=Lax` cookies to mitigate XSS and CSRF.
- **Storage**: Server-side Redis sessions ensure tokens cannot be manipulated by the client.
- **Audit**: A secondary session table tracks hash, IP address, user agent, and expiry for robust session auditing and invalidation.

## 4. Data Encryption

- **In Transit**: All communication requires TLS 1.3.
- **At Rest**: AES-256 encryption applied at the database level and across S3/R2 storage buckets.
- **Media Access**: Direct media access uses signed URLs with strict, short-lived expiration windows.

## 5. Rate Limiting

We utilize `@nestjs/throttler` to mitigate brute-force and DDoS attempts:

- **Login**: 5 attempts per minute.
- **OTP Requests**: 3 requests per minute. *As built (Step 13):* Redis counters, 5 per email + 20 per IP per 15 minutes,
  verify 30 per IP per 15 minutes, 5 attempts per code (`docs/recipient-portal.md`).
- **Password Reset**: 3 requests per hour.
- **Death Reports**: 2 reports per day per user. *As built (Step 14):* one report per Trusted Contact per case (unique
  index), behind Trusted Contact OTP (5 requests per email + 20 per IP per 15 minutes, 5 attempts per code).
- **Export Jobs**: 1 per hour.

## 6. Input Validation

- **Backend**: Strict validation using `class-validator` and `class-transformer` on all Data Transfer Objects (DTOs). Unknown properties are stripped.
- **Frontend**: Form and API payload validation using `Zod`.
- **Database**: SQL injection is inherently prevented by relying on Prisma's parameterized queries.

## 7. CORS Configuration

- **Whitelist**: Strict origin whitelist allowing only `forafter.com.au` and `app.forafter.com.au` (along with standard localhost ports for dev).
- **Credentials**: `credentials: true` is enforced to allow the passing of secure cookies.

## 8. HTTP Security Headers

Implemented via `helmet`:
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Content-Security-Policy`: Strictly configured to prevent inline scripts and unauthorized external resources.

## 9. Idempotency Keys

Critical operations (e.g., processing a death report, releasing messages) require idempotency keys.
- **Example**: Message delivery uses a composite key `messageId + recipientId + scheduleId`.
- **Benefit**: Safely prevents duplicate operations if a network request is retried.

## 10. Media Security

- **Storage Access**: Direct S3/R2 signed URLs are used with strict expiration times. No buckets have public read access.
- **Video Delivery**: Video playback is secured via signed Mux / Cloudflare tokens.

## 11. Audit Logging

An append-only `AuditLog` table records critical actions (built in Step 16 for admin actions; see §17 and
[admin.md](admin.md#7-audit-log)).
- **Records include**: event type, actor type + id, subject type + id, a small scalar metadata map, an IP **prefix**
  (`/24` IPv4, `/48` IPv6, never the raw IP), a truncated user agent, and the timestamp.
- **Never includes**: passwords/hashes, OTPs, TOTP secrets, recovery codes, vault content, notes, URLs, cookies, tokens.
- **Retention**: never mutated or deleted. A PostgreSQL trigger rejects `UPDATE`/`DELETE`; no API route edits it.
- Customer-side events (`USER_CREATED`, `RECIPIENT_UPDATED`, `MESSAGE_RELEASED`, ...) are still Phase 23.

## 12. Dependency Security

- Automated `npm audit` on CI/CD.
- Scans using Snyk / Dependabot to catch vulnerabilities.
- Prisma ORM is pinned to `v7` to ensure predictable database interactions.

## 13. Admin Security

- **2FA** (built, Step 16): TOTP mandatory for `ADMIN`/`SUPER_ADMIN`; the password alone never creates a session.
- **Session lifetimes** (built, Step 16): 30-minute inactivity timeout for admin sessions; Customer sessions unchanged.
- **Monitoring** (planned): active IP monitoring and anomaly detection. Today: `ADMIN_MFA_FAILED` audit rows and logs.
- **Re-authentication** (planned): sensitive actions require the admin to re-enter their password and pass a 2FA check.

## 14. Recipient Portal (Step 13, as built)

Full design: `docs/recipient-portal.md`.

- **Separate principal.** Recipients are not Users: no password or account. Separate cookie `for_after_recipient_session`,
  separate Redis sessions (`for_after:recipient_sess:<sha256(id)>`), separate guard setting `req.recipient`. Customer and
  Recipient sessions never authorize each other's routes (`401`).
- **OTP.** 6 digits from `crypto.randomInt`; stored only as `HMAC-SHA256(RECIPIENT_OTP_PEPPER, challengeId:code)` in Redis
  with a TTL; timing-safe comparison; 5 attempts; single use. The app refuses to start without a 32+ character pepper.
- **Anti-enumeration.** `request-otp` always answers `202` with the same body; codes go only to emails with released content,
  without awaiting delivery. All verify failures are one generic `401`.
- **Authorization.** Only `RecipientMessageAccessGrant` rows (release-time snapshots) + `RELEASED` + not deleted, re-checked in
  PostgreSQL on each request. No authorization from client-supplied ids. Unauthorized content is `404`, never `403`.
- **Development OTP console delivery** is refused at startup unless `NODE_ENV=development`. Codes, hashes, the pepper, session
  ids, full emails, signed URLs and storage keys are never logged.
- **CSRF.** Same `SameSite=Lax` + CORS model as Customer sessions; login-CSRF on `verify-otp` is a known low-impact gap shared
  with Customer login (see the CSRF review in `docs/recipient-portal.md`).

## 15. Trusted Contact Portal & death reports (Step 14, as built)

Full design: `docs/trusted-contact-auth.md`, `docs/death-verification.md`.

- **Three principals, three cookies.** Customer `for_after_session`, Recipient `for_after_recipient_session`, Trusted Contact
  `for_after_trusted_contact_session`. Each guard reads only its own cookie and sets only its own request field
  (`req.user` / `req.recipient` / `req.trustedContact`); none authorizes another's routes (`401`). A Trusted Contact is not a
  User.
- **OTP.** Same shared engine as Step 13 (`src/otp-auth/`), with its own pepper `TRUSTED_CONTACT_OTP_PEPPER`, Redis namespace
  (`for_after:trusted_contact_*`), TTLs, attempt limit and rate limits. A Recipient challenge or session cannot authenticate a
  Trusted Contact, and the reverse. Console delivery is refused at startup unless `NODE_ENV=development`.
- **Anti-enumeration.** `request-otp` always answers `202` with the same body and never reveals whether the email is a Trusted
  Contact, for whom, or for how many Customers.
- **Relationship scoping.** Every portal query goes through `activeRelationship(email)`: TrustedContact email = session email,
  contact not deleted, Customer not deleted, re-read from PostgreSQL per request. Foreign or removed ids are `404`, never `403`.
- **Private-content isolation.** Trusted Contacts see a Customer display name, their own relationship label, a
  `hasPreservedContent` boolean and the case status. No Customer email/mobile/id, content, titles, counts, recipients or other
  reporters, before or after a report.
- **Reports are not verification.** Reporting never changes `User`, Messages, schedules, releases or access grants. One report
  per contact per case (unique index); DTO whitelist rejects `ownerUserId`, `status` and any other injected field.
- **Logging.** Ids, masked emails and categories only. Never OTPs (outside dev console), hashes, peppers, session ids or
  report notes.

## 16. Death verification (Step 15, as built)

Full design: `docs/death-verification.md`.

- **Report ≠ verification ≠ release.** No automatic path exists from a report to a death: not two reports, not an elapsed
  safeguard, not a confidence score. Only an `ADMIN`/`SUPER_ADMIN` calling `verify` on a `READY_FOR_REVIEW` case.
- **Safeguard cannot be skipped.** Verify requires the safety notice to have been sent and the stored `safeguardEndsAt` to
  have passed; there is no force flag. The window starts only after a successful notice, so a broken email provider can
  never shorten it. Console notice delivery refuses to start outside `NODE_ENV=development`.
- **Atomic decisions.** Confirm-alive, verify and reject are conditional updates in transactions: exactly one terminal
  decision wins; the others get `409`. Terminal cases never change through the API.
- **Admin authorization.** `AdminGuard` after `SessionAuthGuard`: role re-read from PostgreSQL each request; Customers get
  `403`; Recipient and Trusted Contact sessions `401`. Admins cannot self-register (role is set by an operator).
- **Deceased account lockout.** Verification sets `User.status = PASSED` in the same transaction: login returns the
  generic `403` and every existing Customer session gets `401` on the next request (the guard re-reads the user).
- **Death-trigger execution** requires an activation linked to a `VERIFIED` case, re-checked by the release worker under a
  row lock. Idempotent at every level (unique activation per Message, unique release per Message).
- **Data minimisation.** Customers see status + deadline; Trusted Contacts see status only; admins see reports, notes and
  the audit trail. The safety notice carries no report or content data. Admin decision notes and report notes are never
  logged; audit rows hold no free text.
- **Durable audit trail.** `DeathVerificationAuditEvent` rows for every step, written with the change they record.

## 17. Admin backend (Step 16, as built)

Full design: `docs/admin.md`.

- **Mandatory TOTP.** A correct admin password returns only a Redis challenge (`userId`, `purpose`, `attempts`,
  `createdAt`; 5 min). A session is created only after TOTP (`otplib`, ±30 s, time-step replay protection) or a
  one-time recovery code. 5 attempts per challenge, 20 per IP per 15 min (Redis), generic `401` for every failure.
- **Secrets at rest.** TOTP secrets are AES-256-GCM encrypted with the dedicated `ADMIN_TOTP_ENCRYPTION_KEY` (validated
  at startup, never logged, never derived from other secrets). Recovery codes (80-bit) are stored as SHA-256 only and
  shown once. Secrets, codes and challenge ids never reach logs or audit rows (unit-tested).
- **Admin sessions.** Own HttpOnly `for_after_admin_session` cookie (Lax, Secure in production) and Redis prefix,
  read only on admin routes, so it never mixes with a Customer session; the session proves MFA
  (`adminMfaVerifiedAt`) and expires after 30 minutes idle. Sessions without MFA state (pre-Step 16, or a Customer
  promoted mid-session) are destroyed. `AdminGuard` checks role **and** MFA on every admin route.
- **Least privilege.** `ADMIN` manages Customers only; `SUPER_ADMIN` also admins; nobody manages a `SUPER_ADMIN` or
  themselves. No role editing, account deletion or "release now" API exists. `PASSED` can never be reactivated.
- **Data minimisation.** Admin user views return account metadata and counts, never vault content, notes, secrets or
  URLs. Detail views of users and death cases are audited.
- **Queues.** A server-side allowlist maps public names to the app's own queues; failed-job reasons are sanitized (no
  URLs/credentials/stack traces); a retry only re-queues and the worker re-checks PostgreSQL.
- **CSRF.** Same model as Customer routes (`SameSite=Lax` + CORS allowlist + JSON). No token yet; tracked in Phase 05.
- **Known gaps.** Enrollment is trust-on-first-use (promote only when the owner enrolls immediately); no MFA reset API
  (operator procedure in `docs/admin.md` §3); password-login throttle is in memory per instance.

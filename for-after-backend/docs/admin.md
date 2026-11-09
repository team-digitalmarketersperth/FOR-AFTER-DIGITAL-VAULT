# 🛡️ For After — Admin Backend (Step 16)

> The admin API: mandatory TOTP sign-in, hardened admin sessions, user search and suspension, a generic append-only
> audit log, queue monitoring with failed-job retry, and the Step 15 death-verification review. The admin UI
> (**FE-28**) is the Admin Portal in `for-after-frontend` (Step 20, `/admin`; see its README).

| | |
|---|---|
| **Built** | Admin TOTP + recovery codes, admin idle timeout, `AdminGuard` (role + MFA), dashboard, users (list/search/detail/suspend/reactivate), `AuditLog` + viewer, queue summary / failed jobs / retry, durable dead letters + operator alerts (Phase 17A), paginated + audited death-verification admin routes |
| **Deferred** | Subscriptions (needs Stripe, Phase 21), deliveries (needs the delivery worker, Phase 17/20), re-authentication for sensitive actions, admin MFA reset/re-enrollment API, role management, account deletion (Phase 23), CSRF tokens (Phase 05) |
| **Code** | `src/admin-auth/` · `src/admin/` · `src/audit/` · `src/auth/guards/` |
| **Related** | [Authentication](authentication.md) · [Authorization](authorization.md) · [Security](security.md) · [Death verification](death-verification.md) · [API](api.md) |

## 🧭 Contents

1. [Roles](#1-roles)
2. [Admin sign-in with TOTP](#2-admin-sign-in-with-totp)
3. [Enrollment and recovery codes](#3-enrollment-and-recovery-codes)
4. [Admin sessions and AdminGuard](#4-admin-sessions-and-adminguard)
5. [Endpoints](#5-endpoints)
6. [User management](#6-user-management)
7. [Audit log](#7-audit-log)
8. [Queue monitoring and failed-job retry](#8-queue-monitoring-and-failed-job-retry)
9. [Privacy boundaries](#9-privacy-boundaries)
10. [Configuration](#10-configuration)
11. [Provisioning admins (bootstrap)](#11-provisioning-admins-bootstrap)
12. [Manual test with Postman](#12-manual-test-with-postman)
13. [Known limits and open decisions](#13-known-limits-and-open-decisions)
14. [Overview (dashboard)](#14-overview-dashboard)
15. [Admin roadmap (future steps)](#15-admin-roadmap-future-steps)
16. [Release monitoring](#16-release-monitoring)
17. [Delivery monitoring](#17-delivery-monitoring)
18. [Admin response caching](#18-admin-response-caching)
19. [System health](#19-system-health)
20. [Security activity](#20-security-activity)
   - 20a. [Temporary IP blocks](#20a-temporary-ip-blocks)
21. [Storage and scans](#21-storage-and-scans)
22. [Admin access](#22-admin-access)

---

## 1. Roles

Admins are ordinary `User` rows with role `ADMIN` or `SUPER_ADMIN`. There is no separate admin identity, no admin
sign-up and no role-editing API. Recipients and Trusted Contacts are separate principals and can never reach admin
routes (their cookies are never read there).

| Action | ADMIN | SUPER_ADMIN |
|---|:--:|:--:|
| Dashboard, user list/detail, audit log, queues, death-verification review | ✅ | ✅ |
| Suspend / reactivate a `CUSTOMER` | ✅ | ✅ |
| Suspend / reactivate an `ADMIN` | ❌ `403` | ✅ |
| Suspend / reactivate a `SUPER_ADMIN` | ❌ `403` | ❌ `403` |
| Change own status | ❌ `403` | ❌ `403` |

No one can suspend a `SUPER_ADMIN` through the API, so the last `SUPER_ADMIN` can never be locked out this way.

---

## 2. Admin sign-in with TOTP

A correct admin password alone never creates a session.

```text
POST /auth/login (email + password)
  │  Customer ──► session + user (unchanged)
  │  ADMIN / SUPER_ADMIN ──► { mfaRequired: true, mfaSetupRequired, challengeId, expiresInSeconds }
  │                          no cookie; Redis challenge only
  ▼
first time:  POST /admin-auth/totp/setup   { challengeId }        → { secret, otpauthUri }  (shown once)
             POST /admin-auth/totp/confirm { challengeId, code }  → session + 10 recovery codes (shown once)
enrolled:    POST /admin-auth/totp/verify  { challengeId, code }  → session
lost device: POST /admin-auth/recovery/verify { challengeId, recoveryCode } → session
  ▼
for_after_admin_session with adminMfaVerifiedAt + lastActivityAt  →  AdminGuard
```

**Challenge** (Redis `for_after:admin_auth:challenge:<challengeId>`, TTL `ADMIN_TOTP_CHALLENGE_TTL_SECONDS`): only
`userId`, `purpose`, `attempts`, `createdAt`. Never the password, a code, the TOTP secret or a session id. The id is 32
random bytes (base64url) and logs show only its first 8 characters.

**Every step re-reads the user** from PostgreSQL: if the account is no longer an `ACTIVE` `ADMIN`/`SUPER_ADMIN`, the
challenge is deleted and the step fails.

**Verification rules**

| Rule | As built |
|---|---|
| Library | `otplib` 13 (`verify`), SHA-1, 6 digits, 30 s period (authenticator-app defaults) |
| Clock window | `epochTolerance: 30` seconds = the current step and one either side (RFC 6238 §5.2). No wider |
| Replay | `AdminMfaCredential.lastUsedTimeStep`; a conditional `updateMany` accepts only a strictly newer step, so the same code (or an older one) is refused even with a new challenge and under concurrency. The enrollment code counts too |
| Single use | the challenge is deleted by the request that succeeds; a concurrent second request fails |
| Attempts | `ADMIN_TOTP_MAX_ATTEMPTS` (5) per challenge, counted atomically with the read; the last failure deletes it and the password is needed again |
| IP limit | `ADMIN_TOTP_VERIFY_IP_LIMIT` (20) per IP per 15 min, in Redis (shared by all instances), for confirm/verify/recovery; `429` |
| Password limit | `/auth/login` keeps its 5/min per IP throttle (in memory per instance; see Phase 04) |
| Errors | one generic `401` for wrong, expired, unknown, reused, replayed and exhausted codes. A wrong password is the same `401` as for Customers, so nothing reveals that an admin account exists |
| Input | TOTP and recovery codes use separate routes and DTOs: `code` must be 6 digits, `recoveryCode` 16 characters (hyphens/spaces/case ignored); anything else is `400` |

---

## 3. Enrollment and recovery codes

- **Setup** generates a 160-bit secret (`generateSecret()`), stores it **AES-256-GCM encrypted** in
  `AdminMfaCredential.totpSecretEncrypted` with `enabledAt = null`, and returns `secret` + `otpauthUri` once. Calling
  setup again before confirm replaces the secret. After enrollment setup returns `409`.
- **Confirm** checks a current code, then in one transaction sets `enabledAt`, `lastUsedTimeStep`,
  `User.twoFactorEnabled = true`, replaces the recovery codes and writes `ADMIN_MFA_SETUP_COMPLETED`.
- **Encryption**: key `ADMIN_TOTP_ENCRYPTION_KEY` (32 random bytes, base64), dedicated. It is never derived from
  `SESSION_SECRET`, an OTP pepper or `DATABASE_URL`. Format `v1.<iv>.<tag>.<ciphertext>` (random 12-byte IV, auth tag,
  so a tampered row fails to decrypt). Startup fails with a clear message (never echoing the value) when the key is
  missing, not 32 bytes, or an obvious placeholder.
- **Recovery codes**: 10 per enrollment, 80 bits each (`XXXX-XXXX-XXXX-XXXX`), returned once by confirm. Only a SHA-256
  of each is stored (`AdminMfaRecoveryCode.codeHash`, unique). A conditional update marks one `usedAt`, so each works
  exactly once. Every use is audited (`ADMIN_RECOVERY_CODE_USED`, with the remaining count) and logged as a warning.

> ⚠️ **Enrollment is trust-on-first-use.** Until an admin confirms TOTP, their password alone can enroll a device. In
> production, promote an account to admin only when its owner is ready to enroll immediately, and verify enrollment
> (`GET /admin/users/:id` → `mfaEnabled`). There is no API to reset an admin's MFA yet; an operator deletes the
> `AdminMfaCredential` row (and recovery codes) after verifying identity out of band. Rotating
> `ADMIN_TOTP_ENCRYPTION_KEY` forces every admin to re-enroll.

---

## 4. Admin sessions and AdminGuard

Admins have their own cookie, **`for_after_admin_session`** (Step 23 follow-up; same flags as the Customer cookie:
HttpOnly, `SameSite=Lax`, `Secure` in production, same domain and TTL) in its own Redis namespace
(`for_after:admin_sess:`). One dispatcher in `configureApp` gives `/api/v1/admin/*` and `/api/v1/admin-auth/*` only the
admin session and every other route only the Customer session (`for_after_session`), so a Customer and an admin can be
signed in in the same browser profile, and neither's sign-in, logout or expiry touches the other. After a successful
second factor the admin session id is regenerated and holds `userId`, `role`, `adminMfaVerifiedAt` and
`lastActivityAt`. Nothing else. The password step still creates no session or cookie.

**`SessionAuthGuard`** (every User route) re-reads the user and, for `ADMIN`/`SUPER_ADMIN` only:

- no `adminMfaVerifiedAt` (a pre-Step-16 session, or a Customer promoted mid-session) → session destroyed, `401`;
- idle longer than `ADMIN_SESSION_IDLE_TIMEOUT_SECONDS` (1800) → session destroyed, `401`, log `admin_session_expired`;
- otherwise `lastActivityAt` is refreshed.

Customer sessions are unchanged (no idle timeout).

**`AdminGuard`** (after `SessionAuthGuard`) requires role `ADMIN`/`SUPER_ADMIN` **and** `adminMfaVerifiedAt`, so an
admin route is never reachable on role alone. A Customer, Recipient or Trusted Contact cookie is never read on admin
routes (`401`, like no session); an admin cookie is never read on Customer routes (`401`).

**Logout** is `POST /admin-auth/logout`: destroys the admin session, clears `for_after_admin_session` and writes
`ADMIN_LOGOUT`. `POST /auth/logout` ends only the Customer session. Neither ends the other.

---

## 5. Endpoints

All under `/api/v1`. Every `/admin/*` route: `SessionAuthGuard` + `AdminGuard`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login` | Customers unchanged; admins get an MFA challenge |
| `POST` | `/admin-auth/totp/setup` | `{ challengeId }` → `{ secret, otpauthUri }`; first enrollment only (`409` after) |
| `POST` | `/admin-auth/totp/confirm` | `{ challengeId, code }` → admin profile + `recoveryCodes` (once) + session |
| `POST` | `/admin-auth/totp/verify` | `{ challengeId, code }` → admin profile + session |
| `POST` | `/admin-auth/recovery/verify` | `{ challengeId, recoveryCode }` → admin profile + `remainingRecoveryCodes` + session |
| `GET` | `/admin-auth/me` | `id, email, firstName, lastName, role, mfaEnabled, mfaVerified, mfaVerifiedAt` |
| `POST` | `/admin-auth/logout` | ends only the admin session; audited `ADMIN_LOGOUT` |
| `GET` | `/admin/dashboard` | Overview counts and service checks (§14): customers, open death cases, past-due releases, release emails, queues, dead letters |
| `GET` | `/admin/releases` | release monitoring list (§16): `page, limit (≤100), status, triggerType, scheduledFrom, scheduledTo, reference, accountId, pastDue, sort, dir` |
| `GET` | `/admin/releases/:reference` | one Message's release metadata and recorded history (§16); logged |
| `GET` | `/admin/deliveries` | delivery monitoring list (§17): `page, limit (≤100), category, status, outcomeUncertain, errorCategory, reference, releaseReference, createdFrom, createdTo, sort, dir` |
| `GET` | `/admin/deliveries/release-emails/:reference` | one release email: stored fields, optional queue state, dead letters (§17); logged |
| `GET` | `/admin/deliveries/safety-notices/:reference` | one case's safety notice (§17); logged |
| `GET` | `/admin/system/health` | System Health (§19): this API instance's checks + worker heartbeats; no input |
| `GET` | `/admin/security/events` | Security Activity (§20): security audit rows, explicit fields, filters, window counts; logged |
| `GET` | `/admin/security/events/:reference` | one security event (§20); non-security audit rows are 404 |
| `GET` | `/admin/storage/assets` | Storage & scans (§21): stored-file metadata across the six media tables, per-area totals; logged |
| `GET` | `/admin/storage/assets/:reference` | one stored-file record (§21) |
| `GET` | `/admin/support/requests` | Support inbox (`docs/support.md`): paginated, filters by status/category/reference/account/date |
| `GET` | `/admin/support/requests/:id` | one request: public conversation and internal notes, apart |
| `POST` | `/admin/support/requests/:id/replies` | reply to the Customer (public; status unchanged); audited |
| `POST` | `/admin/support/requests/:id/notes` | internal note (admins only); audited |
| `PATCH` | `/admin/support/requests/:id/status` | `{ status, expectedStatus }`; 409 if changed meanwhile; audited |
| `GET` | `/admin/access/admins` | Admin access (§22): admin accounts, role, status, two-factor enrolment, last admin sign-in; read-only |
| `GET` | `/admin/access/admins/:id` | one administrator: effective permissions, access history (explicit fields); read-only |
| `GET` | `/admin/system/ai` | AI operations (`docs/assistant.md` §8): `window=24h\|7d`, `area`, `action`; aggregates only, never a provider call |
| `GET` | `/admin/users` | `page, limit (≤100), search, status, role` |
| `GET` | `/admin/users/:userId` | account metadata + counts; audited |
| `POST` | `/admin/users/:userId/suspend` | `{ reason }` (required, ≤1000) |
| `POST` | `/admin/users/:userId/reactivate` | `{ reason? }` |
| `GET` | `/admin/audit-logs` | `page, limit, eventType, actorUserId, subjectType, subjectId, from, to` |
| `GET` | `/admin/audit-logs/:auditLogId` | one row |
| `GET` | `/admin/system/queues` | per queue: `waiting, active, delayed, prioritized, failed, completed` |
| `GET` | `/admin/system/queues/:queueName/failed` | `page, limit`; sanitized |
| `POST` | `/admin/system/queues/:queueName/jobs/:jobId/retry` | failed jobs only |
| `GET` | `/admin/system/dead-letters` | Phase 17A; `queue, status, from, to, page, limit` |
| `GET` | `/admin/system/dead-letters/:deadLetterId` | Phase 17A; ids + sanitized error |
| `POST` | `/admin/system/dead-letters/:deadLetterId/retry` | Phase 17A; `OPEN` only; audited |
| `GET` | `/admin/death-verifications` | Step 15; now `{ items, pagination }` with `status, page, limit` |
| `GET` | `/admin/death-verifications/:caseId` | Step 15; now audited |
| `POST` | `/admin/death-verifications/:caseId/verify` \| `/reject` | Step 15, unchanged rules; now also in `AuditLog` |

Lists return `{ items, pagination: { page, limit, total, pages } }`, default `limit` 25, maximum 100. Unknown query
fields are `400` (global whitelist pipe). Invalid UUIDs are `400`, unknown ids `404`.

> ⚠️ **Contract change:** `GET /admin/death-verifications` returned a bare array in Step 15. It now returns
> `{ items, pagination }`, like every admin list. The only consumers were tests and Postman, which were updated.

**Dashboard** returns only numbers backed by real tables:

```json
{
  "users": { "total": 13, "active": 12, "suspended": 0, "passed": 1, "deleted": 0 },
  "deathVerification": { "pending": 0, "safeguardActive": 1, "readyForReview": 2 },
  "queues": { "failed": 0 }
}
```

`queues.failed` is `null` (not `0`) when Redis cannot be read. There are **no subscription or delivery figures**:
billing and delivery do not exist yet (see §13).

---

## 6. User management

- **Search** is case-insensitive `contains` on `email`, `firstName`, `lastName` only, never content. Admin search
  intentionally allows account discovery (it is an authorized operational tool); it is paginated and the sensitive
  detail view is audited.
- **Detail** returns account metadata (`status`, `role`, `emailVerifiedAt`, `passedAt`, `deletedAt`, `mfaEnabled`,
  timestamps), counts (`recipientCount`, `trustedContactCount`, `messageCount`, `releasedMessageCount`,
  `memoryVaultCount`, non-deleted only) and `deathVerification: { caseId, status } | null`.
- **Suspend**: `ACTIVE → SUSPENDED` only. **Reactivate**: `SUSPENDED → ACTIVE` only. Both are one conditional update in a
  transaction with the audit row, so a concurrent change (including a death verification setting `PASSED`) wins cleanly
  and the loser gets `409`. `PASSED` (verified death) and `DELETED` can never be changed here (`409`).
- **Effect** is immediate: `SessionAuthGuard` re-reads status on every request, so an existing session gets `401` on its
  next request and a new login gets `403`. Reactivated users sign in normally.
- **Suspended accounts and death verification**: unchanged Step 14/15 rules. A report can still be filed and verified
  for a suspended Customer; Trusted Contact OTP eligibility already requires an *active* Customer. Whether suspension
  should pause death verification is an **open product decision** (task.md Phase 01).

---

## 7. Audit log

`AuditLog` is the generic, append-only trail (Phase 23 foundation). `DeathVerificationAuditEvent` stays as the
per-case domain history.

| Column | Meaning |
|---|---|
| `eventType` | see below |
| `actorType`, `actorUserId` | `ADMIN` or `SUPER_ADMIN` and the admin's id, or (Step 22) `CUSTOMER` and the Customer's own id (plain id, no FK, survives deletions) |
| `subjectType`, `subjectId` | e.g. `User` / `DeathVerificationCase` / `Job` and its id |
| `ipPrefix` | IPv4 `/24` or IPv6 `/48` (e.g. `203.0.113.0/24`). **Never the raw IP** |
| `userAgent` | truncated to 256 characters |
| `metadata` | small scalar map, e.g. `{ previousStatus, newStatus, reason }` |

**Events written in Step 16**: `ADMIN_PASSWORD_AUTH_SUCCEEDED`, `ADMIN_MFA_SETUP_COMPLETED`, `ADMIN_MFA_VERIFIED`,
`ADMIN_MFA_FAILED` (with `reason`: `wrong_code`, `replay`, `attempts_exhausted`, ...), `ADMIN_RECOVERY_CODE_USED`,
`ADMIN_LOGIN`, `ADMIN_LOGOUT`, `USER_SUSPENDED`, `USER_REACTIVATED`, `ADMIN_VIEWED_USER`, `ADMIN_VIEWED_DEATH_CASE`,
`DEATH_VERIFICATION_VERIFIED`, `DEATH_VERIFICATION_REJECTED`, `FAILED_JOB_RETRIED`. No historic events were
back-filled. **Step 22** adds `PASSWORD_CHANGED` (actor `CUSTOMER`, subject the same `User`, no metadata). Aggregate reads (lists, dashboard, queue counts) are logged, not audited, to keep the trail meaningful. **Step 7 (support)** adds `SUPPORT_REQUEST_CREATED` (actor `CUSTOMER`, metadata `category`), `SUPPORT_REPLY_SENT`, `SUPPORT_NOTE_ADDED` and `SUPPORT_STATUS_CHANGED` (`previousStatus`, `newStatus`), subject `SupportRequest`; never subjects or text (`docs/support.md`).

**Safety**
- Status changes, enrollment, recovery-code use and death decisions write their row **in the same transaction** as the
  change.
- Metadata is typed as scalars only, and keys that look like secrets or content (`pass`, `secret`, `token`, `code`,
  `otp`, `cookie`, `session`, `note`, `content`, `answer`, `url`, `key`) are dropped even if a caller passes them.
  Never stored: passwords/hashes, OTPs, TOTP secrets, recovery codes, Message/My Story/My Wishes text, private notes,
  presigned URLs, cookies, tokens, report or decision notes.
- The suspension `reason` is stored in `metadata` (it is the admin's own justification, not customer content) and never
  logged.
- **Append-only**: no update/delete in code or routes, and a PostgreSQL trigger (`AuditLog_append_only`) rejects
  `UPDATE` and `DELETE`. `TRUNCATE` by a database operator is still possible. Test runs therefore leave their audit
  rows behind (fictional ids only).

---

## 8. Queue monitoring and failed-job retry

The allowlist maps stable public names to the application's own `Queue` instances, so a request can never name an
arbitrary Redis key:

| Public name | Queue | Env |
|---|---|---|
| `message-release` | Step 12 release jobs (FIXED_DATE and death-trigger activations) | `RELEASE_QUEUE_NAME` |
| `death-verification` | Step 15 safeguard jobs | `DEATH_VERIFICATION_QUEUE_NAME` |
| `email-delivery` | Step 24 "a message is waiting" emails; payload `{ notificationId }` only, shown as "Email <id>" ([email setup](email-production-setup.md)) | `EMAIL_QUEUE_NAME` |

Any other name → `404`. Redis errors → `503 Queue data is unavailable.` (the error text, which can include the host, is
logged only as a code).

**Failed jobs** show `jobId, queue, name, attemptsMade, maxAttempts, failedReasonSanitized, createdAt, failedAt,
payload`. The reason is the first line only, with URLs → `[url]` and email addresses → `[email]`, max 200 characters.
Stack traces are never returned. `payload` contains only `messageId`/`caseId` when it is a valid UUID (payloads are
id-only by design anyway).

**Retry** (`FAILED_JOB_RETRIED` audited): only a job in state `failed` (else `409`); job ids must match
`[A-Za-z0-9_-]{1,200}` (`400`). It calls BullMQ `job.retry('failed', { resetAttemptsMade: true })`. **It never
releases anything itself**: the worker re-reads PostgreSQL exactly as for any job, so a stale, cancelled, already
released or not-yet-due Message stays protected. There is no admin "release now" endpoint and none may be added.

**Dead letters (Phase 17A).** A job whose automatic retries are exhausted (its last attempt, or an
`UnrecoverableError` such as a permanent email error) gets one durable `DeadLetterJob` row in PostgreSQL, unique per
`(queueName, jobId)` (DB constraint). Ordinary retry attempts record nothing and alert nobody. Detection is BullMQ's
Worker `failed` event (emitted after **every** attempt in 6.x) filtered to the terminal one, wired once per worker by
`DeadLetterService.watch`. BullMQ's `failed` set (7 days, above) stays as a short-term view; the row is the record and
is kept (no retention rule yet: a product/ops decision, not invented here).

| Field | Content |
|---|---|
| ids | `queueName` (public name), `jobId`, `jobName`, `entityType` + `entityId`: `Message`, `MessageRecipientRelease`, `DeathVerificationCase` or `ReleaseNotification` (no FK: the record outlives the entity) |
| failure | `attemptsMade`, `errorCode` (safe category: provider/Prisma/driver code or error class), `errorMessage` (the failed-jobs sanitizer above, plus `secret=value` and `Bearer` redaction), `failedAt`, `failureCount` |
| state | `status` `OPEN` → `REQUEUED` → `RESOLVED`, `resolution` (the worker's outcome: `released`, `sent`, `stale`, `already_sent`, …), `requeuedAt`, `resolvedAt` |
| alert | `alertStatus` `PENDING` / `SENT` / `FAILED` / `NOT_CONFIGURED`, `alertedAt` |

Never stored: the job payload, message content, addresses, notes, OTPs, URLs, stack traces or provider responses.

- `GET /admin/system/dead-letters`: `queue, status, from, to` (ISO, on `failedAt`), `page, limit`; newest first.
- `GET /admin/system/dead-letters/:deadLetterId`.
- `POST /admin/system/dead-letters/:deadLetterId/retry` (audited `DEAD_LETTER_RETRY_REQUESTED`, metadata
  `queue, jobId, outcome` only): only `OPEN` (else `409`; two admins at once → exactly one wins). The row is claimed
  `OPEN → REQUEUED` first, then the job is queued again through the queue's own helper, derived from the entity id in
  PostgreSQL (`MessageReleaseQueue.ensure` / `ensureOccurrence`, `DeathVerificationQueue.requeueSafeguard`,
  `ReleaseNotificationQueue.requeue`), never from a stored payload. Entity gone → `RESOLVED` / `stale`, nothing queued.
  Redis down → back to `OPEN`, `503`.
- Any later **completed** run of that job id (this retry, the failed-job retry above, or the release reconciler
  re-queueing a still-`SCHEDULED` message) marks the row `RESOLVED` with the worker's outcome. A new terminal failure
  after that reopens it (`failureCount + 1`) and alerts once more; a failure while still `OPEN` only counts; the same
  failure seen twice (same `failedAt`) changes nothing.
- The worker still makes every business decision, so stale, cancelled, already-released, terminal death cases and
  already-`SENT` emails are no-ops.

**Operational alert.** One per transition into `OPEN`, sent directly with `EmailProvider` to `OPS_ALERT_EMAIL`
(subject "For After queue failure requires attention"; queue, job id, entity, failed at, attempts, error code and
"Review Admin → Queues"; no content and not even the sanitized message). One attempt, idempotency key
`dead-letter/<id>/<failureCount>`, **never through a queue**: if the provider is down, the `email-delivery` dead
letter is still recorded, its alert is `FAILED` and logged, and nothing loops or dead-letters the alert. Without
`OPS_ALERT_EMAIL` the alert is a log line (`ops_alert_not_configured`, `NOT_CONFIGURED`). Every dead letter also logs
`dead_letter_recorded` at error level (ids and code only). Admin Portal → Queues shows a **Dead letters** section
(status/queue filters, View, Retry on `OPEN` rows).

---

## 9. Privacy boundaries

Admins get operational account information, not vault content. No admin endpoint returns Message text or media,
Memory Vault entries, My Story or My Wishes answers, Recipient private notes, passwords or hashes, OTP details, TOTP
secrets or recovery hashes, session ids, or storage keys / signed URLs. Death-verification detail keeps its Step 15
scope (reports, notes and audit trail for the reviewing admin; never content). A future support workflow that needs
content access must be explicit, separately authorized and audited.

Errors never expose stack traces, Prisma internals or Redis error text (Nest's built-in exception handling for
unexpected errors plus explicit `503` for Redis in the queue monitor; the global exception filter is still Phase 03).

---

## 10. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_TOTP_ENCRYPTION_KEY` | none, **required** | 32 random bytes, base64 (`openssl rand -base64 32`). Startup fails without it |
| `ADMIN_TOTP_CHALLENGE_TTL_SECONDS` | `300` | password → second factor window |
| `ADMIN_TOTP_MAX_ATTEMPTS` | `5` | wrong codes per challenge |
| `ADMIN_TOTP_VERIFY_IP_LIMIT` | `20` | second-factor attempts per IP per 15 minutes |
| `ADMIN_SESSION_IDLE_TIMEOUT_SECONDS` | `1800` | admin inactivity timeout |
| `ADMIN_TOTP_ISSUER` | `For After` | label shown in authenticator apps |

Tests use a fixed, public key in `vitest.config.e2e.ts` (not a secret).

---

## 11. Provisioning admins (bootstrap)

Unchanged: there is no admin sign-up and `role` is rejected by `/auth/register`. An operator registers the account
normally, then:

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = 'admin.dev@example.test';
```

The next password login returns `mfaSetupRequired: true`; the admin enrolls (setup → confirm) and gets a session.
Existing admins after the Step 16 deploy follow the same path; any admin session created before Step 16 is refused
(`401`) because it has no MFA state.

---

## 12. Manual test with Postman

Folder **17-Admin-Backend** of the workspace collection (`D:\FOR-AFTER-DIGITAL-VAULT\postman\collections\FOR-AFTER`).
Folder 16's admin logins now include an "Admin - TOTP Verify" step.

1. Put `ADMIN_TOTP_ENCRYPTION_KEY` in `.env` and restart the API. Create the admin (§11).
2. **Admin - Password Login** → `200 { mfaRequired: true, mfaSetupRequired: true, challengeId }`; the challenge id is
   saved to `adminMfaChallengeId`. No cookie is set.
3. **Admin - TOTP Setup** → `secret` + `otpauthUri`. Add it to an authenticator app (scan the URI as a QR code, or type
   the secret). Optionally set `adminTotpSecret` as a **current** value (never initial) so the pre-request script can
   compute codes in the Runner.
4. Read the 6-digit code from the app. Without `adminTotpSecret`, type it into `adminTotpCode`.
5. **Admin - TOTP Confirm** → `200`, `recoveryCodes` (shown once: store them offline) and the `for_after_admin_session`
   cookie.
6. **Admin - /admin-auth/me** → `mfaVerified: true`.
7. Call the admin APIs (dashboard, users, audit, queues, death verification). Later sign-ins use **Admin - TOTP
   Verify**. A code works once per 30 s step, so wait for the next code if you just used one (the script waits for you).

---

## 13. Known limits and open decisions

- **Subscriptions**: read-only monitoring built in Step 10 (`docs/billing.md` §6, SUPER_ADMIN only); no refunds,
  charges, extensions or complimentary access. Billing stays disabled until its launch decisions are made.
- **Deliveries**: built read-only in Step 3 (§17) for the categories with durable records; see its coverage list.
- **Dead letters / alerts**: built in Phase 17A (§8). Known gaps: a job BullMQ fails as *stalled* (the worker
  process died mid-job beyond `maxStalledCount`) emits no Worker `failed` event, so it is not dead-lettered (the
  reconcilers still repair it from PostgreSQL); a crash between recording and alerting leaves `alertStatus`
  `PENDING` (visible, not re-sent); alerts are email only; no retention rule for dead-letter rows yet.
- **CSRF**: admin routes use the same model as Customer routes: `SameSite=Lax` cookies + a CORS allowlist
  (`FRONTEND_URL`, `WORDPRESS_URL`) + JSON bodies. Lax blocks cross-site `POST` cookies, and cross-origin JSON requests
  need a preflight the allowlist refuses. Residual risk: an XSS or compromised page on an allowlisted origin, and
  same-site subdomains. No CSRF token was added here, because a half-built token scheme would break the not-yet-built
  frontends; a token/`Origin` check remains the Phase 05 CSRF review item.
- **Re-authentication** for sensitive admin actions (`security.md` §13) is not built.
- **Admin MFA reset / re-enrollment API** and "regenerate recovery codes" are not built (operator procedure in §3).
- **Password-login throttle** is still in-memory per instance (Phase 04); MFA limits are already in Redis.
- **Suspension vs. death verification**: open product decision (§6).

## 14. Overview (dashboard)

`GET /admin/dashboard` (`AdminService.dashboard`, `SessionAuthGuard` + `AdminGuard`: an admin role **and** completed MFA;
anonymous, Customer, Recipient and Trusted Contact sessions get 401/403). Read-only: it queues, releases, sends and
audits nothing (aggregate reads are logged, not audited, §7). It returns counts and statuses only: no ids, names, emails,
content, notes, payloads, tokens or URLs. Admin UI: `/admin` (`overview.tsx`), refreshed on demand (no polling).

Each source is read on its own (`Promise.all` of independently caught reads): a section that cannot be read is `null`
and shown as **Unavailable**, never `0`; a real `0` stays `0`. A Redis failure leaves every PostgreSQL count intact.
`generatedAt` is the server's `now` (UTC ISO); every window is computed from it. Shown in the viewer's timezone.

| Field | Definition | Source | Window | On failure |
|---|---|---|---|---|
| `customers.total/active/suspended/passed/deleted` | `User` rows with `role = CUSTOMER`, by `status` (admins never counted; until 2026-10-30 this was every role) | `user.groupBy` | none | `customers: null` |
| `customers.newLast7Days` | `role = CUSTOMER` and `createdAt ≥ now − 168 h` (rolling, any current status) | `user.count` | 168 h | `customers: null` |
| `deathVerification.pending/safeguardActive/readyForReview` | cases in `PENDING_VERIFICATION`, `SAFEGUARD_ACTIVE`, `READY_FOR_REVIEW` (existing states only; no deadlines or SLAs) | `deathVerificationCase.groupBy` | none | `null` |
| `releases.pastDue` | **Messages** matching `pastDueWhere(now)` (§16): the release reconciler's own "due" rules with the horizon at `now`, for live `SCHEDULED` messages. Includes releases the worker refused (for example `blocked`: no live recipients), so it is "past due, not yet released", not "worker late". Since Step 2 a count of Messages (it was due items, one per yearly occurrence per recipient), so it always equals `/admin/releases?pastDue=true`; the breakdown fields were removed | `message.count` | `≤ now` | `null` |
| `releaseEmails.retrying` | `ReleaseNotification` `PENDING` with `attemptCount > 0`: an attempt failed and BullMQ will retry | `releaseNotification.count` | none | `null` |
| `releaseEmails.failed` | `ReleaseNotification` `FAILED`: retries exhausted or a non-retryable error (permanent). `SENT` means the provider accepted it, not delivered, and is not shown | `releaseNotification.count` | none | `null` |
| `queues.waiting/active/delayed/failed` | BullMQ counts summed over the allowlisted queues only (`message-release`, `death-verification`, `email-delivery`) | `AdminQueuesService.totals` (Redis, timeout) | none | `queues: null` |
| `deadLetters.open` | `DeadLetterJob` `status = OPEN` (index `(status, failedAt)`) | `deadLetterJob.count` | none | `null` |
| `services.*` | Since Step 4: the statuses of the shared System Health snapshot (§19): `database`, `redis` (`ok`/`failed`/`timed_out`), `worker` (`ok`/`stale`/`missing`/`unknown`), `malwareScanner` (`ok`/`failed`/`timed_out`/`not_configured`). One implementation for both pages | `SystemHealthService.check()` | 5 s snapshot | per service |

The UI also shows **API: Healthy**, meaning only that this request was answered. "Attention required" lists only
non-zero signals: ready-for-review cases, failed jobs and open dead letters (linked to the existing pages), failed and
retrying release emails (linked to `/admin/deliveries?status=…`, same definitions), past-due releases (linked to `/admin/releases?pastDue=true`), unavailable dependencies,
and sections that could not be loaded. "Nothing in these counts needs attention right now" appears only when every
section loaded, every count is zero and PostgreSQL and Redis are healthy. Links use only filters the target pages read
(`/admin/users?role=CUSTOMER&status=…`, `/admin/death-verifications?status=…`, `/admin/system/queues`).

**Not measured (gaps):** worker liveness, scanner health, held releases (no "held" state exists), uncertain delivery
outcomes (no tracking), upload/scan states (`MediaAssetStatus` has no scan state: `PENDING_UPLOAD` means not yet uploaded
and `FAILED` mixes malware and verification failures across five tables), registrations by date range on the Users page.

## 15. Admin roadmap (future steps)

Nothing below is built. Each step reuses the guards (§4), audit log (§7) and the privacy rules (§9).

| # | Step | Builds on | Needs first |
|---|---|---|---|
| 1 | **Release monitoring**: **built in Step 2 (§16)**: list, filters, detail and recorded history, read-only. Still open: *why* a past-due release is stuck | reconciler due queries, `releaseDueAt()`, dead letters | a persisted "last release outcome" per message (the worker's `blocked`/`stale` reasons are only logged today) |
| 2 | **Delivery monitoring**: **built in Step 3 (§17)** for release emails and safety notices, read-only, by reference (no addresses shown). Still open: invitations, OTPs, account emails and SMS (no durable records); real "delivered" | `ReleaseNotification`, case notice fields, email-delivery dead letters | privacy-reviewed send records for the other categories; provider delivery webhooks; per-attempt history |
| 3 | **Detailed system health**: **built in Step 4 (§19)**: worker heartbeat, scanner `PING`, compact Overview summary. Still open: queue lag, history, other API replicas | `HealthService`, `AdminQueuesService`, ClamAV adapter | per-replica reporting; an expected-worker-count setting if wanted |
| 4 | **Security activity**: **built in Step 5 (§20)** over existing `AuditLog` rows, read-only. Still open: customer/recipient/trusted-contact sign-in failures, OTP failures and limits, throttling and Origin rejections (not durably recorded) | `AuditLog` | a bounded, aggregated security-event record for rejection paths; agreed alert thresholds (none invented) |
| 5 | **Storage and scans**: **built in Step 6 (§21)**: records by area/state, quota-consistent totals, removal state, read-only. Still open: per-file scan result/reason/time, provider inventory reconciliation | `StorageQuota` definitions, `MediaCleanup` markers, the six media tables | an explicit scan state (or reason) on media rows; a provider inventory job |
| 6 | **Support**: **built in Step 7** (`docs/support.md`): Customer requests and follow-ups, admin inbox, public replies, internal notes, status. Still open: retention policy, notifications, assignment | `SupportRequest`, `SupportMessage`, `SupportInternalNote` | a retention decision; notification copy if wanted |
| 7 | **AI operations**: **built in Step 8** (`docs/assistant.md` §8): configuration presence, observed outcomes, attempts/retries, mean latency with samples, reported token usage, application limits; Redis hourly aggregates (8 days). Still open: cost (no verified pricing), percentiles, provider quota | `AssistantMetrics` (Redis) | verified pricing per model if a cost estimate is wanted |
| 8 | **Admin access**: **built read-only in Step 9 (§22)**: admins, roles, status, two-factor enrolment, last admin sign-in, effective permissions, access history. Still open: role changes, MFA re-enrolment/reset, recovery-code regeneration, provisioning in the app | `canManage`, `AdminGuard`, `AuditLog` | step-up re-authentication (§13) and an agreed role-change/grant policy |
| 9 | **Billing**: **built in Step 10, disabled by default** (`docs/billing.md`): Subscriptions & payments (SUPER_ADMIN, read-only) and a Users billing summary. Still open: launch decisions in `billing.md` §1 | `BillingAccount`, `CustomerTrial`, Stripe webhooks | the §1 decisions and a Stripe test-mode run |

## 16. Release monitoring

`/admin/releases` (Operations → Releases; `releases.tsx`) over `GET /admin/releases` and `GET /admin/releases/:reference`
(`AdminReleasesService`, `SessionAuthGuard` + `AdminGuard`: admin role **and** completed MFA; Customer, Recipient, Trusted
Contact and anonymous sessions get 401). GET only, PostgreSQL only (works with Redis down), `Cache-Control: no-store`
(the shared admin policy, §18).

**Read-only guarantee.** List, detail, filters and refresh never release, enqueue, retry, send, verify, change a
safeguard, cancel, reschedule, change an account or sign a URL. The service has no queue, Redis, email or storage
dependency and calls only `findMany`, `findFirst`, `count` and `groupBy` (the unit test's Prisma fake fails on anything
else); the e2e test checks that releases, notifications, grants and message statuses are unchanged after reading. The
detail view is written to the application log (`admin_release_viewed`). That is **not** a durable audit event (logs
rotate and are not the `AuditLog` table); a new `AuditEventType` and its migration are deferred to a separate task.

**One row per Message** that is `SCHEDULED`, `RELEASED` or `CANCELLED` and not deleted (drafts are not release work;
unscheduling returns a message to `DRAFT`, and `CANCELLED` is reserved and currently unused).

**Privacy boundary.** Ids, enums, counts and stored timestamps only, selected explicitly: no title, text, files, notes,
event label, anniversary date, recipient name or contact, evidence, payload, provider error text (`errorMessage` is never
selected; dead letters show only their `errorCode` category) or URL. The account is its User id (link to the existing
Users page, which keeps its own audited view). No text search exists.

**Current assessment** (computed per request at `evaluatedAt`, never persisted; the worker re-checks everything in its own
transaction before releasing, so this is a snapshot, not permission):

| Assessment (label) | When |
|---|---|
| `released` (Released) | `Message.status = RELEASED` |
| `cancelled` (Cancelled) | `Message.status = CANCELLED` |
| `past_due` (Past due, not yet released) | `SCHEDULED` and the reconciler's due rule holds at `now` (`pastDueWhere`, shared with the Overview): FIXED_DATE/CUSTOM_EVENT `scheduledFor ≤ now`; NOW; a pending yearly occurrence with `dueAt ≤ now`; or an ON_DEATH/AFTER_DEATH activation with a `VERIFIED` case and `dueAt ≤ now` |
| `recurring` (Recurring) | BIRTHDAY / ANNIVERSARY, or ANNUAL_AFTER_DEATH after activation, with no occurrence due yet |
| `awaiting_death_verification` (Waiting for a verified death) | ON_DEATH / AFTER_DEATH where `releaseDueAt()` (the release service's own pure policy function) gives no date, or ANNUAL_AFTER_DEATH without an activation. Never past due because of age. The owner's newest open case status and safeguard end are shown alongside |
| `scheduled` (Scheduled) | anything else not yet due |
| `no_schedule` (Scheduled, no schedule found) | `SCHEDULED` with no `MessageSchedule` row (the worker would report it stale) |

**Overdue.** No reliable "overdue" definition exists (no threshold anywhere in the engine), so none is invented:
`past_due` is factual ("due, no release recorded"). It includes releases the worker refused (`blocked`: no live
recipients) or found stale; those reasons are only logged, never stored, so the page shows **"Reason not recorded"** and
does not guess. Worker behaviour and outcome persistence are unchanged by this page. The detail shows the live recipient count as a fact. Edge: if a death activation's trigger no longer matches
the schedule's, the reconciler (and this page) count it as due while the release service reports it stale.

**Filters** (all allowlisted and validated, server-side, `page`/`limit ≤ 100`): `status` (SCHEDULED, RELEASED,
CANCELLED), `triggerType`, `scheduledFrom`/`scheduledTo` (ISO; on `MessageSchedule.scheduledFor`, so fixed-date and
custom-event schedules; reversed range 400; the UI sends local calendar days as start/end-of-day instants), `reference`
(exact Message id), `accountId` (exact User id), `pastDue=true` (the Overview's definition). Sort: `updatedAt`
(default, desc), `createdAt`, `scheduledFor` (nulls last), each `asc`/`desc`, always with `id` as the tie-breaker.
Filters live in the URL; applying them resets to page 1.

**Timestamps** (UTC in the API, shown in the viewer's timezone): *Scheduled for* = the stored schedule instant (or the
one copied onto the release); *Released* = `MessageRelease.releasedAt`; *Last recorded* = the latest of the schedule's
`updatedAt`, `releasedAt` and the death activation's `activatedAt` (never content edits); *Assessed* = `evaluatedAt`.

**Detail** adds: schedule (`triggerType`, `scheduledFor`, `afterDeathDays`, created/updated), the release record (id,
time, trigger used, access-grant count), the death activation and the owner's newest case (links to the case and to its
audit events, `/admin/audit-logs?subjectType=DeathVerificationCase&subjectId=…`), yearly occurrence counts, release
email counts (waiting, retrying, accepted by the provider, failed; accepted is not delivered), up to 20 dead letters
for this message's release, occurrence and email jobs (link to `/admin/system/queues?dlQueue=…`), and the **recorded
history**: only events with a stored time (current schedule saved/changed, death trigger activated, release recorded,
the last 10 yearly occurrences, dead letters). Earlier schedules replaced by a change and worker refusals are not
stored, so they are not shown; an empty history says so.

**Indexes (evaluated 2026-10-30, no index added).** Read-only `EXPLAIN` on the development database (96 Messages,
57 listed; 24 release emails): every list query plans as a sequential scan plus a top-N sort, which is the cheapest plan
at this size, so a new index would not be used. Filtered paths already have indexes for when they are needed:
account → `Message(ownerUserId, status)`; email status → `ReleaseNotification(status, createdAt)`; release →
`RecipientMessageAccessGrant(messageId)` + `ReleaseNotification(grantId)`; schedules, activations and occurrences by
their keys. Not covered by an index: the two **unfiltered** default sorts (releases by `updatedAt`, deliveries by
`createdAt` without a status). Remaining requirement: when those tables reach tens of thousands of rows, measure the
endpoints' p95 and, only if needed, add `Message(status, updatedAt, id)` / `ReleaseNotification(createdAt, id)` with
`CREATE INDEX CONCURRENTLY` (no table lock) in an additive migration.

## 17. Delivery monitoring

`/admin/deliveries` (Operations → Deliveries; `deliveries.tsx`) over `GET /admin/deliveries`,
`GET /admin/deliveries/release-emails/:reference` and `GET /admin/deliveries/safety-notices/:reference`
(`AdminDeliveriesService`; `SessionAuthGuard` + `AdminGuard`: admin role **and** completed MFA; anonymous, Customer,
Recipient and Trusted Contact sessions get 401). GET only, `Cache-Control: no-store` (shared admin policy, §18).

**Coverage (what is recorded durably).**

| Category | Channel | Record | What is stored |
|---|---|---|---|
| Release email ("a message is waiting for you") | Email | `ReleaseNotification`, one per access grant with an email (per occurrence for yearly triggers) | `status` (PENDING/SENT/FAILED), `attemptCount`, `lastErrorCode` (last attempt only), `providerMessageId`, `sentAt`, `failedAt`, timestamps. Kept as long as the release; deleted with the account |
| Death-verification safety notice | Email | Fields on `DeathVerificationCase` | `safetyNoticeAttemptCount`, `safetyNoticeLastAttemptAt`, `safetyNoticeSentAt` (+ the case's `SAFETY_NOTICE_SENT` event). No error category. Kept with the case |

**Not covered** (no durable, trustworthy record; only server logs; nothing reconstructed from logs): Trusted Contact
invitation email/SMS (a failed send cancels the invitation exactly like a superseded one, and the row is created
`PENDING` before the send, so `TrustedContactInvitation` cannot tell sent from failed), one-time codes (email OTP and
Twilio Verify SMS: no per-send record, by design), account emails (verification, password reset, email change,
email-changed notice), the operator alert email. **No SMS delivery is recorded at all**, so every row is Email. Adding
these would need new, privacy-reviewed records (a later step), not a log-derived ledger.

**Intent vs attempt.** The row is the *intent* (created when the release or report happens). Attempts are not stored
individually: only `attemptCount` and the **last** error category (each failure overwrites it) for release emails; only
the count and the most recent start time for safety notices. History shows only stored timestamps (intent created,
accepted, failed for good, dead-lettered; case opened, most recent attempt started, accepted) and says what is missing.

**Statuses** (mapping, never persisted):

| Category | Label | Stored condition |
|---|---|---|
| Release email | Waiting to send | `PENDING`, `attemptCount = 0` (an attempt may be in progress) |
| | Retrying after a failed attempt | `PENDING`, `attemptCount > 0` (= Overview "Emails retrying") |
| | Accepted by the email provider | `SENT` |
| | Failed for good | `FAILED` (retries exhausted or not retryable; = Overview "Emails failed") |
| | + *Last attempt: outcome uncertain* | not `SENT` and last error `timeout` or `network_error`: the provider may have sent it |
| Safety notice | Waiting to send | case `PENDING_VERIFICATION`, not sent, 0 attempts |
| | Attempted, not accepted yet | case `PENDING_VERIFICATION`, not sent, ≥ 1 attempt (in progress, or failed and retried by the reconciler) |
| | Accepted by the email provider | `safetyNoticeSentAt` set (the safeguard started then) |
| | Not sent (case closed) | not sent and the case left `PENDING_VERIFICATION` |

**Provider acceptance is not delivery.** No provider confirms inbox delivery (no webhooks), so nothing is labelled
"Delivered"; the provider message id identifies an accepted request, it is not a receipt. A failed attempt is not a
terminal failure; missing confirmation is not a failure.

**Failure categories** are allowlisted on the way out (`errorCategory()`): the providers' own categories (`timeout`,
`network_error`, `token_unavailable`, `auth_rejected`, `unauthorized`, `rate_limit_exceeded`, `mailbox_not_found`,
`email_disabled`, `unknown_error`), `forbidden_*` → `forbidden`, anything else (a provider-defined name could be
stored) → `provider_error`. The raw `lastErrorCode` is never returned.

**Queue state (release email detail only, optional).** The BullMQ job `release-notification-<id>` is read through
`AdminQueuesService.jobState` (allowlisted queue, state and attempt counts only, never the payload): `delayed` = retry
scheduled (BullMQ keeps the time, but it is not shown, since it is not a stored fact), `active` = attempt in progress.
Not looked up for an accepted email. If Redis cannot be read it says "unavailable" and the stored record is unaffected;
lists never touch Redis. Retry controls stay on the Queues page (§8) with their own permissions; this page has none.

**Duplicate risk (existing, unchanged).** If the provider accepts an email but the process stops before the row is
marked `SENT` (or the request times out after acceptance), the retry sends a second copy. Delivery is at-least-once,
not exactly-once; "outcome uncertain" rows are not safe to resend.

**Filters** (server-side, allowlisted, `limit ≤ 100`): `category` (`release_email` default, `safety_notice`), `status`
(per category, 400 otherwise), `outcomeUncertain=true`, `errorCategory`, `reference` (exact id; the case id for a
notice), `releaseReference` (exact Message id), `createdFrom`/`createdTo` (when the intent was recorded; reversed range
400). Release-email-only filters are 400 for safety notices. Sort `createdAt` (default desc) or `updatedAt`, always
with `id` as the tie-breaker. One category per request (each is its own table, paged on its own). Existing indexes:
`ReleaseNotification(status, createdAt)`, `(grantId)`, `DeathVerificationCase(status)`.

**Links.** Overview "Emails retrying" / "Emails failed" (and their attention items) → `?status=retrying` / `failed`
(same definitions, shared code; the e2e test checks the totals match). Release detail → "View this release's emails"
(`?releaseReference=`). Delivery rows/detail → the release (`/admin/releases/:id`), the account (Users), the case and
its audit events, Queues (dead letters).

**Recipient.** Each release email shows the grant's opaque `recipientReference` (the Recipient id) and a
**server-masked** `destination` (`maskDestination`: `ruth@gmail.com` → `r***@g***.com`; one-character parts become
`*`; malformed values become `***`, never echoed). The full snapshot address is read only inside the API to mask it and
is never returned. (`maskEmail`, the log helper, is not used here: it keeps the whole domain and echoes malformed input.)

**Privacy and read-only.** Explicit selects: no full address, name, subject, body, HTML, link, token, OTP, payload or
provider text; the account and release are ids. Reading never sends, queues, retries, polls a provider or changes a
row (unit test: a Prisma fake that fails on any write; e2e: statuses, attempt counts, the case's notice fields and
releases unchanged). Detail views are written to the application log (`admin_delivery_viewed`), not durable audit events (same deferred
task as §16).

## 18. Admin response caching

Every response under `/api/v1/admin` and `/api/v1/admin-auth` (data, sign-in/MFA, and errors such as 401/404) is sent
with `Cache-Control: no-store`, set once by a path-scoped middleware in `configureApp` (`src/config/app.setup.ts`), so
no browser or proxy keeps admin data. Customer, Recipient, Trusted Contact, public and `/health` routes are not affected
(no global header was added). No stricter policy existed to preserve. Verified on real HTTP responses in
`test/admin.e2e-spec.ts` (every admin GET route, an admin 401 and 404, and a Customer route without the header).

## 19. System health

`/admin/system/health` (Operations → System health; `system-health.tsx`) over `GET /admin/system/health`
(`SystemHealthService`; `SessionAuthGuard` + `AdminGuard`: admin role **and** completed MFA; `no-store` per §18). The
endpoint takes no input at all, so no probe target, host or command can come from the browser. Read-only; the only new
write in the system is the worker's own heartbeat. The public `/health/database` and `/health/redis` endpoints are
unchanged (no admin detail added to them).

**What each check proves (and does not).** All checks run from the API instance that answered the request; other API
replicas are not observed.

| Service | Check | Success label | Proves | Does not prove |
|---|---|---|---|---|
| API | this request was handled (no self-request) | Responding | this instance answers | other replicas, every feature |
| PostgreSQL | `SELECT 1` via `HealthService.checkDatabase` on the existing Prisma pool | Reachable | connectivity from this instance | query performance, data health |
| Redis | `PING` via `HealthService.checkRedis` on the existing session client | Reachable | the session/cache connection | the queue connection (read by the worker check) |
| Worker | heartbeat registry in queue Redis (below) | Heartbeat recent | a worker process beat within the threshold | that every queue is consumed; an expected replica count (none is configured, none assumed) |
| Malware scanner | clamd `PING` → `PONG` (`ClamAvMalwareScanner.ping`, configured `CLAMAV_HOST`/`CLAMAV_PORT` only, no file) | Responding | clamd answers from this instance | signature freshness, engine version, that a scan succeeds |

Other statuses: `failed` (Check failed), `timed_out` (Timed out), worker `stale` (Heartbeat stale: only beats older than
the threshold), `missing` (No heartbeat seen: absence of evidence, not proof of a crash), `unknown` (queue Redis could
not be read), scanner `not_configured` (no `CLAMAV_HOST`; the app normally refuses to start then). No error message, host,
key or configuration value is returned. Upload scanning is unchanged and stays fail-closed whatever this page shows.

**Budgets and coalescing.** Each check has 2 s (`CHECK_TIMEOUT_MS`); the four run in parallel, so a page answers in about
2 s at worst. The scanner ping uses real cancellation (`AbortSignal.timeout`, the socket is destroyed on success, failure
and abort). The PostgreSQL and Redis checks are raced against the timer; the single pending command then settles with its
connection. One snapshot is shared for 5 s (`SNAPSHOT_MS`, failures included, never longer), so concurrent and repeated
requests (System Health and the Overview) run at most one probe set per 5 s per API instance. No lock or scheduler.

**Worker heartbeat** (`src/health/worker-heartbeat.ts`). Provided only by `WorkerModule` (the worker process; not the API,
not `QueueWorkersModule`), started in `onApplicationBootstrap` (after every module, including the BullMQ consumers, has
initialised; no job needed), stopped first in `onModuleDestroy`.

| Setting | Value |
|---|---|
| Interval | `WORKER_HEARTBEAT_INTERVAL_SECONDS`, default **15** (positive whole number; startup fails otherwise; same value on API and worker) |
| Stale after | 3 × interval = **45 s** |
| Retained ("last seen") | 20 × interval = **5 min**, then pruned |
| Storage | one Redis hash in **queue** Redis (BullMQ's own connection via its documented `backend.client`), key `for_after:<RELEASE_QUEUE_NAME>:worker-heartbeats` (test runs use their own queue names) |
| Data | field = opaque random id per worker process, value = last beat (epoch ms). Nothing else |
| Writes per beat | `HSET` own field; `HGETALL` + `HDEL` of fields older than the retention (bounded cleanup; BullMQ's adapter has no sorted sets or `EXPIRE`) |
| Read (API) | one `HGETALL` of that bounded hash; no key scans; entries past the retention are ignored, not deleted |
| Failures | never thrown into job processing; logged once (`worker_heartbeat_failed`, error code only) and once on recovery |
| Shutdown | timer cleared, own field removed best-effort with a 1 s cap (otherwise it goes stale after 45 s) |

Several workers each keep their own field (counted as "reporting workers"). A worker killed without shutdown stays
"recent" up to 45 s after its last beat, then "stale" with its last-seen time, then disappears after 5 minutes (checked on
the isolated environment: hard kill → `ok` at +30 s, `stale` at +50 s). Known edge: a worker silent for over 5 minutes that
beats at the very moment another worker prunes can lose that one beat (it reappears on its next beat).

**Overview.** The Overview's "System status" panel is compact (one status per service, the overall verdict, "View
system health"); verbose explanations live on System health. Both use the same snapshot and the same labels
(`lib/system-health.ts`). The overall verdict is **Issues detected** (any failed/timed out), **Monitoring incomplete**
(stale, missing, unknown, not configured) or **No issues in these checks** (scoped to this API instance and reporting
workers; never "All systems operational"). The Overview's attention alert names only confirmed check failures.

**Refresh.** Manual Refresh only (no polling). `checkedAt` = when the server finished the checks; `lastSeenAt` = the
newest worker beat; "Received by this browser" = when the page got the result. A failed refresh keeps the previous result,
marked as possibly out of date, without changing its server times.

**Gaps.** No history or uptime; queue lag not shown; other API replicas and scanner sidecars are not observed; Redis is
checked on the session connection (the queue connection only through the worker read); email/SMS providers are not probed
(no test sends); signature freshness is not reported.

## 20. Security activity

`/admin/security` (Operations → Security activity; `security-activity.tsx`) over `GET /admin/security/events` and
`GET /admin/security/events/:reference` (`AdminSecurityService`; `SessionAuthGuard` + `AdminGuard`: admin role **and**
completed MFA; `no-store` per §18). A **projection of existing `AuditLog` rows**: no second audit store, no new capture.
Viewing is logged (`admin_security_viewed`), not audited, like the audit list. The events list, cards, graph, details
and Refresh are read-only (GET only); the only changes on the page are the temporary IP blocks of §20a, each from its
own confirmation dialog. No unlock, reset, export, resolve or delete.

**Page (2026-11-09 redesign).** Header (date range: Today / 7 / 30 (default) / 90 days or a custom range from More
filters; Refresh; last-refreshed time with timezone), a collapsible coverage notice ("Audit events are recorded rows,
not every request."), four cards (Total recorded events, Admin sign-in and sign-out events, Admin two-factor failures,
Recovery codes used) plus chips for the other categories, the **Recorded security events** graph, the **IP controls**
panel (§20a) and the **Recorded events** table (Event / Outcome / Actor primary filters, More filters for event
reference, account ID and dates; URL state; server pagination). **Scope:** cards, graph and source activity use the
date range only; the table uses every filter (stated on the page). One admin sign-in writes several rows (password,
two-factor, session start), so "sign-in and sign-out events" count recorded steps, never people or completed sign-ins.

**Graph** (`series` in the list response): stored rows per local day (ranges over 2 days) or hour (2 days or less) in
the viewer's IANA zone (`tz`, default UTC; names only), zero-filled by `generate_series` so a zero is a confirmed "no
stored rows"; bins stop at now (a future bin is not a zero). Two series: `admin_sign_in` rows (plum,
`--chart-sign-in`) and `ADMIN_MFA_FAILED` rows (muted red, dashed, `--chart-failure`). Straight segments between real
counts (no smoothing), whole-number axis, tooltip per bin, and a "View as a table" alternative with exact counts. A
failed query fails the whole response (the page shows an error or keeps the last result marked stale), never zeros. No
request-rate telemetry is mixed in or reconstructed.

**Source activity** (`sources`): the 5 most frequent stored `/24`/`/48` prefixes in the window with their row counts.
Masked, so never a block target; the panel says each is "IP blocking is unavailable for this source." and that
automated abuse detection is unavailable (frequency in audit rows is not misuse).

**Covered events** (data source: `AuditLog`, written by the existing code paths; kept permanently, append-only, no
cleanup job):

| Category | Event types | Outcome |
|---|---|---|
| `admin_sign_in` Admin sign-in and sign-out | `ADMIN_PASSWORD_AUTH_SUCCEEDED`, `ADMIN_MFA_VERIFIED`, `ADMIN_LOGIN`, `ADMIN_LOGOUT` | completed |
| `mfa_failure` Admin two-factor failed | `ADMIN_MFA_FAILED` | failed |
| `recovery_code` Admin recovery code used | `ADMIN_RECOVERY_CODE_USED` | completed |
| `mfa_setup` Admin two-factor set up | `ADMIN_MFA_SETUP_COMPLETED` | completed |
| `account_status` Account suspended or reactivated | `USER_SUSPENDED`, `USER_REACTIVATED` | completed |
| `account_credentials` Password or email changed | `PASSWORD_CHANGED`, `PASSWORD_RESET_COMPLETED`, `EMAIL_CHANGE_REQUESTED`, `EMAIL_CHANGED` | completed |
| `ip_controls` Temporary IP block created or revoked (§20a) | `IP_BLOCK_CREATED`, `IP_BLOCK_REVOKED` | completed |

`failed` = the step was refused; `completed` = the recorded action or step completed. Labels are factual ("Admin
two-factor failed"); nothing is labelled an attack, and no severity is assigned (none is defined).

**Not covered (gaps).** Only in logs or transient Redis counters, never rows: customer, Recipient and Trusted Contact
sign-in failures; OTP verification failures and attempt limits; `@nestjs/throttler` 429s and the admin MFA IP limit
(`admin_mfa_rate_limited`); Origin/CSRF rejections (403, not logged); session revocation other than `ADMIN_LOGOUT`.
No capture was added: a row per rejected request would be unbounded under abuse, the submitted identifier on those
paths is not a verified account, and no aggregation/suppression mechanism exists to reuse. Adding one needs a bounded,
aggregated design first. Zero rows therefore never means "no attempts"; the page says so.

**Volume of what is covered.** `ADMIN_MFA_FAILED` is only written after a correct admin password (an existing
challenge), at most `ADMIN_TOTP_MAX_ATTEMPTS` (default 5) per challenge and behind the per-IP verify limit, so it is
bounded per password success and its account is password-verified. The other events follow successful, authenticated
actions. Event recording is unchanged by this step (no auth code was touched).

**Response DTO** (`toSecurityEvent`): `reference` (audit row id), `recordedAt`, `eventType`, `category`, `outcome`,
`actorType`, `actorUserId` (set by the server from a session or a password-verified admin), `accountId` (only a UUID
`User` subject), `network`, `reason` (MFA failures only: `method` in totp/recovery/challenge, `code` in wrong_code /
replay / already_used / attempts_exhausted, `challengeInvalidated`; anything else is `null`, shown as "Reason not
recorded"). **Never returned:** `userAgent`, raw `metadata` (so a suspension's free-text reason is not shown here; it
stays on the audit-log detail), secrets, session ids, codes. Legacy or malformed metadata yields `null` fields.

**Source / IP.** `network` is the stored `ipPrefix` (IPv4 /24, IPv6 /48, written by the tested `ipPrefix()`; full IPs
are never stored), re-checked against a /24 or /48 pattern so anything else is dropped ("Source unavailable"). It is
`req.ip` at write time: outside production `trust proxy` is off, so `X-Forwarded-For` is ignored (e2e-tested); in
production `trust proxy` is 1 hop, which is only correct if exactly one proxy fronts the API. Each row carries
`sourceTrusted`: true only if `IP_ATTRIBUTION_VERIFIED_AT` (§20a) is set and the row was written at or after it;
otherwise the label is "Proxy attribution unverified". No row is trusted today (the variable is unset everywhere).
"Trusted attribution" means the extraction path was verified; it never identifies a person or shows intent. No IP
search, export, geolocation, device or threat classification.

**Filters** (all validated; unknown params 400): `category`, `outcome`, `actorType` (ADMIN / SUPER_ADMIN / CUSTOMER),
`reference` (exact UUID), `accountId` (exact UUID, matched to the recorded `User` subject), `from`/`to` (ISO; default
the last 30 days, at most 366 days, `from` before `to`, inclusive), `page`/`limit` (max 100). Order: `createdAt desc,
id desc` (unique tie-breaker). No text or metadata search. URL state: calendar days in the viewer's timezone (as Audit
logs).

**Counts.** `counts` = stored rows per category in the window (other filters not applied), from one `groupBy`. Rows,
not occurrences; no sampling. A failed query fails the request (never zeros); the page keeps the last result marked as
possibly out of date, or shows the error. Overview: "Admin two-factor failures recorded, last 7 days" (rolling 168 h,
`mfaFailuresSince`; `null` shows "Unavailable"), linking to the list from the local calendar day 7 days back (a slightly
wider window, shown on the page). No alarm banner (no agreed threshold).

**Performance.** Existing `AuditLog` indexes (`eventType`, `createdAt`) and bounded windows/pages; one list query, one
count, one category `groupBy`, one binned series query and one source `groupBy` per request (one transaction), no
per-row lookups, no Redis, no log files. No index added (review if security rows grow large: `(eventType, createdAt)`).

## 20a. Temporary IP blocks

Manual, temporary, exact-address blocks under operator review. **No automatic blocking, CIDR ranges, country blocks or
threat detection.** Code: `src/ip-blocks/` (`IpBlockService`, `IpBlockMiddleware`), `AdminIpBlocksController`,
frontend `ip-controls.tsx` (panel on `/admin/security`, list at `/admin/security/ip-blocks`). Migration
`20261105090000_add_ip_blocks` (additive: `IpBlock` table, two `AuditEventType` values).

**Availability gate: source attribution.** Blocking is only as good as `req.ip`. Production sets `trust proxy` to 1
hop (`app.setup.ts`, unchanged), which is right only if exactly one proxy that appends the real client address fronts
the API. That topology has **not** been verified for any deployment (AWS ALB is the documented plan; the Railway demo
is a different edge). Until an operator verifies it and sets `IP_ATTRIBUTION_VERIFIED_AT` (ISO instant of
verification): `controls.available = false`, the page says "IP blocking is unavailable for this source.", create is
refused (409, same text), **nothing is enforced and nothing is polled**. Revoke stays allowed (it can only restore
access). A future instant counts as not yet verified; an invalid value refuses to start. Forwarding headers are never
read directly: Express's `req.ip` under the configured `trust proxy` is the only source (outside production it is the
socket peer, so a forged `X-Forwarded-For` is ignored; e2e-tested both ways, including forged left-hand entries).

**Deployment prerequisite (not done):** in the target environment, confirm the exact chain (client → one proxy → API),
that the proxy overwrites or appends the client address as the last `X-Forwarded-For` entry, and that the API is not
reachable around it; record the proxy/egress/monitoring addresses in `IP_BLOCK_PROTECTED_IPS`; then set
`IP_ATTRIBUTION_VERIFIED_AT`. Do not change `trust proxy` without re-verifying.

**Endpoints** (all `SessionAuthGuard` + `AdminGuard`, `no-store`):

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/admin/security/ip-blocks?status=&page=&limit=` | any admin | `controls` {available, superAdmin, recentAuth, activeCount}; exact `ip` and `reason` for SUPER_ADMIN only, others get the masked `network` |
| POST | `/admin/security/ip-blocks` `{ip, durationMinutes, reason}` | SUPER_ADMIN, two-factor in the last 15 min | 30/h throttle; Origin check (global); whitelist validation |
| POST | `/admin/security/ip-blocks/:id/revoke` | same | 409 if already ended; 404 unknown |

**Create rules** (server-side, before any write): one complete address, normalised with `ipaddr.js`
(`::ffff:a.b.c.d` → `a.b.c.d`, IPv6 compressed lower-case); no ranges, prefixes, zone ids or masked values; public
unicast only (loopback, private, link-local, CGNAT, multicast, broadcast, unspecified and reserved refused; the
documentation ranges 192.0.2/24, 198.51.100/24, 203.0.113/24, 2001:db8::/32 are allowed so tests never touch a real
address); not the operator's own `req.ip`, not the socket peer (the proxy), not `IP_BLOCK_PROTECTED_IPS`. Durations
exactly 15, 60 (default in the UI) or 1440 minutes; reason required, trimmed, at most 500 characters. Under one
Postgres advisory lock: refuse a second active block for the same address (concurrent duplicates → exactly one row,
e2e-tested) and more than 1000 active blocks. Operator identity comes from the session only.

**Storage, audit and retention.** `IpBlock` holds the exact address, reason, creator, times and revoker; rows are
never deleted (expired and revoked stay as history; no cleanup job; no retention period decided). Exact address and
reason are readable by SUPER_ADMIN only. `IP_BLOCK_CREATED` / `IP_BLOCK_REVOKED` audit rows hold only the masked
network and the duration (never the address or reason) and appear in Security activity. No other raw-IP collection
was added.

**Enforcement.** `IpBlockMiddleware` on every route (`{*splat}`), after the app-level helmet, CORS, Origin check and
session middleware, before guards and throttling. Blocked: customer app, Recipient and Trusted Contact portals, admin
portal and admin-auth, every other API route (case-insensitive). Exempt, with their own controls unchanged:
`/health/*` (load balancer) and exactly `/api/v1/webhooks/stripe` (signature-verified). No header or parameter can
select a bypass. Response: `403 {"message":"Access from this network is temporarily unavailable."}` (CORS headers still
sent, so the browser shows it). Sessions are not ended; they simply cannot be used from that address. The frontend's
own pages are served by Next.js, not this API, so they still load but every API call fails.

**Propagation and failure behaviour.** Postgres is the source of truth; no Redis. Each API instance keeps an in-memory
snapshot of active blocks, re-read every 15 s (`IP_BLOCK_POLL_MS`) and immediately after a create/revoke on that
instance. So a block or revocation reaches other instances within about 15 s; expiry is checked on every request
against `expiresAt`, so it is exact even if no poll runs. Per request there is no I/O. A failed poll keeps the last
snapshot and logs `ip_block_refresh_failed` (no detail); if the database is down at start-up the snapshot is empty
(nothing blocked) and the app still starts. Authentication, sessions and rate limiting do not depend on this module and
are unchanged. The worker does not load it. Blocked requests are never audited: a warning `ip_block_rejected network
<masked>` at most once a minute per address per instance.

**Recovery from a mistaken block** (no unauthenticated endpoint exists or should be added):
1. Another super admin, from a different address, revokes it on `/admin/security/ip-blocks` (audited).
2. Or wait: every block ends by itself within at most 24 hours.
3. Operator with database access (local/runbook only): `UPDATE "IpBlock" SET "revokedAt" = now() WHERE id = '<id>'
   AND "revokedAt" IS NULL;` takes effect within 15 s on every instance. This writes no audit row: record it in the
   incident log, and prefer step 1.
4. Emergency stop of all enforcement: unset `IP_ATTRIBUTION_VERIFIED_AT` and restart the API. History is kept.

**Verified** (2026-11-09, local, fictional data): backend `ip-block.service.spec.ts` and `admin-security.service.spec.ts`
in the 36/36 targeted unit run; `test/ip-blocks.e2e-spec.ts` 15/15 and `test/admin.e2e-spec.ts` 32/32 on the isolated
DB/Redis (only documentation-range addresses blocked); frontend `security-activity.test.tsx` 15/15. No real address
was blocked and no deployment has attribution enabled.

## 21. Storage and scans

`/admin/storage` (Operations → Storage & scans; `storage.tsx`) over `GET /admin/storage/assets` and
`GET /admin/storage/assets/:reference` (`AdminStorageService`; `SessionAuthGuard` + `AdminGuard`: admin role **and**
completed MFA; `no-store` per §18). Read-only database metadata: `AdminModule` has no media provider dependency at all,
so reading cannot sign URLs, download, scan, enqueue or delete anything. Viewing is logged (`admin_storage_viewed`).
No schema change, no index, no change to upload, scan, access or cleanup code.

**Included models**: `MediaAsset` (Messages), `MemoryVaultMediaAsset`, `MyStoryMediaAsset`, `MyWishMediaAsset`,
`RecipientPhoto` (the five quota tables) and `DeathVerificationEvidence` (shown apart: outside customer quotas, no
account reference, no case link; evidence access stays on the case page with its own audit). Nothing else stores files.

**Unique counting.** One row = one stored file: `storageKey` is unique per table and every row has exactly one parent.
"Create a message from a memory" stores its own copy with its own row, so rows are never double-counted and a content
association is never a shared asset. One `UNION ALL` query (constant SQL, filters as bound parameters).

**Bytes** (same definitions as `StorageQuota`, summed over all owners):
- **Verified recorded storage** = `sizeBytes` of READY rows not soft-deleted. READY is only set after the provider
  reported exactly this size (plus type, signature and, since Phase 12B, a clean malware scan), so the size is verified.
- **Reserved (declared)** = `sizeBytes` of PENDING_UPLOAD rows not soft-deleted: the client-declared size, reserved
  against the quota, not verified. Shown separately, never added to verified storage.
- FAILED and soft-deleted rows count in neither (as in the quota). Totals are database records, not the provider's
  stored or billed bytes; no provider inventory is read. Units: 1 KB = 1,024 bytes (the customer formatter); exact bytes
  on the detail. No platform-wide limit or percentage (only per-customer limits exist).

**State mappings** (stored columns only):

| Shown | Stored | Meaning |
|---|---|---|
| Awaiting upload or checks | `PENDING_UPLOAD` | not uploaded yet, or checks not finished. Includes uploads whose scan could not complete (scanner down or timeout keep the row pending, fail closed); the two cannot be told apart. Retired after 24 h by `MediaCleanup` |
| Verified | `READY` | passed the checks in force when completed; `uploadedAt` is shown as "Verified". Rows completed before Phase 12B (2026-10-08) were not malware-scanned and cannot be told apart, so READY is never labelled "scan passed" |
| Failed verification | `FAILED` | type/size/signature mismatch **or** a detected threat; which one is not stored. Never accessible; file removed |
| Not marked for removal | live row | |
| Removal pending | `deletedAt` set or `FAILED`, `storageDeletedAt` null | the file is not yet confirmed removed; `MediaCleanup` retries (legacy B2 files only on their owner's request) |
| Removal recorded | `storageDeletedAt` set | the provider accepted the delete (or had no file) |

**Scan coverage.** Scans run synchronously in each upload's `complete` call (no worker). No per-file scan result, reason,
time or attempt history is stored, so the page shows "Not recorded per file" rather than deriving one; scanner output
and signature names are only logged as generic events. There is no quarantine state (threats become FAILED and are
removed). Scanner reachability stays on System health (§19), which links here without turning it into a safety claim.

**Reconciliation limits.** `MediaCleanup` is the only reconciliation (DB → provider deletes). Provider objects without a
database row are not detected and no inventory is run; nothing here claims every stored object is accounted for. No
"stuck" or "orphan" labels (no agreed rule).

**Filters**: `source`, `uploadState` (pending/ready/failed), `deletion` (active/pending/confirmed), `kind`
(PHOTO/AUDIO/VIDEO), exact `reference` and `accountId` (UUIDs), created `from`/`to` (at most 366 days), `sort`
(`createdAt`/`updatedAt`) and `dir`, with `id` as tie-breaker; `limit` at most 100. No file-name, title or MIME search.

**Response DTO** (`toStorageAsset`): reference, area, kind, account (owner; null for evidence), size, `sizeVerified`,
upload state, removal state, `legacyStorage`, created/updated/verified/deleted/removal-recorded times. Never selected:
`storageKey`, `providerFileId`, `originalFileName`, `mimeType`, parent ids or any content. Per-area totals are computed
in the same request but independently: if they fail they are `null` ("Totals are unavailable"), never zeros, and the
list still answers. Performance: six sequential scans per query at current volume (only owner and parent indexes exist);
revisit with a `(status, createdAt)` index if the tables grow large.

## 22. Admin access

`/admin/access` (Operations → Admin access; `admin-access.tsx`) over `GET /admin/access/admins` and
`GET /admin/access/admins/:id` (`AdminAccessService`; `SessionAuthGuard` + `AdminGuard`: admin role **and** completed
MFA; `no-store` per §18). **Read-only**: the controller has no write route (unit- and e2e-tested), no schema change.

**Verified authority matrix** (from the code, not a new policy):

| | ADMIN | SUPER_ADMIN |
|---|---|---|
| View admin accounts (Users page already lists them; this page adds enrolment and last sign-in) | yes | yes |
| Suspend / reactivate a Customer (`canManage`, Users page) | yes | yes |
| Suspend / reactivate an ADMIN | no | yes |
| Suspend / reactivate a SUPER_ADMIN, or yourself | no | no |
| Change any role | no (no API exists) | no (no API exists) |

Effective permissions on the detail are computed by `effectivePermissions(role)` from `canManage` and `ADMIN_ROLES`
(the functions that enforce them), never a frontend map. `viewerCanManage` uses the same `canManage` (and not
yourself) only to show a link to the Users page, which checks again on every action.

**Why no mutations here.** Step-up re-authentication for sensitive admin actions is not built (§13) and there is no
agreed role-change or grant-delegation policy. Per the step's rules, no role-change, MFA-reset or new suspension
endpoint was added. Suspension stays on the Users page under its existing rules; it suspends the **whole account**
(`User.status`), and because `SessionAuthGuard` re-reads the user on every request (ACTIVE only) and `AdminGuard`
re-checks the role from that read, a suspended admin's existing sessions stop working on their next request
(e2e-tested in "role safety"). Reactivation never restores a session: the normal password + TOTP sign-in is required.
Last-manager protection: nobody can suspend or demote a SUPER_ADMIN through the API, so the last one cannot be locked
out. Decisions needed before access mutations: who may grant which role (delegation), step-up re-authentication, and a
last-SUPER_ADMIN rule for any future role change.

**Fields.** List: id, email, name, role, account status, `mfaEnrolled` (an `AdminMfaCredential` with `enabledAt`, i.e.
an authenticator was confirmed; it does not mean a session passed MFA), `lastSignInAt` (the newest `ADMIN_LOGIN` audit
row: password + TOTP completed and a session created; `null` = none recorded, e.g. before Step 16; never `updatedAt`).
Detail adds `mfaEnrolledAt`, permissions, `viewerCanManage` and the last 20 access-related audit rows about the account
(`USER_SUSPENDED`, `USER_REACTIVATED`, `ADMIN_MFA_SETUP_COMPLETED`) as explicit fields (event, actor, previous/new status,
time; never the free-text reason or raw metadata). Never: password hashes, TOTP secrets or QR codes, recovery codes or
their hashes, sessions, tokens. One grouped `ADMIN_LOGIN` query per page (no N+1).

**Filters**: search (email/name, as on the Users page), role (ADMIN/SUPER_ADMIN only), status, two-factor
(enrolled/not enrolled); sort `createdAt` or `email` with `id` as tie-breaker; `limit` at most 100.

**Not covered**: provisioning stays the operator procedure (§3); MFA reset/re-enrolment and recovery-code regeneration
(§13); active-session counts (not reliably recorded); viewing is logged (`admin_access_viewed`), not audited.

### 22a. Create admin (invitation) and SUPER_ADMIN bootstrap

**Create admin** (`/admin/access/new`, button "Create admin" on Admin access, shown to SUPER_ADMIN only):
`POST /admin/access/admins { firstName, lastName, email }` and `POST /admin/access/admins/:id/invitation` (resend).
Server rules: admin role + MFA guards, then **SUPER_ADMIN** with two-factor completed **within the last 15 minutes**
(the session's own MFA time; otherwise 403 "sign in again"), 20 requests/hour per IP. The body has no role,
permission, status or password field (unknown fields 400), and the account created is always an ordinary **ADMIN**.
An email already used by any account (normalised, unique) is a 409 and that account is never changed or elevated;
two concurrent creations of one email give 201 + 409. The account gets an unusable random password and no verified
email, so it cannot sign in. An `ADMIN_INVITATION` token (the existing `AuthToken` table: 256-bit, hash only,
single use, older links superseded, 3 per account per hour, `ADMIN_INVITATION_TTL_SECONDS` default 72 h) is emailed
directly (like reset links). The response says `sent` (accepted by the email provider, not proof of delivery),
`not_sent` or `capped`; resend works while the invitation is pending ("Invitation pending" in the list).
`/admin/invitation?token=` → `POST /auth/admin-invitation/accept { token, newPassword }` (public, 5/min, the normal
password rule): only for an ADMIN who never set a password; sets the password, verifies the email, uses every
invitation link, creates **no session**. They then sign in at `/admin/login`, where TOTP setup is required before any
admin route works. Audit: `ADMIN_CREATED` (role), `ADMIN_INVITATION_SENT`, `ADMIN_INVITATION_ACCEPTED`; never tokens or
passwords.

**SUPER_ADMIN bootstrap** (local maintenance only): `node scripts/dev-promote-super-admin.ts --id <uuid> --email <email>`
(Node 22.18+). Refuses unless `NODE_ENV=development` and `DATABASE_URL` is localhost; the id and the normalised email
must match the same **ACTIVE ADMIN** (otherwise nothing changes; a missing account is never created). In one
transaction: role → SUPER_ADMIN, `passwordChangedAt` = now (UTC; the established revocation time, so every existing
session ends and the account signs in again with its own password and TOTP), audit `SUPER_ADMIN_BOOTSTRAPPED` (actor
`SYSTEM`, previous/new role, host). Password, email verification and MFA enrolment are untouched. Re-running prints
"Already SUPER_ADMIN". No API, startup or seed path promotes anyone.

# 🛡️ For After — Admin Backend (Step 16)

> The admin API: mandatory TOTP sign-in, hardened admin sessions, user search and suspension, a generic append-only
> audit log, queue monitoring with failed-job retry, and the Step 15 death-verification review. Backend only; the admin
> UI is **FE-28**.

| | |
|---|---|
| **Built** | Admin TOTP + recovery codes, admin idle timeout, `AdminGuard` (role + MFA), dashboard, users (list/search/detail/suspend/reactivate), `AuditLog` + viewer, queue summary / failed jobs / retry, paginated + audited death-verification admin routes |
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
for_after_session with adminMfaVerifiedAt + lastActivityAt  →  AdminGuard
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

Admins use the same `for_after_session` cookie (HttpOnly, `SameSite=Lax`, `Secure` in production). After a successful
second factor the session id is regenerated and the session holds `userId`, `role`, `adminMfaVerifiedAt` and
`lastActivityAt`. Nothing else.

**`SessionAuthGuard`** (every User route) re-reads the user and, for `ADMIN`/`SUPER_ADMIN` only:

- no `adminMfaVerifiedAt` (a pre-Step-16 session, or a Customer promoted mid-session) → session destroyed, `401`;
- idle longer than `ADMIN_SESSION_IDLE_TIMEOUT_SECONDS` (1800) → session destroyed, `401`, log `admin_session_expired`;
- otherwise `lastActivityAt` is refreshed.

Customer sessions are unchanged (no idle timeout).

**`AdminGuard`** (after `SessionAuthGuard`) requires role `ADMIN`/`SUPER_ADMIN` **and** `adminMfaVerifiedAt`, so an
admin route is never reachable on role alone. Customers get `403`; no session, a Recipient or a Trusted Contact cookie
gets `401`.

**Logout** is the existing `POST /auth/logout` (destroys the session, clears the cookie) and writes `ADMIN_LOGOUT` for
admin sessions. There is no second logout route.

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
| `POST` | `/auth/logout` | also the admin logout |
| `GET` | `/admin/dashboard` | user counts by status, open death cases, failed jobs |
| `GET` | `/admin/users` | `page, limit (≤100), search, status, role` |
| `GET` | `/admin/users/:userId` | account metadata + counts; audited |
| `POST` | `/admin/users/:userId/suspend` | `{ reason }` (required, ≤1000) |
| `POST` | `/admin/users/:userId/reactivate` | `{ reason? }` |
| `GET` | `/admin/audit-logs` | `page, limit, eventType, actorUserId, subjectType, subjectId, from, to` |
| `GET` | `/admin/audit-logs/:auditLogId` | one row |
| `GET` | `/admin/system/queues` | per queue: `waiting, active, delayed, prioritized, failed, completed` |
| `GET` | `/admin/system/queues/:queueName/failed` | `page, limit`; sanitized |
| `POST` | `/admin/system/queues/:queueName/jobs/:jobId/retry` | failed jobs only |
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
| `actorType`, `actorUserId` | `ADMIN` or `SUPER_ADMIN`, and the admin's id (plain id, no FK, survives deletions) |
| `subjectType`, `subjectId` | e.g. `User` / `DeathVerificationCase` / `Job` and its id |
| `ipPrefix` | IPv4 `/24` or IPv6 `/48` (e.g. `203.0.113.0/24`). **Never the raw IP** |
| `userAgent` | truncated to 256 characters |
| `metadata` | small scalar map, e.g. `{ previousStatus, newStatus, reason }` |

**Events written in Step 16**: `ADMIN_PASSWORD_AUTH_SUCCEEDED`, `ADMIN_MFA_SETUP_COMPLETED`, `ADMIN_MFA_VERIFIED`,
`ADMIN_MFA_FAILED` (with `reason`: `wrong_code`, `replay`, `attempts_exhausted`, ...), `ADMIN_RECOVERY_CODE_USED`,
`ADMIN_LOGIN`, `ADMIN_LOGOUT`, `USER_SUSPENDED`, `USER_REACTIVATED`, `ADMIN_VIEWED_USER`, `ADMIN_VIEWED_DEATH_CASE`,
`DEATH_VERIFICATION_VERIFIED`, `DEATH_VERIFICATION_REJECTED`, `FAILED_JOB_RETRIED`. No historic events were
back-filled. Aggregate reads (lists, dashboard, queue counts) are logged, not audited, to keep the trail meaningful.

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

**Dead letters.** Exhausted jobs stay in BullMQ's `failed` set for 7 days (`removeOnFail`), which these endpoints
surface. There is no separate dead-letter queue, and alerting on failures is still open (Phase 17). For release jobs
the reconciler re-queues a still-`SCHEDULED` message anyway, so retry is mostly useful after an outage.

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
5. **Admin - TOTP Confirm** → `200`, `recoveryCodes` (shown once: store them offline) and the `for_after_session`
   cookie.
6. **Admin - /admin-auth/me** → `mfaVerified: true`.
7. Call the admin APIs (dashboard, users, audit, queues, death verification). Later sign-ins use **Admin - TOTP
   Verify**. A code works once per 30 s step, so wait for the next code if you just used one (the script waits for you).

---

## 13. Known limits and open decisions

- **Subscriptions**: admin subscription management deferred until the Stripe backend exists (Phase 21). No billing
  tables or figures were invented.
- **Deliveries**: admin delivery monitoring deferred until the delivery worker/data model exists (Phase 17/20).
- **Dead-letter queue / alerts**: failed jobs are surfaced; a real DLQ and alerting remain Phase 17 work.
- **CSRF**: admin routes use the same model as Customer routes: `SameSite=Lax` cookies + a CORS allowlist
  (`FRONTEND_URL`, `WORDPRESS_URL`) + JSON bodies. Lax blocks cross-site `POST` cookies, and cross-origin JSON requests
  need a preflight the allowlist refuses. Residual risk: an XSS or compromised page on an allowlisted origin, and
  same-site subdomains. No CSRF token was added here, because a half-built token scheme would break the not-yet-built
  frontends; a token/`Origin` check remains the Phase 05 CSRF review item.
- **Re-authentication** for sensitive admin actions (`security.md` §13) is not built.
- **Admin MFA reset / re-enrollment API** and "regenerate recovery codes" are not built (operator procedure in §3).
- **Password-login throttle** is still in-memory per instance (Phase 04); MFA limits are already in Redis.
- **Suspension vs. death verification**: open product decision (§6).

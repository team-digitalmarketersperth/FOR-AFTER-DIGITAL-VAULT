# 🚨 For After — Incident Response

> What to do when something goes wrong: severity levels, the standard procedure, and runbooks for the areas that are
> most sensitive in a digital-legacy product.

| | |
|---|---|
| **Applies to** | Backend Steps 1–16 (runbooks marked 🔜 cover features not built yet) |
| **Related** | [Threat model](../threat-model.md) · [Security](security.md) · [Deployment](deployment.md) |

## 🧭 Contents

1. [Severity levels](#1-severity-levels)
2. [Response procedure](#2-response-procedure)
3. [Release and delivery failures](#3-release-and-delivery-failures)
4. [Death report and verification incidents](#4-death-report-and-verification-incidents)
5. [Recipient Portal incidents](#5-recipient-portal-incidents-step-13)
6. [Trusted Contact incidents](#6-trusted-contact-incidents-step-14)
6a. [Admin account incidents](#6a-admin-account-incidents-step-16)
7. [Data breach response](#7-data-breach-response)
8. [Monitoring and alerts](#8-monitoring-and-alerts)
9. [Backup and recovery](#9-backup-and-recovery)
10. [Contact and escalation](#10-contact-and-escalation)

---

## 1. Severity levels

| Level | Name | Description | Examples |
|:--:|---|---|---|
| **P1** | 🔴 Critical | Widespread failure, data breach, or a critical workflow failure | Complete outage, **content released after a false death report**, data breach |
| **P2** | 🟠 High | Important functionality broken for many users | Release failures, payment errors, auth or OTP issues |
| **P3** | 🟡 Medium | Degradation or localized issues | Slow performance, non-critical background jobs failing |
| **P4** | 🟢 Low | Minor, non-blocking | UI bugs, typos |

---

## 2. Response procedure

1. **Detect:** alerts, user reports or monitoring.
2. **Triage:** assign a severity and an Incident Commander.
3. **Contain:** stop the bleeding (disable a feature, block IPs, invalidate sessions).
4. **Resolve:** deploy the fix and verify it.
5. **Post-mortem:** write up the root cause and preventive measures.

---

## 3. Release and delivery failures

**As built (Step 12):**
- BullMQ retries release jobs with exponential backoff (5 attempts).
- When retries are exhausted, the message stays `SCHEDULED` and the reconciler re-queues it every 60 s.
- `MessageRelease.messageId` is unique, so a retry can never release twice.
- Watch the `release_retries_exhausted`, `release_business_block` and `reconciliation_error` log categories.

**Planned (delivery):**
- 🔜 Dead-letter queue for permanently failed delivery jobs.
- 🔜 Sentry + Slack alerts on DLQ insertions.
- 🔜 Admin dashboard to retry failed jobs manually.
- 🔜 Per-recipient delivery status in PostgreSQL to prevent duplicate sends.

---

## 4. Death report and verification incidents

### As built (Steps 14–15)

A report starts a safety notice and a safeguard window; only an admin can verify, after the window ends. Every step is
in `DeathVerificationAuditEvent` (admin detail endpoint). See [death-verification.md](death-verification.md).

| Situation | Action |
|---|---|
| **False or malicious report** | Nothing happens automatically. The Customer can confirm alive (`CANCELLED`); otherwise an admin **rejects** at review. Keep all records: reports are never deleted |
| **Safety notice keeps failing** | Case stays `PENDING_VERIFICATION` (by design: no notice, no safeguard). Watch `death_safety_notice_failed`; check `EMAIL_PROVIDER`, the Brevo sender / authorised-IP status and `email_send_failed` lines ([email setup](email-production-setup.md)). `safetyNoticeAttemptCount` shows the attempts |
| **Case stuck in `SAFEGUARD_ACTIVE` past its end** | Redis/worker trouble. The death reconciler advances overdue cases from PostgreSQL every interval; check `death_reconciliation_error` |
| **Verified, but Messages not released** | Check the admin detail `activations` (`messageStatus`). The reconcilers rebuild missing activations and release jobs; watch `release_*` and `death_trigger_*` logs. A Message with no live recipient stays `SCHEDULED` (`release_business_block`) |
| **Report spam** | One report per Trusted Contact per case is enforced (`409`). Watch `death_report_submitted` / `death_report_duplicate` and the OTP rate-limit categories |
| **Compromised Trusted Contact email** | Ask the Customer to remove or edit the contact (access ends immediately); delete that email's Trusted Contact sessions in Redis |
| **Compromised admin account** | 🔴 P1. Disable the account (role/status), review `ADMIN_VERIFIED` / `ADMIN_REJECTED` audit events by `actorUserId` |

### 🔴 Wrong verification (P1)

There is **no reversal API** (terminal states are final by design). Until a recovery workflow is designed:

1. Stop further releases: the Customer's remaining death-trigger Messages are `SCHEDULED` with activations; a reviewed
   database change is needed (for example removing the pending `DeathTriggeredMessageActivation` rows).
2. Released Messages already have access grants; removing access is a manual, reviewed change on
   `RecipientMessageAccessGrant` (no revocation feature yet), followed by deleting affected Recipient sessions.
3. Restoring the account means setting `User.status` back to `ACTIVE` (reviewed change) and deciding what to do with
   the `VERIFIED` case record (keep it as history).
4. Notify affected parties.

### Planned

- 🔜 Recovery/reversal workflow for a wrong decision.
- 🔜 **Evidence tampering:** detection flags suspicious metadata on uploaded documents (evidence upload not built).

---

## 5. Recipient Portal incidents (Step 13)

| Situation | Action |
|---|---|
| **Wrong person granted access** (e.g. wrong email at release) | No revocation feature yet. Grants are frozen at release and survive a contact edit or soft delete. Removing one is a manual, reviewed database change on `RecipientMessageAccessGrant`, followed by deleting that email's Recipient sessions |
| **OTP abuse** | Watch `recipient_otp_rate_limited` and `recipient_otp_invalid`; limits come from `RECIPIENT_OTP_*` |
| **Releases made before Step 13 have no grants** | `npm run backfill:access-grants` (dry run first, then `-- --apply`) |

---

## 6. Trusted Contact incidents (Step 14)

| Situation | Action |
|---|---|
| **OTP abuse / enumeration attempts** | Watch `trusted_contact_otp_rate_limited` and `trusted_contact_otp_invalid`; limits come from `TRUSTED_CONTACT_OTP_*` |
| **Trusted Contact should lose access** | The Customer removes the contact (`DELETE /trusted-contacts/:id`); relationships are re-checked on every request. Optionally delete their Redis sessions (`for_after:trusted_contact_sess:*`) |
| **Suspected pepper leak** | Rotate `TRUSTED_CONTACT_OTP_PEPPER` (invalidates all pending Trusted Contact codes) and restart |

---

## 6a. Admin account incidents (Step 16)

| Situation | Action |
|---|---|
| **Suspected compromised admin** (P1) | A `SUPER_ADMIN` suspends the account (`POST /admin/users/:id/suspend`, takes effect on the next request). For a `SUPER_ADMIN`, an operator sets `status = 'SUSPENDED'` in PostgreSQL. Delete that user's sessions in Redis (`for_after:sess:*`). Review `GET /admin/audit-logs?actorUserId=<id>` (sign-ins, views, suspensions, death decisions, job retries) |
| **Lost authenticator** | Sign in with a recovery code (`/admin-auth/recovery/verify`). No codes left: after out-of-band identity verification, an operator deletes the `AdminMfaCredential` and `AdminMfaRecoveryCode` rows; the next login re-enrolls. Audit the action in the ticket |
| **Many `ADMIN_MFA_FAILED`** | Filter the audit log by `eventType=ADMIN_MFA_FAILED`; the IP prefix shows the network. The password was correct (a challenge exists), so treat it as a compromised password: suspend, reset the password, re-enroll |
| **`ADMIN_TOTP_ENCRYPTION_KEY` leaked** | Rotate the key; existing secrets can no longer be decrypted, so every admin must re-enroll (delete all `AdminMfaCredential` rows). Treat as P1 together with a database leak |
| **Wrong suspension** | `POST /admin/users/:id/reactivate` (only `SUSPENDED → ACTIVE`; a `PASSED` account follows §4 "Wrong verification") |

Audit rows cannot be edited or deleted (database trigger); corrections are new rows plus the incident ticket.

---

## 7. Data breach response

| Stage | Action |
|---|---|
| **Contain** | Invalidate all sessions: Redis keys `for_after:sess:*` (Customers and admins), `for_after:admin_auth:challenge:*` (pending admin MFA), `for_after:recipient_sess:*` (Recipients), `for_after:trusted_contact_sess:*` (Trusted Contacts). Rotate `RECIPIENT_OTP_PEPPER` and `TRUSTED_CONTACT_OTP_PEPPER` to invalidate all pending codes; rotate `SESSION_SECRET` |
| **Remediate** | Forced password resets for affected or all Customers |
| **Notify** | Tell affected users |
| **Comply** | Notify regulators (e.g. the OAIC in Australia) within mandatory timeframes if PII is exposed |

> ⚠️ Do not `FLUSHALL` Redis in production to "log everyone out": the release queue lives there too. Delete by key pattern.

---

## 8. Monitoring and alerts

| Area | What to watch |
|---|---|
| Application | NestJS Observe logs/traces (built); Sentry for unhandled exceptions (planned) |
| Release queue | Failed job counts (`GET /admin/system/queues`, dashboard `queues.failed`), `release_*` log categories |
| Admin | `admin_mfa_failed`, `admin_session_expired`, `admin_recovery_code_used` (warn), `ADMIN_MFA_FAILED` audit rows |
| OTP | `*_otp_rate_limited`, `*_otp_invalid`, `*_otp_delivery_failed` |
| Database | Connection pool exhaustion, query latency, disk usage |
| Redis | Memory, eviction rate, connection drops |
| Storage | Approaching bucket quotas, unexpected usage spikes |

---

## 9. Backup and recovery

- **Database:** PostgreSQL point-in-time recovery (PITR).
- **Media storage:** bucket versioning against malicious or accidental deletion.
- **RPO/RTO:** targets defined and reviewed quarterly; restores tested.

---

## 10. Contact and escalation

- An on-call rotation ensures 24/7 coverage.
- Escalation paths define when to involve senior engineering or leadership by severity (**P1 = immediate executive
  notification**).

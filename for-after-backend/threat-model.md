# 🛡️ For After — Threat Model

> For After handles extremely sensitive data: posthumous messages, personal memories, death reports and (later) death
> certificates and billing. The threat model covers technical attacks **and** social engineering, such as someone
> falsely reporting a death.

| | |
|---|---|
| **Last reviewed** | 2026-09-29 (after Step 15: death verification workflow + death-trigger release) |
| **Review cadence** | Quarterly, and after any significant architecture change or security incident |
| **Related** | [Security](docs/security.md) · [Authorization](docs/authorization.md) · [Incident response](docs/incident-response.md) |

## 🧭 Contents

1. [Assets to protect](#1-assets-to-protect)
2. [Threat actors](#2-threat-actors)
3. [Attack vectors and mitigations](#3-attack-vectors-and-mitigations)
4. [Data classification](#4-data-classification)
5. [Compliance](#5-compliance)
6. [Security testing plan](#6-security-testing-plan)
7. [Incident response](#7-incident-response)

---

## 1. Assets to protect

- User account credentials and personal information
- Private vault content (audio, text, photos, memories; video later)
- Death reports (Step 14) and, later, death certificates and verification documents
- Recipient and Trusted Contact personal information (email, phone, relationship)
- Payment/billing data (Stripe handles PCI, but customer ids are stored)
- Session tokens, OTP challenges and authentication state
- Release schedules and delivery metadata

---

## 2. Threat actors

| Actor | Typical goal |
|---|---|
| External attackers | Data theft, ransomware |
| Malicious insiders | Admin abuse |
| Social engineers | **Fake death reports** to trigger early release |
| Disgruntled family members | Unauthorized access to a loved one's vault |
| Automated bots | Credential stuffing, OTP brute force, email enumeration |

---

## 3. Attack vectors and mitigations

✅ = mitigation built and tested · 🔜 = planned

### Accounts and sessions

| Threat | Vector | Mitigation |
|---|---|---|
| **Credential stuffing** | Automated login attempts | ✅ Rate limiting (5/min per IP), Argon2id slow hashing · 🔜 account lockout |
| **XSS token theft** | Steal a JWT from `localStorage` | ✅ No JWT in browser storage; HttpOnly cookies only |
| **Session hijacking** | Steal a session cookie | ✅ `Secure`, `SameSite=Lax`, HTTPS only, id regenerated on login · 🔜 IP/UA binding |
| **Session confusion** | One principal's cookie used on another's routes | ✅ Three separate cookies, Redis keys and guards (Customer / Recipient / Trusted Contact); each gets `401` elsewhere, tested in all directions |
| **Admin privilege escalation** | Compromised admin account | 🔜 Mandatory 2FA, short sessions, re-auth for sensitive actions, full audit logging |

### One-time codes (Recipients and Trusted Contacts)

| Threat | Vector | Mitigation |
|---|---|---|
| **OTP brute force** | Guessing a 6-digit code | ✅ 5 attempts per challenge, per-IP verify limit, 10-minute TTL, single use, peppered HMAC stored in Redis only |
| **Email enumeration** | Probing which emails are Recipients / Trusted Contacts | ✅ `request-otp` always `202` with the same body; one generic `401` for every verify failure; per-email/IP rate limits; delivery not awaited (no timing signal) |
| **Cross-portal code reuse** | A Recipient code used to sign in as a Trusted Contact (or the reverse) | ✅ Separate peppers and Redis namespaces per principal (Step 14); tested both ways |
| **Console OTP in production** | Codes written to production logs | ✅ `console` delivery refuses to start unless `NODE_ENV=development` |

### Content access

| Threat | Vector | Mitigation |
|---|---|---|
| **Unauthorized content access** | Recipient reads unreleased items | ✅ Release-time grant + `RELEASED` + not deleted checked in every query; unreleased and others' Messages are `404` · 🔜 DB-level RLS |
| **Access follows a contact edit** | Customer changes a Recipient's email after release | ✅ Grants snapshot the email at release; later edits do not move access |
| **Trusted Contact reads the vault** | A Trusted Contact tries to see Messages, memories, story or wishes | ✅ No such routes for Trusted Contacts; the account list returns only a display name, relationship label, a `hasPreservedContent` boolean and case status; Trusted Contact sessions get `401` on all Customer and Recipient routes |
| **Relationship probing** | A Trusted Contact guesses another relationship's `trustedContactId` | ✅ Every lookup requires id + signed-in email + not deleted; anything else is `404` (never `403`) |
| **IDOR** | Access another user's resources | ✅ All queries filter by the authenticated owner; ownership checks in the service layer |
| **Media file exposure** | Direct URL guessing | ✅ Private bucket, short-lived signed URLs, server-generated keys |

### Death reporting

| Threat | Vector | Mitigation |
|---|---|---|
| **False death report** | Social engineering to release content early | ✅ A report changes nothing by itself. Step 15: the account holder is **notified**, a **safeguard window** (default 14 days, stored per case) must pass, the Customer can **confirm alive** at any open stage, and only an **admin** can verify, never before the window ends (no override). Tested · 🔜 evidence review, second confirmation, admin 2FA |
| **Multiple colluding contacts** | Two contacts report to force a verification | ✅ Reports are supporting information only; there is no automatic or consensus verification |
| **Notice suppression** | A broken or disabled email provider hides the report from the account holder | ✅ The safeguard starts only after a **successful** send; with delivery disabled or failing, the case stays `PENDING_VERIFICATION` and cannot be verified |
| **Decision race** | Admin verifies while the Customer confirms alive | ✅ Conditional updates in transactions: exactly one terminal decision wins, the other gets `409` (tested concurrently) |
| **Deceased account reuse** | Someone uses the deceased Customer's session or password | ✅ Verification sets `PASSED` atomically: login `403`, existing sessions `401` on the next request |
| **Unauthorized verification** | A Customer, Recipient or Trusted Contact calls admin routes | ✅ `AdminGuard` (role re-read from PostgreSQL): Customers `403`, other sessions `401`; no admin self-registration |
| **Report spam / duplicates** | The same contact reports repeatedly | ✅ One report per Trusted Contact per case (unique index → `409`); reporting requires a verified email session and OTP rate limits; closed cases accept no reports |
| **Status injection** | Client sends `status: "VERIFIED"`, `ownerUserId`, `verifiedByUserId`, `deathTriggersActivatedAt` | ✅ DTO whitelist rejects unknown fields (`400`); statuses only change through the guarded workflow transitions |
| **Leaking verification activity** | A contact learns how many others reported | ✅ Status endpoint returns only `status`, `reportedByYou`, `openedAt`; no counts or other reporters |
| **Removed contact keeps reporting** | Customer removes a Trusted Contact | ✅ Relationships re-checked in PostgreSQL on every request; removal takes effect immediately |

### Platform

| Threat | Vector | Mitigation |
|---|---|---|
| **SQL injection** | Malicious input in the API | ✅ Prisma parameterized queries; class-validator on all DTOs |
| **Duplicate message release** | Worker retry releases twice | ✅ `UNIQUE` constraint + row lock; worker re-reads PostgreSQL before acting |
| **Sensitive data in logs** | Notes, codes or session ids logged | ✅ Masked emails and ids only; OTPs, hashes, peppers, session ids and report notes never logged (tested) |
| **Data exfiltration** | Bulk data download | 🔜 Rate-limited export endpoints, audit logging on data access |
| **Dependency supply chain** | Malicious npm package | ✅ Lock file, pinned Prisma 7 · 🔜 npm audit / Dependabot in CI |

---

## 4. Data classification

| Class | Examples |
|---|---|
| **Critical** | Passwords (Argon2id hashed), OTP peppers, vault media content, death reports, (later) death certificates |
| **Sensitive** | User PII, Recipient and Trusted Contact details, payment info, session tokens |
| **Internal** | Audit logs, system metrics, queue state |
| **Public** | Marketing content, pricing pages |

---

## 5. Compliance

- Australian Privacy Act.
- GDPR-like principles: data minimisation, right to erasure, consent.
- Data residency in AWS Sydney (`ap-southeast-2`).

---

## 6. Security testing plan

- Automated SAST/DAST in CI/CD.
- Penetration testing before launch.
- Chaos/failure testing for queue resilience.
- Backup recovery drills.
- Existing automated coverage: unit + e2e tests for ownership isolation, OTP limits, cross-principal separation and
  "death report releases nothing", safeguard enforcement, decision races and deceased-account lockout (Step 15).

---

## 7. Incident response

See [Incident Response Procedures](docs/incident-response.md).

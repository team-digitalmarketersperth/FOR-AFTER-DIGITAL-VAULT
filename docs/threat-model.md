# For After — Threat Model

## 1. Overview
For After handles extremely sensitive personal data — posthumous messages, death certificates, personal memories, financial billing data. The threat model must account for both technical attacks and social engineering.

## 2. Assets to Protect
- User account credentials and personal information
- Private vault content (videos, audio, text, photos, memories)
- Death certificates and verification documents
- Recipient personal information (email, phone, relationship)
- Payment/billing data (Stripe handles PCI, but customer IDs stored)
- Session tokens and authentication state
- Release schedules and delivery metadata

## 3. Threat Actors
- External attackers (data theft, ransomware)
- Malicious insiders (admin abuse)
- Social engineers (fake death reports)
- Disgruntled family members (unauthorized access attempts)
- Automated bots (credential stuffing, brute force)

## 4. Attack Vectors & Mitigations

| Threat | Vector | Mitigation |
|---|---|---|
| **Credential stuffing** | Automated login attempts | Rate limiting (5/min), Argon2id slow hashing, account lockout |
| **XSS token theft** | Steal JWT from localStorage | No JWT in browser storage. HttpOnly cookies only |
| **Session hijacking** | Steal session cookie | Secure, SameSite=Lax, HTTPS only, session binding to IP/UA |
| **False death report** | Social engineering | Multi-step verification: evidence, waiting period, contact attempts, second confirmation, admin review |
| **Unauthorized content access** | Recipient accesses unreleased items | Deny-by-default. DB-level RLS. Guard checks on every query |
| **SQL injection** | Malicious input in API | Prisma parameterized queries. class-validator on all DTOs |
| **Media file exposure** | Direct URL guessing | Signed URLs with strict expiration. No public buckets |
| **Admin privilege escalation** | Compromised admin account | Mandatory 2FA, short sessions, re-auth for sensitive actions, full audit logging |
| **IDOR** | Access other user's resources | All queries filter by authenticated user ID. Ownership checks in service layer |
| **Duplicate message delivery** | Worker retry sends twice | Idempotency keys (UNIQUE constraint). Worker checks DB status before sending |
| **Data exfiltration** | Bulk data download | Rate-limited export endpoints. Audit logging on data access |
| **Dependency supply chain** | Malicious npm package | npm audit, Snyk/Dependabot, lock file integrity, pin critical versions (Prisma@7) |

## 5. Data Classification
- **Critical**: Passwords (Argon2 hashed), death certificates, vault media content
- **Sensitive**: User PII, recipient details, payment info, session tokens
- **Internal**: Audit logs, system metrics, queue state
- **Public**: Marketing content, pricing pages

## 6. Compliance Considerations
Australian Privacy Act. GDPR-like principles (data minimization, right to erasure, consent). Data residency in AWS Sydney (ap-southeast-2).

## 7. Security Testing Plan
Automated SAST/DAST in CI/CD. Penetration testing before launch. Chaos/failure testing for queue resilience. Backup recovery drills.

## 8. Incident Response Reference
Link to [Incident Response Procedures](incident-response.md) for detailed procedures.

## 9. Review Schedule
Threat model reviewed quarterly and after any significant architecture change or security incident.

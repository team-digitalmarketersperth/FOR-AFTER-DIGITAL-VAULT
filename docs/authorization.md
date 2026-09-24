# For After — Authorization & Access Control

This document outlines the role model, Guard implementations in NestJS, and overall access control architecture.

## 1. Role Model

Access is tiered into four primary roles:

- **CUSTOMER**
  - Full vault management.
  - Manages recipients, messages, scheduling, media, memories, story, wishes, billing, profile, and account export/deletion.

- **RECIPIENT (Loved One)**
  - Passwordless OTP authentication.
  - **Strictly deny-by-default**.
  - Can ONLY view released messages explicitly mapped to their recipient ID.
  - Zero visibility into drafts, unreleased records, other recipients, or metadata.

- **TRUSTED CONTACT**
  - Can submit death reports, upload evidence, confirm death reports, and update recipient contact info.
  - **CANNOT** view message contents or unreleased vault items.

- **ADMIN / SUPER_ADMIN**
  - Mandatory 2FA, short session duration, IP/device monitoring.
  - Manages users, billing, failed jobs, and death report approvals.
  - Full audit logging on every sensitive record access.

## 2. NestJS Guards

Authorization is enforced at the controller level using custom NestJS guards:

- `SessionAuthGuard` — Validates the `HttpOnly` session cookie against the Redis session store.
- `RolesGuard` — Checks the user's role against the `@Roles()` decorator.
- `AdminGuard` — Restricts access to `ADMIN` or `SUPER_ADMIN` and validates an active 2FA session.
- `RecipientGuard` — Restricts access to released vault items explicitly mapped to the authenticated recipient.
- `TrustedContactGuard` — Validates trusted contact credentials for death reporting functions.

## 3. Guard Usage Examples

Typical decorator patterns in NestJS controllers:

```typescript
// Enforce user must be logged in
@UseGuards(SessionAuthGuard)
@Get('me')
getMe() { ... }

// Enforce admin-only access
@UseGuards(SessionAuthGuard, RolesGuard)
@Roles('ADMIN', 'SUPER_ADMIN')
@Get('admin/users')
listUsers() { ... }

// Recipient specific access
@UseGuards(RecipientGuard)
@Get('recipient/vault')
getReleasedVault() { ... }
```

## 4. Row-Level Security (RLS)

Where applicable and critical, Database-level enforcement is used.
- Customer A cannot query Customer B's records under any circumstance.
- Recipients are restricted to querying rows that have been cleared and explicitly mapped to them.

## 5. Resource Ownership

- Every Prisma query filters by the authenticated user's ID.
- No endpoint accepts an ID parameter that allows accessing another user's resources without explicit sharing mapping (e.g., a `MessageRecipient` link).

## 6. Admin Re-authentication

Sensitive administrative actions require a fresh password input + 2FA verification:
- Death verification approval.
- Manual message release.
- Account transfers.

## 7. Permission Matrix

| Resource / Action | Customer | Recipient | Trusted Contact | Admin |
| :--- | :---: | :---: | :---: | :---: |
| Vault Management | ✅ | ❌ | ❌ | ❌ |
| View Released Content | ❌ | ✅ (If Mapped) | ❌ | ❌ |
| Report Death | ❌ | ❌ | ✅ | ❌ |
| Approve Death Report | ❌ | ❌ | ❌ | ✅ |
| Manage Users | ❌ | ❌ | ❌ | ✅ |
| View Unreleased Content| ✅ | ❌ | ❌ | ❌ |
| System Config / Logs | ❌ | ❌ | ❌ | ✅ |

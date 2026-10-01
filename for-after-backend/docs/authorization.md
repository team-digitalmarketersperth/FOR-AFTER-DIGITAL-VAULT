# 🛂 For After — Authorization & Access Control

> Who can see and do what. Everything is **deny-by-default**: a principal only reaches data that a guard and an
> ownership or relationship query explicitly allow. Anything else is `404`, never `403`, so existence never leaks.

| | |
|---|---|
| **Built** | Customer ownership (Steps 2–11), Recipient grants (Step 13), Trusted Contact relationships (Step 14), death-verification decisions (Step 15), **admin backend with MFA-enforcing `AdminGuard`, role-safe user management and audit (Step 16)** |
| **Planned** | RLS, Trusted Contact evidence/confirmation, admin re-authentication, role management |
| **Related** | [Authentication](authentication.md) · [Security](security.md) · [Database](database.md) |

## 🧭 Contents

1. [Roles and principals](#1-roles-and-principals)
2. [Permission matrix](#2-permission-matrix)
3. [NestJS guards](#3-nestjs-guards)
4. [Guard usage examples](#4-guard-usage-examples)
5. [Resource ownership](#5-resource-ownership)
6. [Row-level security](#6-row-level-security-rls)
7. [Admin re-authentication (planned)](#7-admin-re-authentication-planned)

---

## 1. Roles and principals

### 👤 Customer
- **As built:** a `User` with role `CUSTOMER`. Full vault management: recipients, trusted contacts, messages,
  scheduling, media, memories, story, wishes.
- **Planned:** billing, profile, account export/deletion.

### 💌 Recipient (loved one)
- Passwordless email code; **strictly deny-by-default**.
- Can **only** view released messages explicitly granted to them.
- **As built (Step 13):** not a `User` role but a separate principal with its own session. Access needs a
  `RecipientMessageAccessGrant` (email snapshot taken at release) for the verified email + Message `RELEASED` + not deleted.
- Zero visibility into drafts, unreleased records, other recipients or metadata.

### 🤝 Trusted Contact
- **Target:** submit death reports, upload evidence, confirm reports, update recipient contact info. **Cannot** view
  message contents or unreleased vault items.
- **As built (Step 14):** not a `User` role but a separate principal (email code, own session). Can list the Customers
  who name their email, see a display name, a `hasPreservedContent` true/false and the case status, and **file one
  death report** per relationship.
- **Not built:** evidence upload, confirmation, editing recipient info.
- **Never:** Messages, media, Memory Vault, My Story, My Wishes, recipient lists, counts or titles, before or after a report.

### 🛠️ Admin / Super admin
- **As built (Step 16):** `ADMIN`/`SUPER_ADMIN` with completed TOTP: dashboard, user search/detail, suspend/reactivate,
  audit-log viewer, queue monitoring + failed-job retry, and the Step 15 death-verification review (list, detail,
  verify, reject). `ADMIN` manages `CUSTOMER` accounts; `SUPER_ADMIN` also `ADMIN` accounts; nobody manages a
  `SUPER_ADMIN` or themselves through the API. Detail views and every change are written to `AuditLog`. Admins never see
  vault content and still get `403` on Customer routes. See [admin.md](admin.md).
- **Planned:** billing (Phase 21) and delivery (Phase 17/20) views, re-authentication for sensitive actions, IP/device
  monitoring.

---

## 2. Permission matrix

| Resource / action | Customer | Recipient | Trusted Contact | Admin |
| :--- | :---: | :---: | :---: | :---: |
| Vault management (own) | ✅ | ❌ | ❌ | ❌ |
| View unreleased content (own) | ✅ | ❌ | ❌ | ❌ |
| View released content | ❌ | ✅ if granted | ❌ | ❌ |
| See which Customers name them | ❌ | ❌ | ✅ (Step 14) | ❌ |
| See "preserved content exists" (true/false only) | ❌ | ❌ | ✅ (Step 14) | ❌ |
| Report death | ❌ | ❌ | ✅ (Step 14) | ❌ |
| See death case status | ✅ own (status + deadline) | ❌ | ✅ own relationships | ✅ (Step 15) |
| Confirm alive (cancel a report about me) | ✅ (Step 15) | ❌ | ❌ | ❌ |
| Review reports, notes, audit trail | ❌ | ❌ | ❌ | ✅ (Step 15) |
| Verify / reject death | ❌ | ❌ | ❌ | ✅ (Step 15, only after the safeguard) |
| Search / view accounts (metadata + counts, never content) | ❌ | ❌ | ❌ | ✅ (Step 16, audited) |
| Suspend / reactivate Customers | ❌ | ❌ | ❌ | ✅ (Step 16; never `PASSED`) |
| Suspend / reactivate admins | ❌ | ❌ | ❌ | `SUPER_ADMIN` only, never a `SUPER_ADMIN` or self |
| Audit log, queues, failed-job retry | ❌ | ❌ | ❌ | ✅ (Step 16) |
| Change roles, delete accounts, release a Message | ❌ | ❌ | ❌ | ❌ (no API) |

---

## 3. NestJS guards

| Guard | Status | What it does |
|---|:--:|---|
| `SessionAuthGuard` | ✅ built | Validates `for_after_session` against Redis and reloads the `User` from PostgreSQL; sets `req.user` |
| `CustomerGuard` | ✅ built | After `SessionAuthGuard`: role must be `CUSTOMER` (admins get `403`) |
| `RecipientSessionAuthGuard` | ✅ built (Step 13) | Reads only `for_after_recipient_session`; sets `req.recipient` (`@CurrentRecipient()`). The per-Message grant check is inside `RecipientMessagesService` queries |
| `TrustedContactSessionAuthGuard` | ✅ built (Step 14) | Reads only `for_after_trusted_contact_session`; sets `req.trustedContact` (`@CurrentTrustedContact()`). The relationship check is inside `TrustedContactPortalService` queries |
| `AdminGuard` | ✅ built (Step 15, MFA in Step 16) | After `SessionAuthGuard`: role `ADMIN`/`SUPER_ADMIN` **and** `adminMfaVerifiedAt` in the session (Customers `403`). `SessionAuthGuard` also destroys admin sessions without MFA or idle > 30 min (`401`) |
| `RolesGuard` + `@Roles()` | 🔜 planned | Finer-grained role checks if Step 16 needs them |

> 🔒 No guard falls back to another principal's cookie. A Customer, Recipient or Trusted Contact session gets `401` on
> every other principal's routes.

---

## 4. Guard usage examples

```typescript
// Customer: logged in + CUSTOMER role (built)
@UseGuards(SessionAuthGuard, CustomerGuard)
@Controller('messages')
export class MessagesController { ... }

// Recipient (built, Step 13)
@UseGuards(RecipientSessionAuthGuard)
@Get('recipient/messages')
list(@CurrentRecipient() recipient: RecipientPrincipal) { ... }

// Trusted Contact (built, Step 14)
@UseGuards(TrustedContactSessionAuthGuard)
@Get('trusted-contact/accounts')
findAll(@CurrentTrustedContact() contact: TrustedContactPrincipal) { ... }

// Admin (built, Step 15)
@UseGuards(SessionAuthGuard, AdminGuard)
@Controller('admin/death-verifications')
export class AdminDeathVerificationController { ... }
```

---

## 5. Resource ownership

| Principal | Every query is scoped by | Never authorizes from |
|---|---|---|
| Customer | `ownerUserId` from the session + `deletedAt: null` | an `ownerUserId` or id in the request body |
| Recipient | a `RecipientMessageAccessGrant` whose email snapshot = the verified email, Message `RELEASED`, not deleted | a recipient id, the live `Recipient.email`, or the pre-release `MessageRecipient` link |
| Trusted Contact | `TrustedContact` rows with email = the verified email, not deleted, Customer not deleted (`activeRelationship()`), re-read every request | TrustedContact ids stored in the session (there are none), or a report having been filed |

A `:trustedContactId` in a Trusted Contact route must be one of the signed-in email's active relationships; otherwise
`404 Account not found.` Removing a Trusted Contact ends that access immediately.

---

## 6. Row-level security (RLS)

**Target:** database-level enforcement where critical. Customer A can never query Customer B's rows; Recipients only
rows cleared and mapped to them.

**As built:** no RLS yet. Enforcement is in the application:
- Customer data is filtered by `ownerUserId` in every query.
- Recipient data needs a grant for the verified email + `RELEASED` + `deletedAt: null`.
- Trusted Contact data is limited to their own active relationship rows, a display name, a content-exists boolean and
  the case status.

Anything else is `404`, never `403`.

---

## 7. Admin re-authentication (planned)

Sensitive administrative actions will require a fresh password + 2FA:

- Death verification approval
- Manual message release
- Account transfers

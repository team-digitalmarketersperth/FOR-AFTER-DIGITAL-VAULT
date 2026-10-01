# 🗺️ For After — API Endpoints List (Steps 1–15)

> Every endpoint built so far, grouped by step, followed by a complete index. The file name still says "1-to-13" so
> existing links keep working; it now covers **Steps 14–15** as well.

| | |
|---|---|
| **API base URL** | `http://localhost:4000/api/v1` |
| **Health base URL** | `http://localhost:4000` (no `/api/v1` prefix) |
| **Field rules** | [api.md](api.md) |
| **Postman** | `D:\FOR-AFTER-DIGITAL-VAULT\postman\collections\FOR-AFTER` (16 folders, one per area) |

## 🧭 Contents

1. [Endpoints by step](#-endpoints-by-step)
2. [Complete endpoint index](#-complete-endpoint-index)
3. [Three separate sessions](#-three-separate-sessions)
4. [Not public (by design)](#-not-public-by-design)
5. [End-to-end flows](#-end-to-end-flows)

---

## 📦 Endpoints by step

### Step 1 — Health / infrastructure

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/v1` | Root ("Hello World!") |
| `GET` | `/health/database` | PostgreSQL health check |
| `GET` | `/health/redis` | Redis health check |

> ℹ️ There is no plain `GET /health` route.

### Step 2 — Customer authentication

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/auth/register` | Register a Customer |
| `POST` | `/auth/login` | Customer login (sets `for_after_session`) |
| `POST` | `/auth/logout` | Customer logout |
| `GET` | `/auth/me` | Current authenticated Customer |

### Step 3 — People I Love (Recipients)

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/recipients` | Create Recipient |
| `GET` | `/recipients` | List the Customer's Recipients |
| `GET` | `/recipients/:recipientId` | Get one Recipient |
| `PATCH` | `/recipients/:recipientId` | Update Recipient |
| `DELETE` | `/recipients/:recipientId` | Soft-delete Recipient |

### Step 4 — Trusted Contacts (Customer management)

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/trusted-contacts` | Create Trusted Contact |
| `GET` | `/trusted-contacts` | List Trusted Contacts |
| `GET` | `/trusted-contacts/:trustedContactId` | Get one Trusted Contact |
| `PATCH` | `/trusted-contacts/:trustedContactId` | Update Trusted Contact |
| `DELETE` | `/trusted-contacts/:trustedContactId` | Soft-delete Trusted Contact |

### Step 5 — Messages

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/messages` | Create Message (DRAFT) |
| `GET` | `/messages` | List Messages |
| `GET` | `/messages/:messageId` | Get Message |
| `PATCH` | `/messages/:messageId` | Update DRAFT Message |
| `DELETE` | `/messages/:messageId` | Soft-delete Message |

Content types (after Step 8): `TEXT`, `PHOTO`, `AUDIO`, `MIXED`. `VIDEO` is rejected.

### Step 6 — Message scheduling

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/messages/:messageId/schedule` | Create schedule |
| `GET` | `/messages/:messageId/schedule` | Get schedule |
| `PATCH` | `/messages/:messageId/schedule` | Update schedule |
| `DELETE` | `/messages/:messageId/schedule` | Unschedule (back to DRAFT) |

Supported triggers: `FIXED_DATE`, `ON_DEATH`, `AFTER_DEATH`. Only `FIXED_DATE` is executed automatically (Step 12).

### Step 7 — Message media

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/messages/:messageId/media/upload-url` | Request a signed upload URL |
| `POST` | `/messages/:messageId/media/:mediaAssetId/complete` | Complete and verify the upload |
| `GET` | `/messages/:messageId/media` | List media |
| `GET` | `/messages/:messageId/media/:mediaAssetId/access-url` | Temporary signed access URL |
| `DELETE` | `/messages/:messageId/media/:mediaAssetId` | Delete media |

The file itself goes straight to Backblaze B2: `PUT <uploadUrl returned by /media/upload-url>`. Supported: `PHOTO`, `AUDIO`.

### Step 8 — Rich message composition

No new routes. Step 8 adds validation to message create/update, scheduling and media:

| contentType | Must have |
|---|---|
| `TEXT` | meaningful text only |
| `PHOTO` | at least one READY photo |
| `AUDIO` | at least one READY audio |
| `MIXED` | at least two of text / photo / audio |

### Step 9 — Memory Vault

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/memory-vault` | Create memory |
| `GET` | `/memory-vault` | List memories |
| `GET` | `/memory-vault?category=:category` | Filter by category |
| `GET` | `/memory-vault/:memoryVaultItemId` | Get one memory |
| `PATCH` | `/memory-vault/:memoryVaultItemId` | Update memory |
| `DELETE` | `/memory-vault/:memoryVaultItemId` | Soft-delete memory |
| `POST` | `/memory-vault/:memoryVaultItemId/media/upload-url` | Request a signed upload URL |
| `POST` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId/complete` | Complete and verify the upload |
| `GET` | `/memory-vault/:memoryVaultItemId/media` | List memory media |
| `GET` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId/access-url` | Temporary signed access URL |
| `DELETE` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId` | Delete memory media |

Categories: `FAMILY`, `TRAVEL`, `CHILDHOOD`, `FUNNY_STORIES`, `LIFE_LESSONS`, `RECIPES`, `LOVE_STORIES`, `OTHER`.

### Step 10 — My Story

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/my-story/prompts` | All prompts |
| `GET` | `/my-story/prompts?category=:category` | Filter by category |
| `GET` | `/my-story/prompts/:promptKey` | One prompt |
| `GET` | `/my-story/prompts/:promptKey/response` | The Customer's answer |
| `PUT` | `/my-story/prompts/:promptKey/response` | Create / update / restore answer |
| `DELETE` | `/my-story/prompts/:promptKey/response` | Soft-delete answer |

Categories: `CHILDHOOD`, `FAMILY`, `RELATIONSHIPS`, `MILESTONES`, `VALUES`, `LIFE_LESSONS`, `LEGACY`.
`GET /my-story/responses` is **not** implemented.

### Step 11 — My Wishes

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/my-wishes/prompts` | All wish prompts |
| `GET` | `/my-wishes/prompts?category=:category` | Filter by category |
| `GET` | `/my-wishes/prompts/:promptKey` | One wish prompt |
| `GET` | `/my-wishes/prompts/:promptKey/response` | The Customer's answer |
| `PUT` | `/my-wishes/prompts/:promptKey/response` | Create / update / restore answer |
| `DELETE` | `/my-wishes/prompts/:promptKey/response` | Soft-delete answer |

Categories: `CEREMONY`, `ATMOSPHERE`, `MUSIC_AND_READINGS`, `PEOPLE_AND_TRADITIONS`, `PERSONAL_PREFERENCES`,
`PERSONAL_MESSAGE`, `OTHER`. `GET /my-wishes/responses` is **not** implemented.

### Step 12 — Message release engine

> 🔒 **No public endpoint.** There is intentionally no `POST /messages/:messageId/release` (it returns `404`).

Release runs internally through BullMQ and writes a `MessageRelease` row. It is exercised through the public routes:
`POST /messages` → `POST /messages/:messageId/schedule` (`FIXED_DATE`) → wait → `GET /messages/:messageId`
(`RELEASED`). See [message-release.md](message-release.md).

### Step 13 — Recipient access grants

`RecipientMessageAccessGrant` is created inside the release transaction. There is intentionally no public endpoint
(e.g. no `POST /recipient-message-access-grants`).

```text
Message → MessageRelease → RecipientMessageAccessGrant
```

### Step 13 — Recipient OTP authentication

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/recipient-auth/request-otp` | Request an email code (always `202`) |
| `POST` | `/recipient-auth/verify-otp` | Verify the code (sets `for_after_recipient_session`) |
| `GET` | `/recipient-auth/me` | Authenticated Recipient |
| `POST` | `/recipient-auth/logout` | End the Recipient session (`204`) |

### Step 13 — Recipient Portal (read-only)

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/recipient/messages` | Released Messages for the signed-in Recipient |
| `GET` | `/recipient/messages/:messageId` | Released Message detail |
| `GET` | `/recipient/messages/:messageId/media` | READY media for that Message |
| `GET` | `/recipient/messages/:messageId/media/:mediaAssetId/access-url` | Temporary signed media URL |

### Step 14 — Trusted Contact OTP authentication 🆕

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/trusted-contact-auth/request-otp` | Request an email code (always `202`, no enumeration) |
| `POST` | `/trusted-contact-auth/verify-otp` | Verify the code (sets `for_after_trusted_contact_session`) |
| `GET` | `/trusted-contact-auth/me` | Authenticated Trusted Contact |
| `POST` | `/trusted-contact-auth/logout` | End the Trusted Contact session (`204`) |

### Step 14 — Trusted Contact Portal and death reports 🆕

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/trusted-contact/accounts` | Customers who list the signed-in email (display name, content-exists flag, case status) |
| `POST` | `/trusted-contact/accounts/:trustedContactId/death-reports` | File a death report → `201 PENDING_VERIFICATION` (duplicate → `409`) |
| `GET` | `/trusted-contact/accounts/:trustedContactId/death-verification` | Case status: `{status, reportedByYou, openedAt}` |

> ⚠️ A death report is **a report, not verification**. On its own it releases nothing, changes no schedule and creates
> no access grant. See [death-verification.md](death-verification.md) and [trusted-contact-auth.md](trusted-contact-auth.md).

### Step 15 — Death verification: Customer 🆕

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/death-verification/me` | Own case: `{status, safeguardEndsAt, canConfirmAlive}` |
| `POST` | `/death-verification/me/confirm-alive` | `{confirmAlive: true}` → open case `CANCELLED` |

### Step 15 — Death verification: Admin (minimal) 🆕

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/admin/death-verifications[?status=]` | Case list for review |
| `GET` | `/admin/death-verifications/:caseId` | Case detail: reports, notes, audit trail, activations |
| `POST` | `/admin/death-verifications/:caseId/verify` | `{verifiedDeathAt, confirmVerification: true, decisionNote?}` → `VERIFIED` (only from `READY_FOR_REVIEW`) |
| `POST` | `/admin/death-verifications/:caseId/reject` | `{confirmRejection: true, decisionNote?}` → `REJECTED` (only from `READY_FOR_REVIEW`) |

`ADMIN`/`SUPER_ADMIN` only (Customers `403`). After `VERIFIED`, `ON_DEATH`/`AFTER_DEATH` Messages are released through
the Step 12 queue; there is still no public release endpoint.

---

## 📇 Complete endpoint index

<details>
<summary><strong>Show the full route list</strong></summary>

**Health**

```text
GET  /api/v1
GET  /health/database
GET  /health/redis
```

**Customer authentication**

```text
POST /api/v1/auth/register
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
```

**Recipients**

```text
POST   /api/v1/recipients
GET    /api/v1/recipients
GET    /api/v1/recipients/:recipientId
PATCH  /api/v1/recipients/:recipientId
DELETE /api/v1/recipients/:recipientId
```

**Trusted Contacts (Customer)**

```text
POST   /api/v1/trusted-contacts
GET    /api/v1/trusted-contacts
GET    /api/v1/trusted-contacts/:trustedContactId
PATCH  /api/v1/trusted-contacts/:trustedContactId
DELETE /api/v1/trusted-contacts/:trustedContactId
```

**Messages**

```text
POST   /api/v1/messages
GET    /api/v1/messages
GET    /api/v1/messages/:messageId
PATCH  /api/v1/messages/:messageId
DELETE /api/v1/messages/:messageId
```

**Message scheduling**

```text
POST   /api/v1/messages/:messageId/schedule
GET    /api/v1/messages/:messageId/schedule
PATCH  /api/v1/messages/:messageId/schedule
DELETE /api/v1/messages/:messageId/schedule
```

**Message media**

```text
POST   /api/v1/messages/:messageId/media/upload-url
POST   /api/v1/messages/:messageId/media/:mediaAssetId/complete
GET    /api/v1/messages/:messageId/media
GET    /api/v1/messages/:messageId/media/:mediaAssetId/access-url
DELETE /api/v1/messages/:messageId/media/:mediaAssetId
```

**Memory Vault**

```text
POST   /api/v1/memory-vault
GET    /api/v1/memory-vault
GET    /api/v1/memory-vault?category=:category
GET    /api/v1/memory-vault/:memoryVaultItemId
PATCH  /api/v1/memory-vault/:memoryVaultItemId
DELETE /api/v1/memory-vault/:memoryVaultItemId
```

**Memory Vault media**

```text
POST   /api/v1/memory-vault/:memoryVaultItemId/media/upload-url
POST   /api/v1/memory-vault/:memoryVaultItemId/media/:mediaAssetId/complete
GET    /api/v1/memory-vault/:memoryVaultItemId/media
GET    /api/v1/memory-vault/:memoryVaultItemId/media/:mediaAssetId/access-url
DELETE /api/v1/memory-vault/:memoryVaultItemId/media/:mediaAssetId
```

**My Story**

```text
GET    /api/v1/my-story/prompts
GET    /api/v1/my-story/prompts?category=:category
GET    /api/v1/my-story/prompts/:promptKey
GET    /api/v1/my-story/prompts/:promptKey/response
PUT    /api/v1/my-story/prompts/:promptKey/response
DELETE /api/v1/my-story/prompts/:promptKey/response
```

**My Wishes**

```text
GET    /api/v1/my-wishes/prompts
GET    /api/v1/my-wishes/prompts?category=:category
GET    /api/v1/my-wishes/prompts/:promptKey
GET    /api/v1/my-wishes/prompts/:promptKey/response
PUT    /api/v1/my-wishes/prompts/:promptKey/response
DELETE /api/v1/my-wishes/prompts/:promptKey/response
```

**Recipient authentication**

```text
POST /api/v1/recipient-auth/request-otp
POST /api/v1/recipient-auth/verify-otp
GET  /api/v1/recipient-auth/me
POST /api/v1/recipient-auth/logout
```

**Recipient Portal**

```text
GET /api/v1/recipient/messages
GET /api/v1/recipient/messages/:messageId
GET /api/v1/recipient/messages/:messageId/media
GET /api/v1/recipient/messages/:messageId/media/:mediaAssetId/access-url
```

**Trusted Contact authentication (Step 14)**

```text
POST /api/v1/trusted-contact-auth/request-otp
POST /api/v1/trusted-contact-auth/verify-otp
GET  /api/v1/trusted-contact-auth/me
POST /api/v1/trusted-contact-auth/logout
```

**Trusted Contact Portal (Step 14)**

```text
GET  /api/v1/trusted-contact/accounts
POST /api/v1/trusted-contact/accounts/:trustedContactId/death-reports
GET  /api/v1/trusted-contact/accounts/:trustedContactId/death-verification
```

**Death verification — Customer (Step 15)**

```text
GET  /api/v1/death-verification/me
POST /api/v1/death-verification/me/confirm-alive
```

**Death verification — Admin (Step 15)**

```text
GET  /api/v1/admin/death-verifications
GET  /api/v1/admin/death-verifications?status=:status
GET  /api/v1/admin/death-verifications/:caseId
POST /api/v1/admin/death-verifications/:caseId/verify
POST /api/v1/admin/death-verifications/:caseId/reject
```

</details>

---

## 🔐 Three separate sessions

| Principal | Cookie | Protected namespaces |
|---|---|---|
| **Customer** | `for_after_session` | `/auth/me`, `/recipients`, `/trusted-contacts`, `/messages`, `/memory-vault`, `/my-story`, `/my-wishes` |
| **Recipient** | `for_after_recipient_session` | `/recipient-auth/me`, `/recipient/messages` |
| **Trusted Contact** | `for_after_trusted_contact_session` | `/trusted-contact-auth/me`, `/trusted-contact/accounts` |

> 🔒 No session type authorizes another's protected routes (`401`), in any combination.

---

## 🚫 Not public (by design)

These are intentionally **not** public APIs as of Step 15:

| Area | Not available |
|---|---|
| Release | manual Message release, `MessageRelease` creation, `RecipientMessageAccessGrant` creation, grant modification/revocation |
| Death | evidence upload, second-contact confirmation, automatic/consensus verification (never), reversing a decision, reopening a closed case |
| Admin | everything beyond death verification (full admin backend is Step 16), admin sign-up (never) |
| Identity | Recipient or Trusted Contact passwords, SMS OTP |
| Recipient extras | replies, read receipts, delivery receipts |
| Platform | Admin Portal, Billing / Stripe, OpenAI / Gemini, VIDEO |

---

## 🔁 End-to-end flows

### Recipient (Steps 12–13)

```text
POST /auth/login                            (Customer)
  ↓
POST /recipients → POST /messages → POST /messages/:messageId/schedule (FIXED_DATE)
  ↓
FIXED_DATE reaches due time → BullMQ releases → MessageRelease + RecipientMessageAccessGrant
  ↓
POST /recipient-auth/request-otp → POST /recipient-auth/verify-otp → GET /recipient-auth/me
  ↓
GET /recipient/messages → /:messageId → /media → /media/:mediaAssetId/access-url
```

### Trusted Contact (Step 14)

```text
POST /auth/login                            (Customer)
  ↓
POST /trusted-contacts {email}              (optionally: an ON_DEATH message)
  ↓
POST /trusted-contact-auth/request-otp → POST /trusted-contact-auth/verify-otp → GET /trusted-contact-auth/me
  ↓
GET  /trusted-contact/accounts
  ↓
POST /trusted-contact/accounts/:trustedContactId/death-reports   → 201 PENDING_VERIFICATION
  ↓
GET  /trusted-contact/accounts/:trustedContactId/death-verification
  ↓
(a report alone verifies nothing and releases nothing)
```

### Death verification → release (Step 15)

```text
report (above) → safety notice to the account holder → SAFEGUARD_ACTIVE
  ↓                                   ↘ Customer: POST /death-verification/me/confirm-alive → CANCELLED
safeguard ends → READY_FOR_REVIEW
  ↓
Admin: GET /admin/death-verifications/:caseId → POST …/verify {verifiedDeathAt}   (or …/reject → REJECTED)
  ↓
VERIFIED → account PASSED → DeathTriggeredMessageActivation per ON_DEATH / AFTER_DEATH Message
  ↓
message-release queue → MessageRelease + RecipientMessageAccessGrant → Recipient Portal (Step 13)
```

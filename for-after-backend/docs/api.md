# 🌐 For After — API Reference

> The API's endpoints, authentication, response formats and error handling. Routes marked "Step N" are built and
> tested; the rest are the planned design.

| | |
|---|---|
| **Built** | Steps 1–16: Customer, Recipient (Step 13), Trusted Contact (Step 14), death verification (Step 15) and the admin backend with mandatory TOTP (Step 16) |
| **Base URL** | `http://localhost:4000/api/v1` (dev) · `https://api.forafter.com.au/api/v1` (prod) |
| **Quick list** | [for-after-api-endpoints-step-1-to-13.md](for-after-api-endpoints-step-1-to-13.md) (covers Steps 1–15) |
| **Related** | [Admin backend](admin.md) · [Authentication](authentication.md) · [Authorization](authorization.md) · [Database](database.md) |

## 🧭 Contents

1. [Base URL](#1-base-url)
2. [Authentication](#2-authentication)
3. [Response format](#3-response-format)
4. [Complete endpoint reference](#4-complete-endpoint-reference)
5. [Request/response examples](#5-requestresponse-examples)
6. [Error codes](#6-error-codes)
7. [Rate limiting](#7-rate-limiting)

---

## 1. Base URL

- **Production**: `https://api.forafter.com.au/api/v1`
- **Development**: `http://localhost:4000/api/v1`

## 2. Authentication

The API uses **session-based authentication** with `HttpOnly` cookies. All authenticated endpoints require a valid
session cookie. From the frontend, include `credentials: 'include'` in your fetch/axios configuration.

| Principal | Cookie | Set by |
|---|---|---|
| Customer | `for_after_session` | `POST /auth/login` |
| Recipient | `for_after_recipient_session` | `POST /recipient-auth/verify-otp` |
| Trusted Contact | `for_after_trusted_contact_session` | `POST /trusted-contact-auth/verify-otp` |
| Admin (Step 16; own cookie since the Step 23 follow-up) | `for_after_admin_session` (a `User` with role `ADMIN`/`SUPER_ADMIN`; read only on `/admin/*` and `/admin-auth/*`) | `POST /admin-auth/totp/confirm`, `/totp/verify` or `/recovery/verify`, after `POST /auth/login` returned an MFA challenge |

No cookie authorizes another principal's routes (`401`). Admin routes additionally require the role **and** a completed
second factor in the session (Customers get `403`); admin sessions expire after 30 minutes idle (`401`).

## 3. Response Format

All responses are returned in JSON format. The standard error format includes the status code, a message, and optional error details.

```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request",
  "details": ["email must be an email"]
}
```

## 4. Complete Endpoint Reference

### Auth Endpoints
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/auth/register` | Create account (body: `email`, `password`, `firstName`, `lastName`) |
| `POST` | `/auth/login` | Customer: session cookie + user. **Admin (Step 16): `{mfaRequired: true, mfaSetupRequired, challengeId, expiresInSeconds}`, no cookie** |
| `POST` | `/auth/logout` | Ends the Customer session only. Admins use `POST /admin-auth/logout` (audited `ADMIN_LOGOUT`) |
| `GET` | `/auth/me` | Current user profile (also the profile read for account settings, Step 22) |
| `POST` | `/auth/change-password` | Step 22, Customer only. Body exactly `{currentPassword, newPassword}` (new: 12–128, same rule as register, must differ). `200 {success: true}`; this browser gets a new session id, every other session of the Customer gets `401`. Wrong current password `400` (never `401`); 5/min per IP; audited `PASSWORD_CHANGED`. Admins `403`, Recipient/Trusted Contact `401` |
| `POST` | `/auth/verify-email` | Verify email token |
| `POST` | `/auth/resend-verification` | Resend activation |
| `POST` | `/auth/forgot-password` | Request reset email |
| `POST` | `/auth/reset-password` | Execute password reset |
| `POST` | `/auth/2fa/*` | Planned optional Customer 2FA. Admin TOTP is built under `/admin-auth` (below) |

### Admin Auth (Step 16)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/admin-auth/totp/setup` | `{challengeId}` → `{secret, otpauthUri}` once; first enrollment only (`409` after) |
| `POST` | `/admin-auth/totp/confirm` | `{challengeId, code}` → admin profile + `recoveryCodes` (10, shown once) + session |
| `POST` | `/admin-auth/totp/verify` | `{challengeId, code}` → admin profile + session |
| `POST` | `/admin-auth/recovery/verify` | `{challengeId, recoveryCode}` → admin profile + `remainingRecoveryCodes` + session |
| `GET` | `/admin-auth/me` | `{id, email, firstName, lastName, role, mfaEnabled, mfaVerified, mfaVerifiedAt}` |

`code` must be 6 digits and `recoveryCode` 16 characters (`400` otherwise). Every failure is a generic `401`; 5 attempts
per challenge; 20 second-factor attempts per IP per 15 minutes (`429`). Details: `docs/admin.md`.

### Admin (Step 16)
All `SessionAuthGuard` + `AdminGuard` (role + MFA). Lists return `{items, pagination: {page, limit, total, pages}}`,
`limit` default 25, max 100.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/admin/dashboard` | `{users: {total, active, suspended, passed, deleted}, deathVerification: {pending, safeguardActive, readyForReview}, queues: {failed}}` |
| `GET` | `/admin/users` | `?page&limit&search&status&role`; safe account fields only |
| `GET` | `/admin/users/:userId` | Metadata + counts + death case status; never content. Audited |
| `POST` | `/admin/users/:userId/suspend` | `{reason}` (required, ≤1000): `ACTIVE → SUSPENDED`; `403` self/insufficient role; `409` wrong state |
| `POST` | `/admin/users/:userId/reactivate` | `{reason?}`: `SUSPENDED → ACTIVE` only; `PASSED`/`DELETED` → `409` |
| `GET` | `/admin/audit-logs` | `?page&limit&eventType&actorUserId&subjectType&subjectId&from&to` |
| `GET` | `/admin/audit-logs/:auditLogId` | One row. No update/delete routes exist |
| `GET` | `/admin/system/queues` | `message-release`, `death-verification` job counts |
| `GET` | `/admin/system/queues/:queueName/failed` | `?page&limit`; sanitized reason, id-only payload; unknown queue `404` |
| `POST` | `/admin/system/queues/:queueName/jobs/:jobId/retry` | Failed jobs only (`409` otherwise); worker re-checks PostgreSQL. Audited |

### Recipient Auth (OTP)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/recipient-auth/request-otp` | Step 13. Email only. Always `202 {challengeId, message}`; code sent only if released content exists |
| `POST` | `/recipient-auth/verify-otp` | Step 13. `{challengeId, code}` → `200` + `for_after_recipient_session` cookie; any failure `401` |
| `GET` | `/recipient-auth/me` | Step 13. `{authenticated: true, email}` |
| `POST` | `/recipient-auth/logout` | Step 13. `204`, clears the Recipient session and cookie |

Implemented in Step 13 as `request-otp` / `verify-otp` (the earlier plan said `request-code` / `verify-code`). SMS is deferred.
Details, limits and error rules: `docs/recipient-portal.md`.

### Users
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `PATCH` | `/users/me` | Step 22, Customer only. Body: `firstName` and/or `lastName` (trimmed, 1–100, cannot be cleared or `null`). Any other field (email, role, status, id…) is `400`. Returns the same user as `GET /auth/me`. Admins `403`, Recipient/Trusted Contact `401`. There is no `/users/:id`. Email change (with verification) is not built; email is read-only |

Admin user listing is `/admin/users` (Step 16); there is deliberately no admin create/role-edit/delete API.

### Recipients (People I Love)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/recipients` | List loved ones |
| `POST` | `/recipients` | Create recipient (body: `firstName`, `lastName`, `relationship`, `email`, `mobile`) |
| `GET` | `/recipients/:id` | Get recipient |
| `PATCH` | `/recipients/:id` | Update recipient |
| `DELETE`| `/recipients/:id` | Remove recipient (soft delete, 204) |

"People I Love" = `Recipient`. All five routes require a session **and** the `CUSTOMER` role (others get 403).
Every query is scoped to the session user's id (`ownerUserId`), which is never accepted from the body.
A recipient that is missing, deleted or owned by someone else gives the same `404 Recipient not found.`
Body fields: `firstName` (required), `lastName`, `relationship`, `email`, `mobile`, `birthday` (`YYYY-MM-DD`), `privateNote` (max 2000).
In `PATCH`, all are optional and optional fields accept `null` to clear. Any other field returns 400. A non-UUID `:id` returns 400.
Responses never include `ownerUserId` or `deletedAt`.

### Trusted Contacts
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/trusted-contacts` | List trusted contacts |
| `POST` | `/trusted-contacts` | Add trusted contact (no invite is sent yet) |
| `GET` | `/trusted-contacts/:id` | Get trusted contact |
| `PATCH` | `/trusted-contacts/:id` | Update trusted contact |
| `DELETE`| `/trusted-contacts/:id` | Remove trusted contact (soft delete, 204) |

Same rules as Recipients: all five routes require a session **and** the `CUSTOMER` role (others get 403).
Every query is scoped to the session user's id, which is never accepted from the body.
A contact that is missing, deleted or owned by someone else gives the same `404 Trusted contact not found.`
A non-UUID `:id` returns 400, and responses never include `ownerUserId` or `deletedAt`.
Body fields: `firstName` (required), `lastName`, `relationship`, `email`, `mobile`.
**At least one of `email` / `mobile` is required, and must remain after any PATCH**: clearing the last one returns 400.
A trusted contact is not a User and gets no access to the owner's content. Since Step 14 the contact can sign in by email OTP
to report a death (see "Trusted Contact Auth & Portal" below); nothing is sent to them when they are added.
There is no maximum per customer yet; the PRD says "1 or 2", but PROJECT_OVERVIEW �58 lists this as open.

### Messages
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/messages` | List own messages, newest first |
| `POST` | `/messages` | Create a TEXT draft assigned to own recipients (201) |
| `GET` | `/messages/:id` | Get own message |
| `PATCH` | `/messages/:id` | Update own DRAFT (`title`, `textContent`, `recipientIds`) |
| `DELETE`| `/messages/:id` | Soft delete own DRAFT (204) |

Implemented in Step 5. All five routes require a session **and** the `CUSTOMER` role (admins get 403; any future admin access needs separate audited APIs).
`ownerUserId` always comes from the session. `status` is server-controlled: every message is created `DRAFT`, and neither field is accepted in a body (400).
Body fields (create): `title` (required, trimmed, 1-200), `contentType` (optional, default `TEXT`; `TEXT` | `PHOTO` | `AUDIO` | `MIXED`, `VIDEO` returns 400),
`textContent` (optional, plain text, outer whitespace trimmed, blank stored as `null`, max 20,000, product-configurable), `recipientIds` (required, 1-100 unique UUIDs).
Drafts may be incomplete (e.g. a `PHOTO` draft before its upload, `TEXT` with no text yet): completeness is checked when scheduling (see `docs/message-composition.md`).
`PATCH` accepts the same fields, all optional. Only `textContent` accepts `null` (clears it); a missing field is left unchanged. `recipientIds` replaces the whole assignment list atomically.
Changing `contentType` never deletes or changes attached media, and the server never changes `contentType` on its own.
Every recipient id must be a live (non-deleted) recipient of the same customer, otherwise the whole request fails with `400 One or more recipients are invalid.` (it never says which or whose).
A message that is missing, deleted or owned by someone else gives `404 Message not found.`; an owned message that is not `DRAFT` gives `409` on `PATCH`/`DELETE`.
A non-UUID `:id` returns 400. Responses never include `ownerUserId`, `deletedAt` or join-table ids; `recipients` is `[{ id, firstName, lastName, relationship }]` (recipients deleted after assignment are omitted).
Assignment is part of create/update, replacing the planned `POST /messages/:id/recipients`.
A `SCHEDULED` message cannot be edited or deleted here (409): unschedule it first (see Message Schedules).
**Draft content is private.** Future recipient-facing APIs must only ever return a message whose `status = RELEASED` **and** that has a `MessageRecipient` row for the requesting recipient.

### Message Schedules
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/messages/:messageId/schedule` | Schedule an own DRAFT message (201); message becomes `SCHEDULED` |
| `GET` | `/messages/:messageId/schedule` | Get the schedule |
| `PATCH` | `/messages/:messageId/schedule` | Change the schedule of a `SCHEDULED` message |
| `DELETE`| `/messages/:messageId/schedule` | Unschedule (204); message returns to `DRAFT` (not `CANCELLED`) |

Implemented in Step 6. Since Step 12 a `FIXED_DATE` schedule is **executed**: at `scheduledFor` an internal worker moves the message to `RELEASED`
(nothing is sent or delivered yet). Since Step 15 `ON_DEATH`/`AFTER_DEATH` run only after an admin-verified death (see
`docs/death-verification.md`). See `docs/scheduling.md` and `docs/message-release.md`.
All four routes require a session **and** the `CUSTOMER` role (others get 403). A non-UUID `:messageId` returns 400.
Scoped through the message owner: a message that is missing, deleted or someone else's gives `404 Message not found.`; an own message without a schedule gives `404 Schedule not found.`
Body: `triggerType` (required on POST) is one of `FIXED_DATE`, `ON_DEATH`, `AFTER_DEATH`. `NOW`, `BIRTHDAY`, `ANNIVERSARY`, `CUSTOM_EVENT`, `ANNUAL_AFTER_DEATH` return 400 (reserved).

| triggerType | `scheduledFor` | `afterDeathDays` |
| :--- | :--- | :--- |
| `FIXED_DATE` | required: ISO 8601 date-time **with offset** (`Z` or `+08:00`), in the future; returned in UTC | not allowed |
| `ON_DEATH` | not allowed | not allowed |
| `AFTER_DEATH` | not allowed | required integer 0-36,500 (0 is kept as `AFTER_DEATH`) |

`null` counts as "not set". Contradictory fields return 400; they are never silently dropped.
`PATCH` takes any of the three fields, merges them with the stored schedule and validates the complete result. Changing `triggerType` clears fields the new type does not use unless they are sent again.
Errors: `POST` on an already scheduled message 409; `POST` on a non-DRAFT message 409; a message with no live (non-deleted) recipient 400;
`POST` on an incomplete composition 409 with the reason (e.g. `PHOTO messages require at least one ready photo.`, see `docs/message-composition.md`);
`PATCH`/`DELETE` on a `RELEASED`/`CANCELLED` message 409. `status` is never accepted in any body (nor `releasedAt`, `release`, `releaseId` or job fields: 400).
Response: `{ id, triggerType, scheduledFor, afterDeathDays, createdAt, updatedAt }` (no `messageId`, no message fields).

### Message release (internal, Step 12)
There is **no** release endpoint: customers cannot release or bypass timing. The worker releases a due `FIXED_DATE` message after
re-checking PostgreSQL; `GET /messages/:id` then shows `status: "RELEASED"` (no queue, job or retry details, and no new fields).
A `RELEASED` message is read-only: message `PATCH`/`DELETE`, media upload/complete/delete and schedule `POST`/`PATCH`/`DELETE` give 409;
`GET` of the message, its schedule (kept for history) and its media still work. Released is not delivered: no email, SMS or recipient access yet.

### Media (message attachments)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/messages/:messageId/media/upload-url` | Authorize an upload to an own DRAFT message (201) |
| `POST` | `/messages/:messageId/media/:mediaAssetId/complete` | Verify the upload in storage; `READY` (200) |
| `GET` | `/messages/:messageId/media` | List the message's media |
| `GET` | `/messages/:messageId/media/:mediaAssetId/access-url` | Short-lived signed download URL (READY only) |
| `DELETE`| `/messages/:messageId/media/:mediaAssetId` | Soft delete, then remove the stored object (204) |

Implemented in Step 7. All five routes require a session **and** the `CUSTOMER` role (others get 403); non-UUID ids return 400.
**File bytes never go through the API**: the client `PUT`s the file straight to the private bucket using `uploadUrl`, sending exactly `requiredHeaders`
(the signed `Content-Type`) and **no** session cookie or `Authorization` header. See `docs/media-storage.md`.

Upload body: `kind` (`PHOTO` | `AUDIO`; `VIDEO` is 400), `originalFileName` (trimmed, 1-255, metadata only), `mimeType`, `sizeBytes` (integer >= 1).

| kind | mimeType | Max size (default, `MEDIA_*_MAX_BYTES`) |
| :--- | :--- | :--- |
| `PHOTO` | `image/jpeg`, `image/png`, `image/webp` | 20 MB (20,971,520) |
| `AUDIO` | `audio/mpeg`, `audio/mp4`, `audio/webm`, `audio/wav` | 100 MB (104,857,600) |

A MIME type of the other kind, SVG, wildcards, oversize or any extra field (`ownerUserId`, `storageKey`, `status`, ...) returns 400.
Upload response: `{ mediaAssetId, uploadUrl, expiresAt, requiredHeaders: { "Content-Type" } }` (URL valid `MEDIA_UPLOAD_URL_TTL_SECONDS`, default 600).
`complete`: HEADs the object. Not uploaded yet: 409 (retry after uploading). Size or type differs: 400 and the asset becomes `FAILED` (request a new URL).
Already `READY`: returns it unchanged.
Media response: `{ id, kind, status, originalFileName, mimeType, sizeBytes, uploadedAt, createdAt, updatedAt }`; never `storageKey`, `ownerUserId` or `deletedAt`.
Access response: `{ url, expiresAt }` (default 300 s); only for `READY` media (otherwise 409).
Message state: upload, complete and delete need a **DRAFT** message (`SCHEDULED`/`RELEASED`/`CANCELLED` give 409; unschedule first). List and access-url work in any state.
Uploads do not depend on the message's `contentType` (a TEXT draft may upload a photo before switching to MIXED); scheduling checks the final composition.
A message or media item that is missing, deleted or someone else's gives 404. Storage outages give a generic 503; provider errors are never passed through.
Owner-only: recipients, trusted contacts and admins have no media access yet.

### Memory Vault
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/memory-vault` | Create a memory (201) |
| `GET` | `/memory-vault` | List own memories, newest first; optional `?category=FAMILY` |
| `GET` | `/memory-vault/:memoryVaultItemId` | Get one |
| `PATCH` | `/memory-vault/:memoryVaultItemId` | Update `title`, `category`, `textContent` |
| `DELETE`| `/memory-vault/:memoryVaultItemId` | Soft delete (204); its media becomes unreachable |
| `POST` | `/memory-vault/:memoryVaultItemId/media/upload-url` | Authorize a PHOTO/AUDIO upload (201) |
| `POST` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId/complete` | Verify the upload; `READY` (200) |
| `GET` | `/memory-vault/:memoryVaultItemId/media` | List the memory's media |
| `GET` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId/access-url` | Short-lived signed download URL (READY only) |
| `DELETE`| `/memory-vault/:memoryVaultItemId/media/:mediaAssetId` | Soft delete, then remove the stored object (204) |

Implemented in Step 9 (`docs/memory-vault.md`). Session + `CUSTOMER` role (others 403); non-UUID ids 400.
Body: `title` (required, trimmed, 1-200), `category` (`FAMILY`, `TRAVEL`, `CHILDHOOD`, `FUNNY_STORIES`, `LIFE_LESSONS`, `RECIPES`,
`LOVE_STORIES`, `OTHER`), `textContent` (optional, max 20,000, blank becomes `null`; PATCH: missing = unchanged, `null` = clear).
Any other field (`ownerUserId`, `status`, `recipientIds`, `contentType`, `storageKey`, ...) or an unknown `?category` is 400.
Response: `{ id, title, category, textContent, createdAt, updatedAt }`. A memory is private: no status, recipients or schedule.
Media: identical upload body, limits, responses and errors to message media above, except there is no DRAFT rule (memories are
always editable). Missing, deleted or someone else's memory/media: 404.

### My Story
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/my-story/prompts` | Prompt catalogue with the customer's answers; optional `?category=CHILDHOOD` |
| `GET` | `/my-story/prompts/:promptKey` | One prompt with the customer's answer (or `response: null`) |
| `GET` | `/my-story/prompts/:promptKey/response` | The customer's answer (404 if not answered) |
| `PUT` | `/my-story/prompts/:promptKey/response` | Create, update or restore the answer (always 200) |
| `DELETE`| `/my-story/prompts/:promptKey/response` | Soft delete (204); the prompt can be answered again |

Implemented in Step 10 (`docs/my-story.md`). Session + `CUSTOMER` role (others 403).
`:promptKey` is a catalogue key such as `childhood.earliest-memory`: malformed (uppercase, slashes, `..`) 400, unknown 404.
`?category`: `CHILDHOOD`, `FAMILY`, `RELATIONSHIPS`, `MILESTONES`, `VALUES`, `LIFE_LESSONS`, `LEGACY`; anything else 400.
PUT body: `{ "textContent": "..." }` only: required string, not blank/whitespace-only, max 20,000, stored exactly as written.
Any other field (`ownerUserId`, `promptVersion`, `promptTextSnapshot`, `promptKey`, `recipientIds`, ...) is 400.
Prompt: `{ key, category, version, prompt, answered, response }`. Response: `{ id, promptKey, textContent, createdAt, updatedAt }`.
There is no separate `/my-story/responses` list: `GET /my-story/prompts` already returns every answer.

### My Wishes
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/my-wishes/prompts` | Wish prompts with the customer's answers; optional `?category=CEREMONY` |
| `GET` | `/my-wishes/prompts/:promptKey` | One prompt with the customer's answer (or `response: null`) |
| `GET` | `/my-wishes/prompts/:promptKey/response` | The customer's answer (404 if not answered) |
| `PUT` | `/my-wishes/prompts/:promptKey/response` | Create, update or restore the answer (always 200) |
| `DELETE`| `/my-wishes/prompts/:promptKey/response` | Soft delete (204); the prompt can be answered again |

Implemented in Step 11 (`docs/my-wishes.md`). Personal preferences and guidance only, not a will or legal document.
Same rules and response shapes as My Story: session + `CUSTOMER` role (others 403); malformed `:promptKey` 400, unknown 404
(My Story keys are unknown here); PUT body `{ "textContent": "..." }` only (required, not blank, max 20,000, stored as written);
any other field (`ownerUserId`, `promptVersion`, `promptTextSnapshot`, `recipientIds`, `acceptedLegalDisclaimer`, ...) 400.
`?category`: `CEREMONY`, `ATMOSPHERE`, `MUSIC_AND_READINGS`, `PEOPLE_AND_TRADITIONS`, `PERSONAL_PREFERENCES`, `PERSONAL_MESSAGE`,
`OTHER`; anything else 400. No `/my-wishes/responses` list and no `/wishes` route.

### Recipient Portal
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/recipient/messages` | Step 13. Released Messages granted to the verified email, newest first |
| `GET` | `/recipient/messages/:messageId` | Step 13. Released content (`textContent`); `404` without a grant |
| `GET` | `/recipient/messages/:messageId/media` | Step 13. READY PHOTO/AUDIO only |
| `GET` | `/recipient/messages/:messageId/media/:mediaAssetId/access-url` | Step 13. Short-lived signed GET URL |

Recipient session only (`for_after_recipient_session`); a Customer session gets `401`. Read-only. Draft, scheduled, deleted,
unknown and other people's Messages are all `404`. Replaces the planned `/recipient/vault`. See `docs/recipient-portal.md`.

### Trusted Contact Auth & Portal (Step 14)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/trusted-contact-auth/request-otp` | Email only. Always `202 {challengeId, message}`; code sent only to an active Trusted Contact email |
| `POST` | `/trusted-contact-auth/verify-otp` | `{challengeId, code}` → `200 {authenticated, email}` + `for_after_trusted_contact_session`; any failure `401` |
| `GET` | `/trusted-contact-auth/me` | `{authenticated: true, email}` |
| `POST` | `/trusted-contact-auth/logout` | `204`, clears the Trusted Contact session and cookie |
| `GET` | `/trusted-contact/accounts` | `[{trustedContactId, accountHolder: {displayName}, relationship, hasPreservedContent, deathVerificationStatus}]` |
| `POST` | `/trusted-contact/accounts/:trustedContactId/death-reports` | `{reportedDateOfDeath?, note?, confirmReport: true}` → `201`; case opens `PENDING_VERIFICATION` and moves to `SAFEGUARD_ACTIVE` once the safety notice is sent (Step 15); same contact again `409`; closed case `409` |
| `GET` | `/trusted-contact/accounts/:trustedContactId/death-verification` | `{status, reportedByYou, openedAt}` (`status` `null` when no case) |

Trusted Contact session only; Customer and Recipient sessions get `401`, and a Trusted Contact session gets `401` on every
Customer and Recipient route. A `:trustedContactId` that is not one of the signed-in email's active relationships is `404`.
A report does not verify death or release anything. See `docs/trusted-contact-auth.md` and `docs/death-verification.md`.

### Death Verification — Customer (Step 15)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/death-verification/me` | `{status, safeguardEndsAt, canConfirmAlive}`; `status` `null` when there is no case |
| `POST` | `/death-verification/me/confirm-alive` | `{confirmAlive: true}` → `200`, open case → `CANCELLED`; no case `404`; closed case `409` |

Customer session + `CUSTOMER` role. Never returns Trusted Contact identity, report notes, report count or admin notes.
After a case is `VERIFIED` the account is `PASSED`, so these routes (like every Customer route) return `401`.

### Death Verification — Admin (Step 15; paginated + audited in Step 16)
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/admin/death-verifications[?status&page&limit]` | `{items, pagination}` (Step 16; was a bare array of the newest 200): cases with report count and account holder (id, email, name) |
| `GET` | `/admin/death-verifications/:caseId` | Review detail: timeline, reports (snapshots, date, note), audit trail, activations. Writes `ADMIN_VIEWED_DEATH_CASE` |
| `POST` | `/admin/death-verifications/:caseId/verify` | `{verifiedDeathAt (ISO 8601 + offset, not future), confirmVerification: true, decisionNote?}` → `VERIFIED`; only from `READY_FOR_REVIEW`, else `409` |
| `POST` | `/admin/death-verifications/:caseId/reject` | `{confirmRejection: true, decisionNote?}` → `REJECTED`; only from `READY_FOR_REVIEW`, else `409` |

`ADMIN` / `SUPER_ADMIN` only (`SessionAuthGuard` + `AdminGuard`): Customers get `403`, Recipient/Trusted Contact sessions
`401`. Non-UUID `:caseId` → `400`, unknown → `404`. No force/override exists: the safeguard can never be skipped. Unknown or
injected fields (`status`, `ownerUserId`, `verifiedByUserId`, `deathTriggersActivatedAt`, …) → `400`.

Verify/reject also write `DEATH_VERIFICATION_VERIFIED` / `_REJECTED` to the generic `AuditLog` (same transaction).

**Still planned (not built):** evidence upload, second-contact confirmation (`/death-verifications/:id/confirm`). The original `/admin/death-verifications/:id/approve` is built as `…/verify`. Full workflow:
`docs/death-verification.md`.

### Subscriptions
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/subscriptions/checkout` | Stripe checkout session |

### Webhooks
| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/webhooks/stripe` | Stripe lifecycle events |
| `POST` | `/webhooks/mux` | Video transcode completion |

---

## 5. Request/Response Examples

### Register
**Request:**
```json
POST /auth/register
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "firstName": "John",
  "lastName": "Doe"
}
```
**Response:**
```json
{
  "message": "Registration successful. Please check your email to verify your account."
}
```

### Login
**Request:**
```json
POST /auth/login
{
  "email": "user@example.com",
  "password": "SecurePassword123!"
}
```
**Response:**
```json
{
  "message": "Login successful",
  "user": {
    "id": "uuid-here",
    "email": "user@example.com",
    "firstName": "John",
    "lastName": "Doe",
    "role": "CUSTOMER"
  }
}
```
*(Includes `Set-Cookie` header with the session token)*

### Create Message
**Request:**
```json
POST /messages
{
  "title": "For Sofia",
  "contentType": "TEXT",
  "textContent": "I am so proud of you.",
  "recipientIds": ["recipient-uuid"]
}
```
**Response (201):**
```json
{
  "id": "message-uuid",
  "title": "For Sofia",
  "contentType": "TEXT",
  "textContent": "I am so proud of you.",
  "status": "DRAFT",
  "createdAt": "2026-09-25T10:00:00.000Z",
  "updatedAt": "2026-09-25T10:00:00.000Z",
  "recipients": [
    { "id": "recipient-uuid", "firstName": "Sofia", "lastName": "Smith", "relationship": "Daughter" }
  ]
}
```

### Create Recipient
**Request:**
```json
POST /recipients
{
  "firstName": "Jane",
  "lastName": "Doe",
  "relationship": "Spouse",
  "email": "jane.doe@example.com",
  "mobile": "+61400000000",
  "birthday": "1970-06-01",
  "privateNote": "Fictional example note."
}
```

### Report Death
**Request:**
```json
POST /death-verifications/report
{
  "userId": "uuid-of-customer",
  "evidenceUrl": "https://s3.forafter.../certificate.pdf",
  "notes": "Attached is the certificate from the hospital."
}
```

---

## 6. Error Codes

- `400 Bad Request`: Validation errors, missing fields, invalid format.
- `401 Unauthorized`: Missing or invalid session cookie, authentication required.
- `403 Forbidden`: Authenticated, but lacks required role or permissions (e.g. a Customer on `/admin/*`, an `ADMIN` suspending another admin).
- `404 Not Found`: Resource does not exist.
- `409 Conflict`: Resource already exists (e.g., duplicate email), or a business rule blocks the change (e.g., editing a non-DRAFT message, scheduling twice).
- `429 Too Many Requests`: Rate limit exceeded.
- `500 Internal Server Error`: Unexpected server-side fault.
- `503 Service Unavailable`: a dependency is unavailable (e.g. Redis for `/admin/system/queues`); no internal error text.

---

## 7. Rate Limiting

The API employs rate limiting on critical endpoints to prevent abuse:

- **Login**: 5 attempts per minute
- **Admin second factor** (Step 16): 5 wrong codes per challenge (then sign in again); 20 attempts per IP per 15 minutes
  (Redis, `ADMIN_TOTP_VERIFY_IP_LIMIT`)
- **OTP Requests**: as built (Step 13): 5 per email and 20 per IP per 15 minutes; verify 30 per IP per 15 minutes and 5
  wrong codes per challenge (Redis, configurable, `docs/recipient-portal.md`)
- **Password Reset**: 3 requests per hour
- **Death Reports**: 2 reports per day per user

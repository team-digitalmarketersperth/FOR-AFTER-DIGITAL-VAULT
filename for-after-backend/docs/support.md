# For After — Support requests (Step 7)

A small in-app support workflow: a signed-in Customer asks for help, the For After team replies, and admins keep
internal notes. No external helpdesk, no email/SMS notifications, no attachments, no AI.

## Access

| Who | Routes | Rule |
|---|---|---|
| Customer | `GET/POST /support/requests`, `GET /support/requests/:id`, `POST /support/requests/:id/messages` | `SessionAuthGuard` + `CustomerGuard`; every query is scoped to the session's own id. Another Customer's request (or a guessed id) is the same 404 as a missing one |
| Admin (role + completed MFA) | `GET /admin/support/requests`, `GET /admin/support/requests/:id`, `POST …/:id/replies`, `POST …/:id/notes`, `PATCH …/:id/status` | `SessionAuthGuard` + `AdminGuard`. No new roles: every admin may handle support, as every admin may manage users |
| Recipient, Trusted Contact, anonymous | none | 401 |

Support access grants nothing else: no impersonation, private content, media, evidence, release/delivery, password or
MFA shortcuts. The request is only what the Customer typed; nothing is attached or read from their account.

Frontend: Customer "Help & support" in the account menu (`/support`, `/support/new`, `/support/[id]`); admin
Management → Support (`/admin/support`, `/admin/support/[id]`).

## Data (migration `20261031090000_add_support_requests`, additive)

- `SupportRequest`: owner (FK, cascades with the account like all owned data), subject (3–150), category, description
  (10–5,000), status, `clientRequestId` (unique per owner), `lastPublicActivityAt`, timestamps.
- `SupportMessage`: the public conversation after the description; `authorRole` CUSTOMER/ADMIN, plain `authorUserId`
  (no FK, so a reply outlives an admin account), body (1–5,000), `clientRequestId` (unique per author).
- `SupportInternalNote`: admin-only notes in **their own table**; no Customer query references it.
- Four `AuditEventType` values: `SUPPORT_REQUEST_CREATED`, `SUPPORT_REPLY_SENT`, `SUPPORT_NOTE_ADDED`,
  `SUPPORT_STATUS_CHANGED`.

Plain text only (trimmed, rendered as text). Categories: Account access, Messages and recipients, Uploads and storage,
My Story / My Wishes, Technical issue, Other (no billing: none exists). Applied and drift-checked only on the isolated
`for_after_p24` database, not on the dev or any deployed database. Deploy order: `prisma migrate deploy` before the new
API (old APIs ignore the new tables; the enum values are only added).

## Status

New requests are **Open**. Admins may change to any other status, except that **Resolved** can only be reopened to Open.
Each change sends the status the admin saw (`expectedStatus`); the update is conditional on it, so a concurrent change
by another admin is a 409, never overwritten. A public reply or an internal note never changes the status. A Customer
cannot set status: their follow-up only turns **Waiting for customer** back into **Open** (audited, actor CUSTOMER,
`by: customer_follow_up`). A follow-up on a Resolved request is a 409 asking for a new request; resolved requests stay
readable.

## Visibility

- Replies and notes are separate commands (`/replies`, `/notes`) and separate tables; there is no visibility flag and
  no edit or delete.
- Customer responses select only the request and `SupportMessage` (`id`, `authorRole`, `body`, `createdAt`). Admins are
  shown to the Customer as "For After support"; their ids and emails are not returned.
- Notes never touch the request row, so `lastPublicActivityAt`, the Customer's list order and totals are unchanged by
  them (e2e-tested).

## Duplicates, limits and abuse

- Every write carries a client-generated UUID (`clientRequestId`); the browser keeps it for the draft, so a retry after
  a lost response returns the first result (request, reply, note or follow-up) instead of a second row. The same id on
  a different request is a 409.
- Per-IP limits (Redis throttler, fails closed): create 10/hour, follow-up 30/hour, admin reply/note/status 60/minute.
- At most 20 unresolved requests per Customer (creation is serialised on the User row), and at most 100 messages and
  100 notes per request, so a detail is always bounded without paging the conversation.
- Lists are paginated (max 100 per page), sorted with an id tie-breaker. The inbox filters by status, category, exact
  reference, exact account and created range (max 366 days); no text search.

## Privacy, audit, caching, notifications

- Support text and subjects are never logged or put in audit rows: audit metadata is the category, or previous/new
  status. Logs carry ids only (`support_request_created`, `admin_support_viewed`). The system cannot stop someone
  typing a secret; the form asks them not to.
- `Cache-Control: no-store` on `/api/v1/support/*` (Customer) as on `/api/v1/admin/*`. The frontend drops cached
  support data on sign-out or account change (customer queries) and on admin sign-out (admin queries).
- No notifications: history is in-app only. A future email would go through the existing queue with generic text and a
  plain link, never the text or notes.

## Open policies and gaps

- **Retention** is an open policy: requests are kept until the account is deleted; no automatic deletion.
- No assignment, SLA, priority, escalation, export, attachments, unread counters or notifications.
- No support for Recipients or Trusted Contacts, and none before sign-in.

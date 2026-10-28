# 💾 For After — Message Version History & Draft Recovery

> Saved checkpoints of a Message's words, and server-side autosave of unfinished edits (Messages, My Story, My Wishes).

| | |
|---|---|
| **Status** | ✅ Built 2026-10-14 (local; not committed or deployed) |
| **Policy** | V1 approved 2026-10-14: title + type + text versioned; keep all versions; recovery drafts expire after 30 days; new messages recover through a server-issued key |
| **Code** | `src/messages/message-versions*.ts`, `src/draft-recovery/` · frontend `use-draft-editor.ts`, `shared/draft-recovery.tsx`, `messages/version-history.tsx` |
| **Migration** | `20261014070616_add_message_versions_and_draft_recovery` (additive: 2 tables, 2 enums, 1 activity type) |
| **Related** | [Message composition](message-composition.md) · [API](api.md) · [Security](security.md) |

**Two separate things.** A *version* is an immutable checkpoint made only by an explicit Save or a restore. A
*recovery draft* is temporary unsaved editor state, made by autosave. Autosave never creates a version, never
changes the saved item, and never appears in Recent changes.

---

## 1. Message version history

**Versioned:** `title`, `contentType`, `textContent`. **Not versioned:** media (deleting or replacing a file purges
it from ImageKit straight away, so it could never be restored), recipients, schedule, release state.

**What creates a version** (`MessageVersion`, numbered 1, 2, 3… per message):

| Event | Reason |
|---|---|
| `POST /messages` (and message-from-memory/story/wish) | `CREATED` (version 1, same transaction) |
| `PATCH /messages/:id` that changed title/type/text | `EDITED` |
| Restore of an earlier version | `RESTORED` |

A save that changes nothing versioned (same text, recipients only) creates no version. Autosave, viewing,
scheduling and release never do.

**Messages from before this feature** have no versions (`version: 0` on the message). Nothing is invented: on their
first content-changing save, the content being replaced is kept as version 1 (dated the message's last
`updatedAt`; `CREATED` if it was never edited, else `EDITED`), then the new content becomes version 2. The same
rule protects any content that is not the latest version.

**Concurrency:** saves and restores lock the message row (`SELECT … FOR UPDATE`, the lock scheduling and media
use), so version numbers never collide or skip; `@@unique([messageId, version])` is the backstop.

**Restore** (`POST /messages/:id/versions/:versionId/restore`): `DRAFT` only. `SCHEDULED` → 409 (unschedule
first; never automatic). `RELEASED` → 409, history read-only. The current content is already the latest version
(or is recorded first), so restoring is reversible. Only title/type/text change: media, recipients and schedule are
untouched, nothing is queued or released. Writes a `MESSAGE_VERSION_RESTORED` Recent-changes row (ids only) and
clears the message's recovery draft. Restoring the current content is a no-op.

**Retention:** all versions are kept (pruning not approved; open decision). They go with the message on account
deletion (cascade). A soft-deleted message's history is unreachable through every route. Versions can't be deleted
individually.

**Not an audit log.** Version content never goes to `AuditLog` (customer message actions are not audited today);
only metadata reaches Recent changes.

## 2. Draft recovery (autosave)

`DraftRecovery`: one row per Customer and `(type, key)`:

| type | key | Rules |
|---|---|---|
| `MESSAGE` | Message id | own, live, `DRAFT` only (409 otherwise) |
| `NEW_MESSAGE` | server-issued UUID (`POST /users/me/drafts/NEW_MESSAGE`) | must have been issued to this Customer; at most the 5 newest are kept; no Message row exists until Save |
| `MY_STORY` | prompt key | catalogue prompt only |
| `MY_WISHES` | prompt key | catalogue prompt (no notice acknowledgement needed) |

**Payload** is validated per type with a whitelist (`forbidNonWhitelisted`): messages `{title, contentType,
textContent}`, answers `{textContent}`, same length limits as Save. Ids, status, recipients, media, snapshots are
400. Partial text is allowed (it is unsaved); Save still runs full validation.

**Cadence (frontend):** 2.5 s after typing stops, only when the content differs from what the server already holds
(saved item or last autosave); one request in flight at a time; a final `keepalive` save on `pagehide` /
tab hidden. The server skips writes whose payload is unchanged.

**Recovery:** when an editor opens it asks for its draft. A draft identical to the saved item is deleted and not
offered. Otherwise the editor shows *Unsaved changes found* with Restore / Discard and a preview; nothing autosaves
until the Customer decides, and nothing is restored automatically.

**Conflicts:** each draft keeps the `baseRevision` the editor started from (a message's version number; for answers
a FNV-1a hash of the saved text, computed identically on both sides). If the saved item has moved on, the draft is
flagged `conflict`: the UI offers Preview and Discard only (no merge in V1).

**Cleared by:** the explicit Save (same transaction: `PATCH /messages/:id`, `POST /messages` with
`recoveryDraftKey`, My Story / My Wishes `PUT …/response`), a restore, Discard, deleting the message, account
deletion (cascade). Navigating away never deletes it.

**Retention:** `expiresAt` = last autosave + 30 days. Expired drafts are never returned and are deleted on the
Customer's next autosave (no scheduled job).

**Privacy:** drafts are private content. Never logged (tests assert the app log and `AuditLog` contain none),
never in Recent changes, never visible to admins, Recipients or Trusted Contacts (customer routes only), never in
browser storage. Rate limit: 120 autosave writes/min per IP (`ThrottlerGuard`).

## 3. API

| Method | Endpoint | Notes |
|---|---|---|
| `GET` | `/messages/:id/versions` | `?page&limit`; newest first; `{id, version, reason, createdAt, isCurrent}` only |
| `GET` | `/messages/:id/versions/:versionId` | + `title, contentType, textContent` |
| `POST` | `/messages/:id/versions/:versionId/restore` | 200 → the message; 409 unless `DRAFT` |
| `GET` | `/users/me/drafts/NEW_MESSAGE` | newest unsaved new message, or empty |
| `POST` | `/users/me/drafts/NEW_MESSAGE` | `{payload}` → 201 draft with its issued `key` |
| `GET` | `/users/me/drafts/:type/:key` | draft `{key, payload, baseRevision, currentRevision, conflict, updatedAt}` or empty body |
| `PUT` | `/users/me/drafts/:type/:key` | `{payload, baseRevision}` |
| `DELETE` | `/users/me/drafts/:type/:key` | 204 (Discard) |

Another Customer's message (or version) is 404 on every route. `GET /messages/:id` now includes `version` (current
version number, 0 before history).

## 4. Tests

Backend unit: `messages.service.spec.ts` (checkpoints, no-op, legacy baseline, lock, clears autosave),
`my-story`/`my-wishes` specs (save clears autosave), `draft-recovery.service.spec.ts` (hash vectors).
Backend e2e: `test/message-versions.e2e-spec.ts` (10), `test/draft-recovery.e2e-spec.ts` (18).
Frontend: `shared/draft-recovery.test.tsx` (13), `messages/version-history.test.tsx` (5).
Playwright: `e2e/history.vault.spec.ts` (5 scenarios; run against an isolated console-email API).

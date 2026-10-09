# 📸 For After — Memory Vault (Step 9)

> Private memories with text, photos and audio. Not a Message: nothing here is shared, scheduled or released.

| | |
|---|---|
| **Status** | ✅ Built in Step 9 · search, tags and pagination (Phase 13A) · create a message from a memory (Phase 13B), 2026-10-08 |
| **Who can see it** | Only the Customer who wrote it: no Recipient, Trusted Contact (incl. Step 14) or admin access |
| **Related** | [Media storage](media-storage.md) · [My Story](my-story.md) · [API](api.md) |

**Contents:** [Not a Message](#memory-vault-is-not-a-message) · [Categories](#categories) · [Fields](#fields) ·
[Endpoints](#endpoints) · [Search, tags and pagination](#search-tags-and-pagination-phase-13a) · [Sharing: create a message](#sharing-create-a-message-from-a-memory-phase-13b) · [Ownership and deletion](#ownership-and-deletion) · [Media](#media) · [Logging](#logging) ·
[Testing](#testing) · [Not in Step 9](#not-in-step-9)

---

A private place for a customer to keep memories: family, travel, childhood, funny stories, life lessons, recipes, love stories.
Each item has a title, a category, optional written text, and any number of photos and audio recordings.

## Memory Vault is not a Message
A `MemoryVaultItem` has **no** status, `contentType`, recipients, schedule, release trigger or death release. Nothing is
ever delivered from it, and no Recipient, Trusted Contact or admin can see it: it is the Customer's own stored content.
Any mix is valid: title only, title + text, title + photos, title + audio, or all of them.
**Sharing** a memory means creating a separate Message from it (Phase 13B, below); the memory itself stays private.

## Categories
`MemoryVaultCategory`: `FAMILY`, `TRAVEL`, `CHILDHOOD`, `FUNNY_STORIES`, `LIFE_LESSONS`, `RECIPES`, `LOVE_STORIES`, `OTHER`.
Fixed list; custom categories are not supported. Anything else is 400.

## Fields
| Field | Rules |
|---|---|
| `title` | Required, trimmed, not blank, max 200 (same rule as Message titles) |
| `category` | Required on create, one of the enum values |
| `textContent` | Optional plain text, max 20,000 (same as Messages). Blank is stored as `null`. PATCH: missing = unchanged, `null` = clear |
| `tags` | Optional array of tag **names** (Phase 13A), max 20, each 1–50 characters after trimming. Create: the memory's tags. PATCH: present = **replaces** the whole set (`[]` removes all), missing = unchanged; `null` is 400 |

Server-controlled, never accepted: `ownerUserId`, `createdAt`, `updatedAt`, `deletedAt`, `mediaAssets`, `storageKey`, `status`,
tag ids. Unknown fields are 400. Responses: `{ id, title, category, textContent, tags: [{ id, name }], createdAt, updatedAt }`
(tags sorted by name).

## Endpoints
All under `/api/v1`, `SessionAuthGuard` + `CustomerGuard` (no session 401; `ADMIN`/`SUPER_ADMIN` 403). Non-UUID ids are 400.

| Method | Path | Result |
|---|---|---|
| `POST` | `/memory-vault` | 201, created item |
| `GET` | `/memory-vault?page&limit&category&search&tag` | 200, one page of own live items, newest first (below) |
| `GET` | `/memory-vault/tags` | 200, own tags `[{ id, name }]`, sorted by name (unused ones included) |
| `GET` | `/memory-vault/:memoryVaultItemId` | 200 |
| `PATCH` | `/memory-vault/:memoryVaultItemId` | 200 (`title`, `category`, `textContent`, `tags`) |
| `DELETE` | `/memory-vault/:memoryVaultItemId` | 204, soft delete |
| `POST` | `/memory-vault/:memoryVaultItemId/messages` | 201, a new DRAFT Message made from this memory (Phase 13B) |
| `POST` | `/memory-vault/:memoryVaultItemId/media/upload-url` | 201, signed ImageKit upload |
| `POST` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId/complete` | 200, verified `READY` |
| `GET` | `/memory-vault/:memoryVaultItemId/media` | 200, live media |
| `GET` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId/access-url` | 200, presigned GET (`READY` only) |
| `DELETE` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId` | 204, soft delete + object delete |

## Search, tags and pagination (Phase 13A)

**List:** `GET /memory-vault?page=1&limit=25&category=TRAVEL&search=italy&tag=family`, every parameter optional and
combinable. Response, the same shape as `GET /recipients` and `GET /messages`:

```json
{ "items": [ { "id": "…", "title": "…", "tags": [{ "id": "…", "name": "Family" }], "…": "…" } ],
  "pagination": { "page": 1, "limit": 25, "total": 26, "pages": 2 } }
```

| Parameter | Rules |
|---|---|
| `page` / `limit` | The shared `PageQueryDto`: page ≥ 1 (default 1), limit 1–100 (default 25); anything else is 400. A page past the end is empty (`total` still correct) |
| `category` | One `MemoryVaultCategory`, as before |
| `search` | Trimmed; blank = no search; max 200. Case-insensitive substring of **`title` or `textContent`** (the only text fields). `%`, `_` and `\` match literally |
| `tag` | One tag **name**, normalized like stored tags (`FAMILY` = `family`); blank = no filter; max 50. Only ever matches the Customer's own tags; an unknown name gives an empty page |

- One `WHERE` in PostgreSQL: owner AND not deleted AND category AND tag AND search; the count uses the same `WHERE`, so
  totals never include other Customers, deleted items or other filters' rows. Ordering `createdAt DESC, id DESC`
  (stable, no overlap between pages). Tags come with the page in the same query (no N+1).
- One tag filter at a time. Filtering by several tags (AND/OR) is a possible later enhancement.
- Plain `ILIKE` substring search; no full-text index (enough for one Customer's vault).

**Tags** (`MemoryVaultTag`, `MemoryVaultItemTag`): each Customer has their own tags; another Customer's tag can never be
read, attached or matched, because tags are given by name and always looked up within the session user's tags.
- Normalization: trimmed, inner whitespace collapsed, compared lower-cased (`normalizedName`, unique per Customer).
  `"Family"`, `" family "` and `"FAMILY"` are one tag; the first spelling is the display `name`. Different words are
  never merged (`family` ≠ `families`). The same name twice in one request counts once.
- Create and PATCH resolve names to tags (creating new ones) in the same transaction as the write; a 404 (missing or
  someone else's memory) rolls back, so no tag is created.
- A tag no memory uses any more is kept, for reuse and suggestions. Deleting a memory keeps its tags.
- Limits (20 tags per memory, 50 characters per tag, 200-character search) are implementation safeguards, not product
  decisions.

## Sharing: create a message from a memory (Phase 13B)

```text
Memory (private, unchanged) ──"Create a message"──► new DRAFT Message (a snapshot of what was picked)
   ──► People I Love (existing assignment) ──► schedule (existing) ──► release (existing BullMQ engine)
   ──► RecipientMessageAccessGrant ──► Recipient Portal shows the Message, never the memory
```

`POST /memory-vault/:memoryVaultItemId/messages`, body:

| Field | Rules |
|---|---|
| `title` | The message title (the UI pre-fills the memory's); Message title rules |
| `contentType` | **Required**, `TEXT`, `PHOTO`, `AUDIO`, `VIDEO` or `MIXED`. Never inferred from the memory |
| `includeText` | Required boolean: copy the memory's text (if it has any) |
| `mediaAssetIds` | Required array (may be empty, max 20): this memory's own live `READY` photos/recordings to copy |
| `recipientIds` | The Message rule: 1–100 of the Customer's live People I Love |

Response: the new Message, as `GET /messages/:id` (no memory id, category or tags). The UI then opens the normal message
page to review, add or remove media, and schedule.

- **Snapshot, not a link.** The message gets its own title and text and its own copies of the chosen files (new
  `MediaAsset` rows and new ImageKit files at `/for-after/users/<userId>/messages/<messageId>/{photo|audio}/<newId>.<ext>`).
  Nothing links back: editing the memory, its tags or category, or deleting the memory or its files never changes the
  message, and deleting the message or its media never changes the memory. One memory can make any number of messages.
- **The memory is only read.** No field, tag, file or ImageKit object of the memory is changed, moved or deleted.
- **Copies are checked like uploads.** ImageKit's copy API keeps the file name and returns no file id, so the server
  re-uploads the bytes (read through a short-lived signed URL) to the new path as a private file, then runs the normal
  verification: file at that path, private, same size and type, magic bytes, ClamAV scan. Only then `READY`.
- **Failure is a safe draft.** The draft, its recipients and one `PENDING_UPLOAD` row per copy are written in one
  transaction before any provider call, so no copy is ever untracked. A copy that fails (provider down, scan, mismatch,
  message deleted meanwhile) becomes `FAILED` and its file is removed through `MediaCleanup` (retried by the reconciler);
  the rest still copy. `FAILED`/`PENDING_UPLOAD` media blocks scheduling, so the Customer removes it (or adds files)
  in the normal message page. A crash mid-copy leaves `PENDING_UPLOAD` rows that the stale-upload reconciler retires.
- **Composition is unchanged.** Drafts may be incomplete or mismatched (e.g. `PHOTO` with copied text); scheduling
  runs the normal `checkComposition` and refuses them (`docs/message-composition.md`).
- **Security.** Owner-scoped like every memory query: another Customer's memory is 404; a file that is not this memory's
  live `READY` file (another memory's, another Customer's, deleted, pending) is 400 `One or more memory files are
  invalid.`; another Customer's recipient is the Message system's own 400. Nothing is created on any of these.
- My Story answers may **link** memories (Phase 14B, `docs/my-story.md`): private context only. A link shares nothing,
  is never copied into a message, and a deleted memory simply stops appearing on the answer.
- Not added: a link from the message to the memory (no provenance column), audit events (none exist for content),
  direct sharing links, Recipient or Trusted Contact access to memories, Memory Vault video, new triggers.

## Ownership and deletion
- Every item query is `{ id, ownerUserId: <session user>, deletedAt: null }`; every media query also requires the route's item id
  and a live parent item (`memoryVaultItem: { ownerUserId, deletedAt: null }`). A missing, deleted or someone else's item or
  media returns the same **404**, which never reveals the owner.
- `DELETE` sets `deletedAt`. Since Phase 12 the same UPDATE soft-deletes all the item's live media, so it is unreachable at
  once (every media route also needs a live parent), and their ImageKit files are deleted afterwards (retried by the
  media cleanup reconciler on failure; `docs/media-storage.md` §2d).

## Media
Same provider, rules and lifecycle as message media (`docs/media-storage.md`), reusing the same code:
- One `MediaStorage` (ImageKit since Phase 12; legacy B2 rows read/delete only), same `MEDIA_*` TTLs and size limits.
- `PHOTO`: `image/jpeg`, `image/png`, `image/webp` (≤ `MEDIA_PHOTO_MAX_BYTES`, 20 MB). `AUDIO`: `audio/mpeg`, `audio/mp4`,
  `audio/webm`, `audio/wav` (≤ `MEDIA_AUDIO_MAX_BYTES`, 25 MB, the ImageKit Free plan limit). `VIDEO` is for messages
  only (not approved for the Memory Vault): 400 here, like SVG, wildcards, cross-kind MIME, size 0 or oversize.
- Direct upload only: the browser POSTs the file straight to ImageKit with the server-signed upload fields. No Multer,
  base64 or proxying through NestJS. No external/Cloudinary URLs.
- Path (server-generated, never returned): `/for-after/users/{ownerUserId}/memory-vault/{memoryVaultItemId}/{photo|audio}/{mediaAssetId}.{ext}`,
  extension from the allowlisted MIME type, never from the filename.
- `complete` (body `{ providerFileId }`) verifies the ImageKit file: not at this path → 409 (stays `PENDING_UPLOAD`);
  size, privacy, type or file signature differs → 400, `FAILED` and the file is deleted; then the file is
  malware-scanned (ClamAV, `docs/media-storage.md` §2e): infected → 400, `FAILED`, deleted; scanner unavailable → 503,
  stays `PENDING_UPLOAD`. Already `READY` → unchanged.
- Signed URLs are short-lived, never stored, never logged. No public files or permanent URLs.
- Media delete: soft delete first, then the file is deleted (best effort, retried); a provider failure still returns 204
  and never restores access.
- Difference from messages: there is no DRAFT lock, because memories have no status. Media can be changed at any time.

Database table `MemoryVaultMediaAsset` reuses the `MediaKind`, `MediaAssetStatus` and `MediaStorageProvider` enums and
keeps its CHECK (`kind IN (PHOTO, AUDIO) AND sizeBytes > 0`).

## Logging
Only ids and outcome categories (e.g. "Memory media {id} failed upload verification"). Never text content, signed URLs,
storage keys, credentials or session cookies.

## Testing
- Unit tests (`src/memory-vault/*.spec.ts`) mock Prisma and storage (incl. query validation, tag normalization, the
  composed `WHERE`, tag replacement, wildcard escaping).
- E2E (`test/memory-vault.e2e-spec.ts`) uses the real app, sessions and PostgreSQL with the fake `MediaStorage`; Phase 13A
  adds two Customers with look-alike titles, text and tag names (isolation, deleted items, every filter combination,
  pagination, tag replacement and rollback).
- Frontend: component tests (`memories.test.tsx`) and Playwright (`e2e/vault.spec.ts`: 26 memories, tags, search,
  category and tag filters, Next, edit tags, delete).
- Tests use the in-memory fake provider; real ImageKit only in the manual local test and Playwright (`docs/media-storage.md`).

## Not built
Direct sharing of a memory (links, Recipient or Trusted Contact access), memory recipients/schedules/release (a message is
made instead), video, thumbnails, waveforms, transcoding, external URL import, multi-tag filters, renaming or deleting
tags, quotas.

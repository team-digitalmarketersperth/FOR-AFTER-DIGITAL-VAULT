# 📸 For After — Memory Vault (Step 9)

> Private memories with text, photos and audio. Not a Message: nothing here is shared, scheduled or released.

| | |
|---|---|
| **Status** | ✅ Built in Step 9 |
| **Who can see it** | Only the Customer who wrote it: no Recipient, Trusted Contact (incl. Step 14) or admin access |
| **Related** | [Media storage](media-storage.md) · [My Story](my-story.md) · [API](api.md) |

**Contents:** [Not a Message](#memory-vault-is-not-a-message) · [Categories](#categories) · [Fields](#fields) ·
[Endpoints](#endpoints) · [Ownership and deletion](#ownership-and-deletion) · [Media](#media) · [Logging](#logging) ·
[Testing](#testing) · [Not in Step 9](#not-in-step-9)

---

A private place for a customer to keep memories: family, travel, childhood, funny stories, life lessons, recipes, love stories.
Each item has a title, a category, optional written text, and any number of photos and audio recordings.

## Memory Vault is not a Message
A `MemoryVaultItem` has **no** status, `contentType`, recipients, schedule, release trigger or death release. It is never
converted into a Message and nothing is ever delivered from it. It is simply the customer's own stored content, visible only to them.
Any mix is valid: title only, title + text, title + photos, title + audio, or all of them.
(Sharing, recipient assignment, scheduling and "create a message from this memory" are possible later features, not built.)

## Categories
`MemoryVaultCategory`: `FAMILY`, `TRAVEL`, `CHILDHOOD`, `FUNNY_STORIES`, `LIFE_LESSONS`, `RECIPES`, `LOVE_STORIES`, `OTHER`.
Fixed list; custom categories are not supported. Anything else is 400.

## Fields
| Field | Rules |
|---|---|
| `title` | Required, trimmed, not blank, max 200 (same rule as Message titles) |
| `category` | Required on create, one of the enum values |
| `textContent` | Optional plain text, max 20,000 (same as Messages). Blank is stored as `null`. PATCH: missing = unchanged, `null` = clear |

Server-controlled, never accepted: `ownerUserId`, `createdAt`, `updatedAt`, `deletedAt`, `mediaAssets`, `storageKey`, `status`.
Unknown fields are 400. Responses: `{ id, title, category, textContent, createdAt, updatedAt }`.

## Endpoints
All under `/api/v1`, `SessionAuthGuard` + `CustomerGuard` (no session 401; `ADMIN`/`SUPER_ADMIN` 403). Non-UUID ids are 400.

| Method | Path | Result |
|---|---|---|
| `POST` | `/memory-vault` | 201, created item |
| `GET` | `/memory-vault[?category=FAMILY]` | 200, own live items, newest first |
| `GET` | `/memory-vault/:memoryVaultItemId` | 200 |
| `PATCH` | `/memory-vault/:memoryVaultItemId` | 200 (`title`, `category`, `textContent`) |
| `DELETE` | `/memory-vault/:memoryVaultItemId` | 204, soft delete |
| `POST` | `/memory-vault/:memoryVaultItemId/media/upload-url` | 201, presigned PUT |
| `POST` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId/complete` | 200, verified `READY` |
| `GET` | `/memory-vault/:memoryVaultItemId/media` | 200, live media |
| `GET` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId/access-url` | 200, presigned GET (`READY` only) |
| `DELETE` | `/memory-vault/:memoryVaultItemId/media/:mediaAssetId` | 204, soft delete + object delete |

No search, tags or pagination yet.

## Ownership and deletion
- Every item query is `{ id, ownerUserId: <session user>, deletedAt: null }`; every media query also requires the route's item id
  and a live parent item (`memoryVaultItem: { ownerUserId, deletedAt: null }`). A missing, deleted or someone else's item or
  media returns the same **404**, which never reveals the owner.
- `DELETE` sets `deletedAt`. Deleting an item makes all its media unreachable immediately (every media route needs a live parent).
  Its media rows and stored objects are left in place for a future reconciliation job; there is no background cleanup yet.

## Media
Same storage, rules and lifecycle as message media (`docs/media-storage.md`), reusing the same code:
- One `MediaStorage` provider (the S3-compatible adapter; Backblaze B2 in development), same `OBJECT_STORAGE_*` credentials,
  same `MEDIA_*` TTLs and size limits. No second client, bucket or credential.
- `PHOTO`: `image/jpeg`, `image/png`, `image/webp` (≤ `MEDIA_PHOTO_MAX_BYTES`, 20 MB). `AUDIO`: `audio/mpeg`, `audio/mp4`,
  `audio/webm`, `audio/wav` (≤ `MEDIA_AUDIO_MAX_BYTES`, 100 MB). `VIDEO`, SVG, wildcards, cross-kind MIME, size 0 or oversize: 400.
- Direct upload only: the client `PUT`s the file straight to the private bucket with the signed URL and the returned
  `Content-Type`. No Multer, multipart, base64 or proxying through NestJS. No external/Cloudinary URLs.
- Storage key (server-generated, never returned): `users/{ownerUserId}/memory-vault/{memoryVaultItemId}/{mediaAssetId}.{ext}`,
  extension from the allowlisted MIME type, never from the filename.
- `complete` HEADs the object: not there → 409 (stays `PENDING_UPLOAD`); size or type differs → 400, `FAILED` and the object
  is removed; already `READY` → returned unchanged.
- Signed URLs are short-lived, never stored, never logged. No public bucket or permanent URLs.
- Media delete: soft delete first, then a best-effort `DeleteObject`; a storage failure still returns 204 and never restores access.
- Difference from messages: there is no DRAFT lock, because memories have no status. Media can be changed at any time.

Database table `MemoryVaultMediaAsset` reuses the `MediaKind` and `MediaAssetStatus` enums and has the same CHECK
(`kind IN (PHOTO, AUDIO) AND sizeBytes > 0`).

## Logging
Only ids and outcome categories (e.g. "Memory media {id} failed upload verification"). Never text content, signed URLs,
storage keys, credentials or session cookies.

## Testing
- Unit tests (`src/memory-vault/*.spec.ts`) mock Prisma and storage.
- E2E (`test/memory-vault.e2e-spec.ts`) uses the real app, sessions and PostgreSQL with a **mocked** `MediaStorage`.
- The real B2 dev bucket is only for manual integration testing (Postman).

## Not in Step 9
Sharing, recipients, scheduling, release, memory-to-message conversion, video, thumbnails, waveforms, transcoding,
malware scanning, external URL import, search, tags, pagination, quotas, orphan cleanup.

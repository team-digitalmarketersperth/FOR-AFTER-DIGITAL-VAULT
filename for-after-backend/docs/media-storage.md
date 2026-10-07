# 🖼️ For After — Media & Storage Architecture

> How photos and audio are uploaded, verified and served privately, and how video and quotas will work later.

| | |
|---|---|
| **Status** | ✅ Photo + audio built (Step 7), reused by Memory Vault (Step 9) and the Recipient Portal (Step 13) · ⬜ video, quotas |
| **Storage** | Private S3-compatible bucket (Backblaze B2 in development), short-lived signed URLs only |
| **Related** | [Message composition](message-composition.md) · [Memory Vault](memory-vault.md) · [Recipient Portal](recipient-portal.md) |

> ℹ️ Trusted Contacts (Step 14) have **no** media access of any kind, and death-report evidence upload is not built.

> ℹ️ **Browser uploads need a bucket CORS rule** (origin `http://localhost:3000`, later `https://app.forafter.com.au`;
> method `PUT`; header `content-type`). The development bucket has it (`backblaze/cors-rules.json`); Playwright uploads
> through it (`e2e/vault.spec.ts`, `e2e/people.spec.ts`). Viewing via `<img>`/`<audio>` needs no CORS.

## 🧭 Contents

1. [Architecture principle](#1-architecture-principle)
2. [Implemented in Step 7](#2-implemented-in-step-7-photos-and-audio-s3-compatible-private) · [2b Video pipeline (planned)](#2b-video-pipeline-planned-not-built-mux--cloudflare-stream)
3. [File storage (planned)](#3-file-storage-planned-scope-beyond-step-7)
4. [MediaFile model (superseded)](#4-mediafile-model-superseded-by-mediaasset-see-docsdatabasemd)
5. [Storage quotas](#5-storage-quotas)
6. [Content types](#6-content-types-product-target-step-7-allows-only-the-list-in-section-2)
7. [Security](#7-security)

---

## 1. Architecture Principle
**No large media files pass through the NestJS application server or database.** All uploads are direct from the client browser to specialized storage providers.

## 2. Implemented in Step 7: photos and audio (S3-compatible, private)

### Providers
- **Development:** a real **private Backblaze B2** bucket, used through its **S3-compatible API** (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`).
  No Backblaze native SDK.
- **Provider-neutral design:** `MediaService` only knows the `MediaStorage` abstraction (`src/media/storage/media-storage.service.ts`).
  `S3MediaStorage` is the only place an `S3Client` is built. Switching to AWS S3, Cloudflare R2 or MinIO is a configuration change.
- **Production** must use a separate bucket and separate credentials.

### Configuration (`.env`, see `.env.example`)
| Variable | Notes |
|---|---|
| `OBJECT_STORAGE_PROVIDER` | Informational (`backblaze-b2`); every current provider uses the S3 adapter |
| `OBJECT_STORAGE_REGION` | Region only, e.g. `us-east-005`. A hostname here is refused at startup |
| `OBJECT_STORAGE_ENDPOINT` | e.g. `https://s3.<region>.backblazeb2.com` |
| `OBJECT_STORAGE_BUCKET` | Private bucket |
| `OBJECT_STORAGE_ACCESS_KEY_ID` / `OBJECT_STORAGE_SECRET_ACCESS_KEY` | A **standard application key restricted to that bucket**. Only in `.env` or a secret manager: never in code, docs, tests or logs |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | `false` for B2 (`true` is typical for MinIO) |
| `MEDIA_UPLOAD_URL_TTL_SECONDS` / `MEDIA_ACCESS_URL_TTL_SECONDS` | 600 / 300 by default |
| `MEDIA_PHOTO_MAX_BYTES` / `MEDIA_AUDIO_MAX_BYTES` | 20 MB / 100 MB by default |
| `RECIPIENT_PHOTO_MAX_BYTES` | 5 MB by default (Phase 09 Recipient photos) |

Missing storage config **stops the app at startup** with the names of the missing variables (never their values). There is no fallback storage.

### Upload lifecycle
```
Client -> POST /messages/:id/media/upload-url   (NestJS: owner + DRAFT + kind/MIME/size checks)
          <- PENDING_UPLOAD row + presigned PUT (Content-Type signed, 10 min)
Client -> PUT file bytes directly to the bucket  (no cookie, no Authorization header)
Client -> POST .../complete                     (NestJS: HeadObject, compare size + type)
          -> READY (uploadedAt set) | FAILED (object removed) | 409 not uploaded yet
Client -> GET .../access-url                    <- presigned GET (5 min), READY only
Client -> DELETE ...                            (soft delete first, then DeleteObject, best-effort)
```
- `PENDING_UPLOAD -> READY` only after `HeadObject` confirms the size (and `Content-Type`, which is part of the upload signature).
  The client's `sizeBytes` is only the expected size.
- Mismatch -> `FAILED` (terminal; request a new upload URL). `complete` on `READY` is idempotent.
- Storage key: `users/{ownerUserId}/messages/{messageId}/{mediaAssetId}.{ext}`, where the extension comes from the allowlisted MIME type,
  never from the filename. It is server-generated and never returned.
- Signed URLs are never stored in PostgreSQL and never logged. Logs contain only IDs and error categories.
- There are no public URLs, no public ACLs and no permanent media links.
- Media on a `SCHEDULED` message can be listed and viewed but not changed. Unschedule first; nothing is unscheduled automatically.
- Step 8: uploads do not depend on the message's `contentType`; which media a message may have is checked when scheduling
  (`docs/message-composition.md`). Upload-url, complete and delete run inside a transaction that first locks the message row
  (conditional UPDATE requiring DRAFT), the same lock scheduling takes, so media cannot change while a schedule is being validated.
  As a side effect, a media change updates `Message.updatedAt`.
- No media URL fields on Message, and no external/Cloudinary URL import: all media goes through this private signed-URL flow.
- Step 9: **Memory Vault media** (`MemoryVaultMediaAsset`, `docs/memory-vault.md`) uses the same `MediaStorage` instance
  (exported by `MediaModule`), credentials, MIME allowlist, size limits, TTLs and verification (shared helpers in
  `media.service.ts`). Key: `users/{ownerUserId}/memory-vault/{memoryVaultItemId}/{mediaAssetId}.{ext}`. Routes live under
  `/memory-vault/:memoryVaultItemId/media`. No DRAFT lock (memories have no status). Soft-deleting a memory hides its media
  at once; the objects wait for the same future reconciliation job.

### What Step 7 does not do
- **MIME type and size are not content validation.** Headers can be spoofed. There is no antivirus or malware scanning, magic-byte or
  file-signature inspection, image re-encoding, audio transcoding or content moderation. Step 7 does not prove an uploaded file is safe.
  Production hardening may add quarantine and scanning before `READY`.
- Until the signed PUT URL expires, the same URL could overwrite the object with a file of the same type (the READY size check has
  already passed). Short TTLs limit this; scanning or copy-on-complete would close it.
- **Pending-upload cleanup** (future): old `PENDING_UPLOAD` rows and their objects are cleaned up by a scheduled reconciliation job.
  There is no `setTimeout`.
- **Orphan-object reconciliation** (future): objects left behind when `DeleteObject` fails after a soft delete (the row keeps its
  `storageKey` and `deletedAt`, so a job can retry; deleting a missing object succeeds), or uploaded through a still-valid signed PUT
  after the soft delete.
- **Soft-deleting a message** (Phase 11) soft-deletes all its live media (any status) in the same UPDATE that deletes the message,
  under the message's DRAFT row lock, so no media can be added afterwards. Their objects are then deleted, best effort and only
  those keys; a failure is logged by media id only, never restores access, and the request still returns `204`. Repeating the
  delete is a plain `404` and touches no storage. Statuses are kept as they were; `deletedAt` hides the rows.
- **Browser uploads** (future frontend): the bucket will need a **restricted CORS policy**: only the approved app origins, `PUT`/`GET`,
  and the `Content-Type` header. Never a wildcard in production. Postman needs no CORS.
- Video (below), thumbnails, waveforms, resizing and quotas are later steps.
- **Recipient access (Step 13):** Recipients get the same short-lived signed GET (`MEDIA_ACCESS_URL_TTL_SECONDS`) through
  `GET /recipient/messages/:messageId/media/:mediaAssetId/access-url`, only for `READY`, non-deleted PHOTO/AUDIO of a `RELEASED`
  Message they hold a `RecipientMessageAccessGrant` for. Memory Vault media is never shared. See `docs/recipient-portal.md`.

### Testing
- Unit and e2e tests **mock `MediaStorage`** and never contact a real bucket or use credentials (e2e uses real PostgreSQL and sessions).
- The real B2 dev bucket is only for manual local integration testing (Postman).

## 2a. Recipient photo (Phase 09)

One optional, private profile photo per Person I Love, managed by the Customer (the Recipient never sees it; it grants
nothing in the Recipient Portal). Own table `RecipientPhoto` (same fields as the media tables, `kind` always `PHOTO`),
same storage, allowlist (JPEG/PNG/WebP, no SVG), HEAD verification and signed URLs as above, under
`/recipients/:id/photo/…` (docs/api.md). Size: `RECIPIENT_PHOTO_MAX_BYTES`, default **5 MB** (an implementation
default: no product document sets one). Content is checked by declared type and stored size only, like other media;
magic-byte checks remain the open Phase 12 item.

- **Key:** `users/<ownerId>/recipients/<recipientId>/photo/<uuid>.<ext>`: ids only, never a name, contact detail or note.
- **One current photo:** a partial unique index (one `READY`, non-deleted row per Recipient) plus a lock on the
  Recipient row during completion, so concurrent uploads end with exactly one photo and a deleted Recipient is never
  given one.
- **Replacement:** the old photo stays until the new one is verified; then, in one transaction, the old one is
  soft-deleted and the new one becomes READY. The old object is deleted after commit, best effort: a storage failure
  never undoes the swap (left for reconciliation, like other media).
- **Lists:** recipients carry `photoId` only; each avatar asks for its own 5-minute URL when shown (no URLs or keys in
  list responses). The frontend keeps them in memory only.
- **Soft-deleting a Recipient** soft-deletes its photos and removes their objects (best effort); every photo route
  already refuses a deleted Recipient (`404`, like a foreign one).

## 2b. Video Pipeline (planned, not built: Mux / Cloudflare Stream)

```mermaid
sequenceDiagram
    participant Client
    participant NestJS
    participant Mux
    
    Client->>NestJS: POST /media/upload-url
    NestJS->>Mux: Create Direct Upload
    Mux-->>NestJS: Upload URL
    NestJS-->>Client: Signed Upload URL
    Client->>Mux: Direct Upload (TUS resumable)
    Mux->>Mux: Transcode to HLS
    Mux->>NestJS: POST /webhooks/mux (Transcode Complete)
    NestJS->>DB: Update MediaFile (Asset ID, Status)
```
- Playback: NestJS generates signed playback tokens with expiration for the client.

## 3. File Storage (planned scope beyond Step 7)
- **Used for**: photos, audio recordings, documents, death certificates, export ZIPs.
- **Buckets**: All buckets are strictly **PRIVATE** (no public access).
- **Upload**: NestJS generates a presigned PUT URL. The client uploads directly to the bucket.
- **Download**: NestJS generates a presigned GET URL with a time expiration. The client downloads the file.
- **Packages**: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

## 4. MediaFile Model (superseded by `MediaAsset`, see docs/database.md)

```prisma
model MediaFile {
  id               String   @id @default(uuid())
  ownerId          String
  messageId        String?
  memoryId         String?
  provider         String   // Mux, S3, R2
  providerAssetId  String?
  objectKey        String?
  mimeType         String
  fileSize         BigInt
  durationSeconds  Int?
  processingStatus String?
  checksum         String?
  status           String
  createdAt        DateTime @default(now())
}
```

## 5. Storage Quotas
- Quotas are enforced based on the user's plan:
  - **Basic**: 5GB
  - **Standard**: 25GB
  - **Legacy**: 100GB
- The `StorageUsage` model tracks `bytesUsed` against `byteLimit` per user.
- System rejects upload requests if the quota is exceeded.

## 6. Content Types (product target; Step 7 allows only the list in section 2)
- **Video**: MP4, WebM, MOV
- **Audio**: MP3, WAV, M4A, OGG
- **Images**: JPEG, PNG, WebP, HEIC
- **Documents**: PDF

## 7. Security
- All URLs are time-limited signed URLs.
- No public bucket policies allowed on any environments.
- Media access and downloads are logged in the `AuditLog`.

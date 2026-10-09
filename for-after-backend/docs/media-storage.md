# 🖼️ For After — Media & Storage Architecture

> How photos, audio and video are uploaded, verified, served privately and cleaned up.

| | |
|---|---|
| **Status** | ✅ ImageKit for PHOTO/AUDIO/VIDEO (Phase 12, 2026-10-07): message media, Memory Vault (PHOTO/AUDIO), Recipient photos, Recipient Portal · ✅ ClamAV malware scanning (Phase 12B) · ✅ storage quota (Phase 12C), 2026-10-08 · ⬜ production keys + B2 retirement |
| **Provider** | **ImageKit** (private files, signed expiring URLs only). Legacy **Backblaze B2** rows stay readable (read/delete only) |
| **Related** | [Message composition](message-composition.md) · [Memory Vault](memory-vault.md) · [Recipient Portal](recipient-portal.md) |

> ℹ️ Trusted Contacts (Step 14) have **no** media access of any kind, and death-report evidence upload is not built.

> ℹ️ **Product decision (2026-10-07):** ImageKit replaced Backblaze B2 for every new upload, and replaced the planned
> Mux / Cloudflare Stream video pipeline. Nothing was deleted from B2.

## 🧭 Contents

1. [Architecture principle](#1-architecture-principle)
2. [ImageKit media (Phase 12)](#2-imagekit-media-phase-12) · [2a Recipient photo](#2a-recipient-photo-phase-09) · [2b Video](#2b-video-phase-12) · [2c Legacy B2](#2c-legacy-backblaze-b2-read-and-delete-only) · [2d Cleanup](#2d-deletion-and-cleanup) · [2e Malware scanning](#2e-malware-scanning-phase-12b)
3. [File storage (planned)](#3-file-storage-planned)
4. [MediaFile model (superseded)](#4-mediafile-model-superseded-by-mediaasset-see-docsdatabasemd)
5. [Storage quotas](#5-storage-quotas)
6. [Content types](#6-content-types)
7. [Security](#7-security)

---

## 1. Architecture Principle
**No media file passes through the NestJS application server or database.** Browsers upload directly to the media
provider with a short-lived, server-signed upload token, and view files through short-lived signed URLs.
The one exception (Phase 12B): on `complete` the backend **streams** each new upload once from the provider to the
malware scanner (§2e). It is never written to disk, stored, or held in memory whole.

## 2. ImageKit media (Phase 12)

### Provider-neutral design
- Services only know the `MediaStorage` abstraction (`src/media/storage/media-storage.service.ts`):
  `createUpload`, `verifyUpload`, `readStart`, `openRead` (whole-file stream for scanning), `createAccessUrl`,
  `deleteObject`, and `copyObject` (Phase 13B: a server-side copy to a new key, private, no overwrite, returning the
  new file id; ImageKit implements it as a re-upload because its copy API keeps the name and returns no id). A copy is
  untrusted until `checkUpload` passes. Malware scanning has its own abstraction, `MalwareScanner` (§2e).
- `ImageKitMediaStorage` (`@imagekit/nodejs`, the official SDK) is the **only** place ImageKit is used. Messages,
  Memory Vault, Recipient photos and the Recipient Portal never call the SDK.
- Every media row records its `storageProvider` (`IMAGEKIT` or `B2`); reads and deletes follow it. New uploads are
  always `IMAGEKIT`. A B2 key is never reinterpreted as an ImageKit path.
- Tests use `test/fake-media-storage.ts` (in memory). No automated test calls ImageKit.

### Configuration (`.env`, see `.env.example`)
| Variable | Notes |
|---|---|
| `IMAGEKIT_PUBLIC_KEY` | JWT `kid` of upload tokens. Not secret, but only the backend uses it |
| `IMAGEKIT_PRIVATE_KEY` | **Backend only.** Signs upload tokens and URLs, calls the API. Never in the frontend, code, docs, tests or logs |
| `IMAGEKIT_URL_ENDPOINT` | e.g. `https://ik.imagekit.io/<your_imagekit_id>` |
| `MEDIA_UPLOAD_URL_TTL_SECONDS` / `MEDIA_ACCESS_URL_TTL_SECONDS` | 600 / 300 by default (upload tokens are capped at ImageKit's 3600) |
| `MEDIA_PHOTO_MAX_BYTES` / `MEDIA_AUDIO_MAX_BYTES` / `MEDIA_VIDEO_MAX_BYTES` | 20 MB / **25 MB** / 100 MB by default (see below) |
| `RECIPIENT_PHOTO_MAX_BYTES` | 5 MB by default (Phase 09 Recipient photos) |
| `MEDIA_CLEANUP_INTERVAL_SECONDS` | 3600 by default; `0` turns the cleanup reconciler off (automated tests) |
| `CLAMAV_HOST` / `CLAMAV_PORT` | clamd TCP address (§2e). `CLAMAV_HOST` is **required**; port 3310 by default |
| `MEDIA_MALWARE_SCAN_TIMEOUT_MS` | 120000 by default: download + scan of one file, 100 MB video included |

Missing ImageKit config or `CLAMAV_HOST` **stops the app at startup** with the names of the missing variables (never
their values). There is no setting that turns malware scanning off.

**Size limits are provider limits, not product decisions.** They follow the ImageKit **Free** plan's upload limits
(checked 2026-10-07, imagekit.io/plans: image 25 MB, audio 25 MB, video 100 MB; image processing 20 MB). Audio was
100 MB on B2 and is now **25 MB**. Raise them only with a plan that allows it.

### Upload lifecycle
```
Client -> POST .../media/upload-url        (NestJS: owner + live parent + DRAFT for messages + kind/MIME/size)
          <- PENDING_UPLOAD row + { mediaAssetId, upload: { url, fields }, expiresAt }
Client -> POST upload.imagekit.io/api/v2/files/upload   (multipart: the signed fields + the file; no cookie)
          <- { fileId, ... }
Client -> POST .../media/:id/complete { providerFileId }
          (NestJS: ImageKit file details + first bytes) -> READY | FAILED (file deleted) | 409 not uploaded
Client -> GET .../media/:id/access-url     <- signed URL of the private original (5 min), READY only
Client -> DELETE ...                       (soft delete first, then the ImageKit file; see 2d)
```
- **Upload token:** ImageKit **Upload API V2**. The backend signs an HS256 JWT (header `kid` = public key, payload
  `iat`/`exp`) whose payload holds **every** upload field; ImageKit refuses an upload whose fields differ. Fields:
  `fileName` `<assetId>.<ext>`, `folder`, `isPrivateFile: "true"`, `useUniqueFileName: "false"`,
  `overwriteFile: "false"`, `checks: "file.size" <= <declared size>`. So the browser cannot choose the path, make the
  file public, replace an existing file or upload more than it declared. Verified against ImageKit: a changed folder,
  an oversize file and a second upload to the same path are all refused (400).
- **Paths (ids only, never names or contact details):**
  `/for-after/users/<userId>/messages/<messageId>/{photo|audio|video}/<assetId>.<ext>`,
  `/for-after/users/<userId>/memory-vault/<itemId>/{photo|audio}/<assetId>.<ext>`,
  `/for-after/users/<userId>/recipients/<recipientId>/photo/<assetId>.<ext>`. Extension from the allowlisted MIME type.
- **Verification on complete (the browser is never trusted):** `providerFileId` is only a lookup hint. ImageKit's file
  details must show the file at **exactly this row's path** (otherwise `409`, and nothing is touched: never someone
  else's file), `isPrivateFile`, the declared size exactly, and a provider MIME that matches (with known aliases:
  ImageKit reports WAV as `audio/vnd.wave` and recorded audio as `video/webm`). Then the first 16 bytes are read
  through a 60 s signed URL and must carry the type's **file signature** (magic bytes: JPEG `FF D8 FF`, PNG, `RIFF…WEBP`,
  `RIFF…WAVE`, `ID3`/MPEG frame sync, `ftyp`, EBML for WebM). Any mismatch → `FAILED` and the file is deleted.
  Only then is the whole file **malware-scanned** (§2e); `READY` needs a `CLEAN` verdict. `complete` on `READY` is
  idempotent.
- **Access:** `buildSrc` with `tr=orig-true` (the original as uploaded: no optimization or video processing) and
  `expiresIn` → `?tr=orig-true&ik-t=<expiry>&ik-s=<signature>`. Private files are refused without a valid signature
  (verified: unsigned `403`). Signed URLs are never stored in PostgreSQL and never logged.
- Storage keys, provider ids and the provider name never leave the API. Logs contain only ids and error classes.
- Media on a `SCHEDULED` message can be listed and viewed but not changed. Unschedule first.
- Uploads do not depend on the message's `contentType`; which media a message may have is checked when scheduling
  (`docs/message-composition.md`). Upload-url, complete and delete lock the message row (conditional UPDATE requiring
  DRAFT), the same lock scheduling takes.
- **My Story** (`MyStoryMediaAsset`, Phase 14B, `docs/my-story.md`): same provider, rules, verification, scan, quota and
  cleanup, PHOTO/AUDIO/VIDEO, under `/for-after/users/<userId>/my-story/<responseId>/…`; owner-only, never Recipients.
  Story → Message copies use `MediaStorage.copyObject` through the shared `MessageSnapshotService` (as Memory → Message).
- **My Wishes** (`MyWishMediaAsset`, Phase 15B, `docs/my-wishes.md`): the same again, PHOTO/AUDIO/VIDEO, under
  `/for-after/users/<userId>/my-wishes/<responseId>/…`; owner-only, never Recipients, Trusted Contacts or admins; counts
  toward the one storage quota; in the `MediaCleanup` table list (deletes, FAILED, stale uploads). Adding a file needs the
  current My Wishes notice acknowledged. Wish → Message copies go through the same `MessageSnapshotService`.
- **Memory Vault** (`MemoryVaultMediaAsset`, `docs/memory-vault.md`): same provider, rules and verification, PHOTO/AUDIO
  only (video was approved for messages only), no DRAFT lock. Deleting a memory soft-deletes its media in the same
  UPDATE and deletes their files.
- **Recipient access (Step 13):** Recipients get the same short-lived signed URL through
  `GET /recipient/messages/:messageId/media/:mediaAssetId/access-url`, only for `READY`, non-deleted PHOTO/AUDIO/VIDEO
  of a `RELEASED` Message they hold a `RecipientMessageAccessGrant` for. Memory Vault media is never shared.

### What Phase 12 does not do
- Magic-byte checks are type validation; malware scanning (§2e) is a separate check. There is no image re-encoding,
  content sanitisation (CDR) or content moderation.
- Thumbnails, waveforms and adaptive streaming (HLS) are later steps. Storage quota: §5 (Phase 12C).

### Testing
- Unit and e2e tests use the fake provider; no ImageKit account, key or network.
- Real ImageKit was checked locally (2026-10-07) with synthetic files only (1×1 PNG, silent WAV, a canvas-recorded WebM
  video and a tone WebM audio): upload token, tamper/oversize/overwrite refusals, verification, magic bytes, signed
  `200` vs unsigned `403`, deletion. Playwright (`e2e/vault.spec.ts`, `e2e/portals.spec.ts`) runs real browser uploads
  against the local stack and the development ImageKit account.

## 2a. Recipient photo (Phase 09)

One optional, private profile photo per Person I Love, managed by the Customer (the Recipient never sees it; it grants
nothing in the Recipient Portal). Own table `RecipientPhoto` (same fields as the media tables, `kind` always `PHOTO`),
same provider, allowlist (JPEG/PNG/WebP, no SVG), verification and signed URLs as above, under
`/recipients/:id/photo/…` (docs/api.md). Size: `RECIPIENT_PHOTO_MAX_BYTES`, default **5 MB** (an implementation
default: no product document sets one).

- **One current photo:** a partial unique index (one `READY`, non-deleted row per Recipient) plus a lock on the
  Recipient row during completion, so concurrent uploads end with exactly one photo and a deleted Recipient is never
  given one.
- **Replacement:** the old photo stays until the new one is verified; then, in one transaction, the old one is
  soft-deleted and the new one becomes READY. The old file is deleted after commit (2d): a provider failure never
  undoes the swap.
- **Lists:** recipients carry `photoId` only; each avatar asks for its own 5-minute URL when shown.
- **Soft-deleting a Recipient** soft-deletes its photos and deletes their files.

## 2b. Video (Phase 12)
- **ImageKit, not Mux or Cloudflare Stream.** VIDEO is a `MediaKind` for **message media only**: `video/mp4`,
  `video/webm` (what browsers record), up to 100 MB.
- Same direct upload, verification and private signed URLs as photos and audio. The **original** file is served
  (`orig-true`): no transcoding, so no asynchronous processing step, no `PROCESSING` state and no webhook. A video is
  `READY` as soon as complete verifies it. ImageKit's video webhooks only report transformations, which are not used.
- Playback is a plain `<video>` with the signed URL, requested only when the person presses Watch.
- Not built: adaptive streaming (HLS/ABR), thumbnails, transcoding of formats a browser cannot play (e.g. MOV).
- Browser recording (Phase 12A, `components/media/recorder.tsx`) makes an ordinary VIDEO file and uses this same
  upload: WebM where the browser records WebM, MP4 only where it records MP4 (never relabelled).

## 2c. Legacy Backblaze B2 (read and delete only)
- Rows uploaded before Phase 12 have `storageProvider = B2` (set by migration `imagekit_media_provider`, which filled
  existing rows with `B2` before switching the default to `IMAGEKIT`). At migration time the local database held a few
  such rows (READY: 1 message audio, 2 Recipient photos).
- `LegacyB2MediaStorage` (`@aws-sdk/client-s3`, presigner) serves them with short-lived presigned GETs and deletes their
  object **only when the owner deletes the media**. It has no upload method. It is optional: without the
  `OBJECT_STORAGE_*` variables, B2 rows answer `503` while ImageKit works normally.
- **Migration:** `npm run migrate:b2-to-imagekit` (after `npm run build`; dry run) and `-- --apply`
  (`src/media/migrate-b2-to-imagekit.ts`). Explicit and idempotent: live `READY` B2 rows in all three tables are
  downloaded through a presigned GET, uploaded to their new ImageKit path, verified like any upload (path, private, size,
  type, magic bytes), and only then switched to `IMAGEKIT` (conditional on still being B2). A failure leaves the row on
  B2 and is reported; rerunning retries. **The B2 object is never deleted.**
- **Local run (2026-10-07):** 3 candidates (1 message audio, 2 Recipient photos), 3 migrated, 0 failed, each verified
  (signed GET `200`, same size); a rerun finds 0. No live `READY` B2 row remains locally. Remaining B2 rows are
  deleted, abandoned (`PENDING_UPLOAD`) or `FAILED` ones; the bucket itself is untouched. Re-checked later that day:
  all 3 private on ImageKit, size matches, signed `206` / unsigned `403`, each B2 original still present. The adapter
  stays while 4 live `PENDING_UPLOAD` B2 rows exist (their owner's delete still goes to B2); the reconciler retires
  them after 24 h.
- **Local re-audit (2026-10-08): 0 live B2 rows.** The 4 `PENDING_UPLOAD` rows were retired (soft-deleted) by the
  stale-upload reconciler as designed; the other B2 rows are soft-deleted Recipient photos. All remaining B2 rows are
  deleted, so nothing in the local app reads B2 any more. No new upload path writes to B2 (`MediaStorage.createUpload`
  is ImageKit only; the legacy adapter has no upload method).
- **Deployed environment (Railway client demo):** it was deployed on 2026-10-06 from `staging`, before this Phase 12
  work, so it still runs the B2 version and may hold B2 rows from the demo. It needs: this code committed and
  deployed, the `IMAGEKIT_*` and `CLAMAV_HOST` configuration and a clamd service, `prisma migrate deploy`, then
  `npm run migrate:b2-to-imagekit` (dry run, then `-- --apply`) and a row audit. Not done: it needs a commit/push and
  approval to change Railway.
- Retiring B2: once every environment shows 0 live B2 rows, the adapter, the AWS SDK packages and the
  `OBJECT_STORAGE_*` variables can be removed (B2 rows then answer `503`, which only matters for deleted rows). The
  adapter is the **only** user of `@aws-sdk/*`. The bucket is kept as a legacy backup until its deletion is approved.

## 2d. Deletion and cleanup
- **PostgreSQL is authoritative:** a row is soft-deleted (or marked `FAILED`) first, so it is inaccessible at once;
  `MediaCleanup.purge` then deletes the provider file, best effort, and records `storageDeletedAt`. A provider failure
  never restores access, is logged by media id only, and the request still succeeds.
- **Retry (reconciler):** `MediaCleanup.reconcile` runs at startup and every `MEDIA_CLEANUP_INTERVAL_SECONDS`
  (in-process timer re-scanning PostgreSQL, like the release reconciler; idempotent; safe on several instances).
  It retries **ImageKit** rows that are deleted or `FAILED` but not storage-deleted, at most 100 per table per run.
  Deleting a file that is already gone succeeds.
- **Stale uploads:** `PENDING_UPLOAD` rows older than 24 h are soft-deleted by the reconciler, and whatever was
  uploaded for them is removed. A row without a provider file id is looked up at its own path only after its upload
  token has expired (ImageKit's listing lags new uploads by a few seconds, and the token could still be used).
- **Never automatic on B2:** the reconciler skips B2 rows.
- Deleting a **message** or a **memory** soft-deletes all its live media (any status) in the same UPDATE, then purges.

## 2e. Malware scanning (Phase 12B)

```text
browser ──upload──► ImageKit ──► POST …/complete (server)
  1. provider check   file at this row's path, private, declared size, matching provider MIME   (400 FAILED)
  2. magic bytes      first 16 bytes match the allowlisted type                                  (400 FAILED)
  3. malware scan     whole file streamed ImageKit → clamd INSTREAM, size- and time-bounded      (see below)
  4. READY            only on a CLEAN verdict, conditional on still PENDING_UPLOAD
```

- **Where:** inside the shared `checkUpload` (`src/media/media.service.ts`), so every upload path gets it: message
  media (PHOTO/AUDIO/VIDEO), Memory Vault (PHOTO/AUDIO), Recipient photos, and copies made by
  `migrate:b2-to-imagekit`. The browser never reports a scan result or a status.
- **Scanner:** `MalwareScanner` (`src/media/scanner/`), bound to `ClamAvMalwareScanner`: ClamAV's `clamd` over TCP,
  `zINSTREAM` with 4-byte big-endian length-prefixed chunks; replies `stream: OK` → CLEAN, `stream: <name> FOUND` →
  INFECTED, anything else throws. Tests bind `test/fake-malware-scanner.ts` (flags a harmless marker string).
- **Bounded:** the file is fetched through a 60 s signed URL (never stored or logged) and piped chunk by chunk with
  backpressure: no temp file, no whole-file buffer. The stream is cut off past the verified size, and one
  `MEDIA_MALWARE_SCAN_TIMEOUT_MS` signal aborts both the download and the clamd connection. Concurrency is bounded
  by clamd itself (`MaxThreads`, `MaxQueue`; a refused connection fails closed).
- **Infected:** row → `FAILED` (terminal: retrying `complete` is `409`), provider file deleted through `MediaCleanup`
  (retried by the reconciler if ImageKit is down). The client gets `400 This file could not be accepted. Please
  choose a different file.` The log line carries the media id only (no signature name, path or URL).
- **Scanner error (fail closed):** unreachable, timeout, size overrun, malformed reply or download failure → `503
  We couldn't finish checking this file. Please try again.` The row **stays `PENDING_UPLOAD`** (never READY), the
  file stays, and `complete` can be retried. If never retried, the stale-upload reconciler retires it after 24 h
  (§2d). No `SCANNING` state is needed: the scan runs inside the request, so a crash leaves a plain
  `PENDING_UPLOAD` row.
- **Nothing new to deny:** an infected or unscanned file is `FAILED` or `PENDING_UPLOAD`, which already gets no
  Customer or Recipient signed URL, never satisfies scheduling composition, and never reaches a Recipient. No new
  status or migration; no scan metadata is stored. Infected samples are not kept, and there is no quarantine bucket.
- **clamd requirements:** `StreamMaxLength` ≥ the largest limit (100 MB video; clamd's default is 25 MB and would
  fail every larger video closed). Signatures kept current by `freshclam`.
- **EICAR note (checked 2026-10-08):** ClamAV's EICAR signature matches only at file offset 0. A bare EICAR file is
  detected by clamd but never reaches it here (the magic-byte check refuses it first), and EICAR appended to a valid
  image/audio/video is not an EICAR match. The full infected path was verified with real clamd and a local test
  signature.

### Local setup (development only)
```bash
docker run -d --name for-after-clamav -p 127.0.0.1:3310:3310   -e CLAMD_CONF_StreamMaxLength=110M clamav/clamav:stable
# first start downloads signatures (a few minutes); ready when this prints PONG:
docker exec for-after-clamav sh -c 'echo PING | nc -w 3 127.0.0.1 3310'
```
Then `CLAMAV_HOST=127.0.0.1` in `.env`. `CLAMD_CONF_<Directive>` is the official image's way to set `clamd.conf`.

### Testing (malware scanning)
- Unit: `media.service.spec.ts` (clean PHOTO/AUDIO/VIDEO → READY; infected → FAILED; outage, timeout, malformed
  verdict, oversize stream → 503 and still pending; magic-byte and size failures never scanned), Memory Vault and
  Recipient photo specs, `clamav-malware-scanner.service.spec.ts` (protocol against a local fake clamd socket).
- E2E (fake provider + fake scanner, real PostgreSQL/Redis): infected PHOTO/AUDIO/VIDEO and Memory Vault media →
  FAILED, no access, no retry; outage → 503 then retry → READY; infected/unscanned media blocks PHOTO/AUDIO/VIDEO/
  MIXED scheduling.
- Real local check (2026-10-08, clamd 1.5.4 in Docker, built `MediaService`, local PostgreSQL, in-memory provider):
  clean PNG, WAV, 1 MB and 100 MB MP4 → READY (100 MB in ~17 s); bare EICAR → clamd INFECTED; files carrying a local
  test signature → FAILED, file deleted, access 409, not schedulable; clamd unreachable → 503, stays PENDING_UPLOAD.

## 3. File Storage (planned)
- **Planned uses**: documents, death certificates, export ZIPs. Same principle: private files, direct upload with
  server-signed tokens, short-lived signed downloads.

## 4. MediaFile Model (superseded by `MediaAsset`, see docs/database.md)
The original plan's `MediaFile` model (provider, providerAssetId, objectKey, …) was replaced by `MediaAsset`,
`MemoryVaultMediaAsset` and `RecipientPhoto`, which carry `storageProvider`, `providerFileId` and `storageDeletedAt`.

## 5. Storage Quotas (Phase 12C)

**Approved policy (2026-10-08):** one limit per Customer, `STORAGE_LIMIT_BYTES`, default **5 GiB** (5,368,709,120
bytes), until per-plan limits arrive with billing (Phase 21; the Basic/Standard/Legacy sizes are still placeholders).

- **What counts:** Message media (incl. copies made from memories and stories), Memory Vault media, Recipient photos and
  My Story media (Phase 14B), from
  PostgreSQL only (never the provider): rows that are not deleted and `READY` (**used**) or `PENDING_UPLOAD`
  (**reserved**: an upload in progress holds its declared size). `FAILED` and deleted rows never count; a deleted file
  stops counting at once, whether or not its provider delete has finished. A stale `PENDING_UPLOAD` stops counting when
  `MediaCleanup` retires it (24 h). Copies have their own rows, so nothing is counted twice.
- **Enforced before any upload is signed**, inside the transaction that inserts the new `PENDING_UPLOAD` row
  (`StorageQuota.reserve`): message media, Memory Vault media, Recipient photos and the copies of a memory→message.
  It locks the Customer's `User` row (`SELECT … FOR UPDATE`), sums, and refuses with **409**:
  - `Your storage is full. Delete files you no longer need to add new ones.` when already at or over the limit;
  - `This file is larger than your remaining storage.` when this file would cross it (even below 80 %).
  The lock serializes one Customer's reservations, so parallel uploads can never share the same remaining space
  (checked against PostgreSQL with five parallel requests on three upload kinds).
- **Levels** (integer byte math, counted = used + reserved): `NORMAL` < 80 %, `WARNING` ≥ 80 %, `HIGH` ≥ 90 %, `FULL`
  ≥ 100 %. At `FULL` existing files stay fully available (lists, previews, release); only new storage is refused.
- **API:** `GET /users/me/storage` (Customer session) → `{ usedBytes, reservedBytes, limitBytes, remainingBytes,
  percentage, level }`, the caller's own data only.
- **UI:** Account settings → Storage: "x of y used", a progress bar and calm notices at 80/90/100 % (no upgrade offer:
  plans are not built). Upload forms show the server's 409 message; the server stays authoritative.
- Tests: unit (levels and edges, policy SQL, reserve order), e2e on PostgreSQL with a 10,000-byte limit (all paths,
  thresholds, FULL, deletes/FAILED/retired, owner isolation, the concurrency race, memory copies), component tests and
  Playwright (API started with a small `STORAGE_LIMIT_BYTES`).

## 6. Content Types
- **Accepted now:** photos JPEG, PNG, WebP; audio MP3, M4A, WebM, WAV; video MP4, WebM (messages only). No SVG.
- **Product target, not built:** MOV, OGG, HEIC, PDF.

## 7. Security
- Every file is private; all access is through time-limited signed URLs; nothing is public.
- `IMAGEKIT_PRIVATE_KEY` is backend-only (never `NEXT_PUBLIC_*`); upload tokens fix every upload parameter.
- Provider errors are sanitized (`503 Media storage is temporarily unavailable.`); logs carry only ids and error classes.
- Every upload is malware-scanned server-side before `READY`, failing closed (§2e).
- Media access by Recipients is logged by id (`recipient_media_access_granted`).

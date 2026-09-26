# For After — Message Composition (Step 8)

A message's `contentType` is the customer's **explicit** intent. The server never infers it from attached media, never changes it,
and never deletes media when it changes. Media is only ever a `MediaAsset` (private bucket, signed URLs; see `docs/media-storage.md`);
there are no media URL fields on `Message` and no external/Cloudinary URL import.

## Supported content types
| contentType | API |
|---|---|
| `TEXT`, `PHOTO`, `AUDIO`, `MIXED` | Supported (create and PATCH) |
| `VIDEO` | Reserved in the enum; create/PATCH return **400** until a streaming pipeline exists |

## Drafts may be incomplete
While a message is `DRAFT` anything goes: a `PHOTO` draft with no photo yet, `TEXT` with no text, `MIXED` with one modality,
a `TEXT` draft that already has a photo uploaded (the customer may be about to switch to `MIXED`). Media upload does not depend on `contentType`.

`textContent` in `PATCH`: a missing field leaves it unchanged, `null` clears it, and blank text is stored as `null`.

## Strict check before scheduling (`DRAFT -> SCHEDULED`)
Implemented in `checkComposition` (`src/messages/message-composition.ts`) and run by `POST /messages/:id/schedule`,
server-side, inside the scheduling transaction. Every failure is **409 Conflict** with a specific, safe message; the message stays `DRAFT`.

Definitions: **active** media = `deletedAt IS NULL` (soft-deleted media is ignored). **Ready** = active and `status = READY`.
**Text** = `textContent` with at least one non-whitespace character.

1. Any active media that is `PENDING_UPLOAD` or `FAILED` blocks scheduling (complete it, or delete and re-upload). This applies to every type.
2. Then, by `contentType`:

| contentType | Required | Not allowed |
|---|---|---|
| `TEXT` | text | any photo or audio |
| `PHOTO` | at least one ready photo | audio; text (use `MIXED`) |
| `AUDIO` | at least one ready audio file | photos; text (use `MIXED`) |
| `MIXED` | at least **two** of: text, a ready photo, a ready audio file | (a single modality should use its own type) |

## After scheduling
- A `SCHEDULED` message is immutable: message PATCH/DELETE, media upload/complete/delete all return 409.
- To change it: `DELETE /messages/:id/schedule` (back to `DRAFT`), edit, then schedule again; the check runs again.
- Schedule `PATCH` changes only the trigger and does not re-check composition, because the content cannot have changed.

## Concurrency
Scheduling locks the message row (conditional `UPDATE ... status DRAFT -> SCHEDULED`) and then reads the composition in the same
transaction. Message edits and media upload/complete/delete require `DRAFT` through a conditional UPDATE on the same row,
so they either finish before the schedule reads the composition or fail with 409 afterwards. The storage `HEAD` in `complete` runs
before its locked write, so a message scheduled in between makes that `complete` fail (409) rather than change a scheduled message.

## Not in Step 8
Video, thumbnails, waveforms, transcoding, malware scanning, external URL import, release/delivery.

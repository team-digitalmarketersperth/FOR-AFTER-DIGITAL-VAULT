# 🧩 For After — Message Composition (Step 8)

> Which content types a message can have, and the strict check that runs before a draft can be scheduled.

| | |
|---|---|
| **Status** | ✅ Built in Step 8; `VIDEO` added in Phase 12 (ImageKit, 2026-10-07) |
| **Content types** | `TEXT` · `PHOTO` · `AUDIO` · `VIDEO` · `MIXED` |
| **Related** | [Media storage](media-storage.md) · [Scheduling](scheduling.md) · [API](api.md) |

**Contents:** [Supported content types](#supported-content-types) · [Drafts may be incomplete](#drafts-may-be-incomplete) ·
[Strict check before scheduling](#strict-check-before-scheduling-draft---scheduled) · [After scheduling](#after-scheduling) ·
[Concurrency](#concurrency) · [Not in Step 8](#not-in-step-8)

---

A message's `contentType` is the customer's **explicit** intent. The server never infers it from attached media, never changes it,
and never deletes media when it changes. Media is only ever a `MediaAsset` (private ImageKit files, signed URLs; see `docs/media-storage.md`);
there are no media URL fields on `Message` and no external/Cloudinary URL import.

## Supported content types
| contentType | API |
|---|---|
| `TEXT`, `PHOTO`, `AUDIO`, `VIDEO`, `MIXED` | Supported (create and PATCH); anything else is **400** |

**Video (Phase 12, product decision 2026-10-07): a video is either a `VIDEO` message on its own or one part of a
`MIXED` message.** `VIDEO` = one or more videos and nothing else; `MIXED` = any two or more of text, photo, audio and
video. `TEXT`, `PHOTO` and `AUDIO` never hold video.

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
| `VIDEO` | at least one ready video | photos, audio, text (use `MIXED`) |
| `MIXED` | at least **two** of: text, a ready photo, a ready audio file, a ready video | (a single modality should use its own type) |

`TEXT`, `PHOTO` and `AUDIO` with any video → `409 <TYPE> messages cannot contain video. Use VIDEO or MIXED.`
A `VIDEO` draft may be incomplete; scheduling needs a `READY` video. Uploading (`PENDING_UPLOAD`), failed (`FAILED`) and
deleted videos do not count (rule 1 blocks the first two). There is no `PROCESSING` state: the original file is served,
so a video is `READY` once the upload is verified (`docs/media-storage.md` §2b).

## After scheduling
- A `SCHEDULED` message is immutable: message PATCH/DELETE, media upload/complete/delete all return 409.
- To change it: `DELETE /messages/:id/schedule` (back to `DRAFT`), edit, then schedule again; the check runs again.
- Schedule `PATCH` changes only the trigger and does not re-check composition, because the content cannot have changed.

## Concurrency
Scheduling locks the message row (conditional `UPDATE ... status DRAFT -> SCHEDULED`) and then reads the composition in the same
transaction. Message edits and media upload/complete/delete require `DRAFT` through a conditional UPDATE on the same row,
so they either finish before the schedule reads the composition or fail with 409 afterwards. The provider verification in `complete`
runs before its locked write, so a message scheduled in between makes that `complete` fail (409) rather than change a scheduled message.

## Not built
Thumbnails, waveforms, transcoding, adaptive streaming, external URL import. A message made from a memory (Phase 13B,
`docs/memory-vault.md`) is an ordinary draft: its explicit `contentType` and copied text/media go through the same check
at scheduling. (Malware scanning is done at upload
completion, Phase 12B: infected or unscanned media is never `READY`, so it never satisfies a content type.)

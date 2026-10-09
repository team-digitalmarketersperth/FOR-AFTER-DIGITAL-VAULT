# 🕊️ For After — My Wishes (Step 11)

| | |
|---|---|
| **Status** | ✅ Built in Step 11 (text answers) · notice served by the API + versioned acknowledgement (Phase 15A, 2026-10-08) · photos/recordings/videos + sharing as a separate Message after a verified death (Phase 15B, 2026-10-09) · AI help **deferred post-MVP** |
| **Who can see it** | Only the Customer: no Recipient, Trusted Contact (incl. Step 14) or admin access. People the Customer picks receive only a separate Message copy, released by the normal Message rules |
| **Related** | [My Story](my-story.md) · [Death verification](death-verification.md) · [API](api.md) |

**Contents:** [Not a legal document](#not-a-legal-document) · [Private content](#private-customer-content) ·
[Prompt catalogue](#prompt-catalogue) · [Answers](#answers) · [Endpoints](#endpoints) ·
[PUT, delete and re-answer](#put-delete-and-re-answer) · [Ownership](#ownership) · [Logging](#logging-and-privacy) ·
[Rich wishes](#rich-wishes-phase-15b) · [Sharing after death](#sharing-after-death-phase-15b) ·
[AI help](#ai-help-deferred-post-mvp) · [Implementation notes](#implementation-notes) · [Not built](#not-built)

---

> **My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive,
> financial instruction or substitute for professional advice.**

A private place for a customer to write down how they would like their farewell, memorial or celebration of life to feel,
and what they would like the people who may one day organise it to know: ceremony and setting, atmosphere, music and
readings, people and traditions, other preferences and a personal message. Step 11 was text only; Phase 15B adds photos,
recordings and videos, and a way to share a copy with chosen people after a verified death.

## Not a legal document
My Wishes is informational and personal. It is **not** a will, testamentary document, advance health directive, medical
directive, power of attorney, financial instruction, binding funeral contract, estate-planning advice or legal advice, and
the API, data model and docs never describe it as legally binding. Field and API names use neutral words only (wish,
preference, guidance, response); prompts ask about preferences, never about instructions, executors or directives.

**Notice (disclaimer), Phase 15A.** Decisions approved by the **product owner** on 2026-10-08; a formal **legal review
of the wording has not been done** and stays an open item (`task.md` Phase 01).

| | |
|---|---|
| Wording, version **1** | "My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive, financial instruction or substitute for professional advice." (exactly the Step 18 text) |
| Source | The backend only (`MyWishesDisclaimer` in `src/my-wishes/my-wishes-disclaimer.service.ts`, code-defined, not in the database or env). The frontend renders what `GET /my-wishes/disclaimer` returns and keeps no copy; if it cannot load, the UI shows an error with retry and offers no writing |
| Acknowledgement | **Required once per version, before creating or editing a wish.** An unticked checkbox ("I have read this notice.") and Continue on the My Wishes pages. It records that this version was shown and confirmed: it is not consent, a waiver, legal advice or a signature, and must never be described as one |
| Enforcement | Server-side: `PUT …/response` answers **409** `Please acknowledge the current My Wishes notice before saving.` without an acknowledgement of the current version. Reading (`GET`) and deleting (`DELETE`) never need one, so a Customer can always read or remove their wishes |
| New version | Changing a word of the notice means a new version: bump `version` with the new text. Earlier acknowledgements do not count for it (writes wait for a new one); existing wishes are never changed, hidden or deleted |
| Record | `MyWishesDisclaimerAcknowledgement` (`userId`, `disclaimerVersion`, `acknowledgedAt`; unique per user and version; migration `my_wishes_disclaimer_acknowledgements`, additive). Kept as history, never edited. Idempotent (repeated or concurrent submits keep one row). Only the current version can be acknowledged (409 `The My Wishes notice has changed. Please read the current version.`). The body is `{ version }` only; user, time and text never come from the client |
| Existing users | **Not backfilled**: no one is recorded as having acknowledged anything they were not shown |
| Audit | `MY_WISHES_DISCLAIMER_ACKNOWLEDGED` once per user and version: actor id and `{ disclaimerVersion }` only; no IP, device, notice text or wish content |

The notice is still not stored per answer, and `acceptedLegalDisclaimer` or similar on a wish is rejected (400) like any
unknown field.

## Private customer content
A `MyWishResponse` is its own domain: not a Message, Memory Vault item, My Story answer, Recipient or Trusted Contact. It has
no recipients, status, schedule or release trigger, and the wish itself is never delivered, shared or released. Saving a
wish never creates a Message, schedule, memory or story answer. The only way anything of it reaches another person is the
Customer's explicit "Create message for loved ones" (Phase 15B), which makes a separate Message. Only the customer who
wrote it can see it:

- no Recipient access (no `recipientIds`, `sharedWith` or `releaseTo`);
- no Trusted Contact access: since Step 14 they can sign in and report a death, which grants no access to private
  content (they see only a true/false "preserved content exists", which counts wishes among other content);
- no admin access (`ADMIN`/`SUPER_ADMIN` get 403) and no public endpoint;
- no release of the wish itself (`NOW`, `FIXED_DATE`, `ON_DEATH`, `AFTER_DEATH` belong to Messages). After-death sharing
  is decided (Phase 15B): a Message snapshot, see [Sharing after death](#sharing-after-death-phase-15b).

## Prompt catalogue
Prompts are application content in `src/my-wishes/my-wishes.prompts.ts`, not database rows; customers cannot change them.
Each has a permanent `key` (never renamed or reused; not an array index or the wording), a `category`, a `version`
(starts at 1; bump it when the wording changes) and the `prompt` text. Keys use the My Story format (lowercase words with
hyphens, dot-separated sections): malformed (uppercase, slashes, `..`, URLs) is 400, unknown is 404.

**Status of the copy.** The product docs list only "possible fields" (`PROJECT_OVERVIEW.md` §18: burial/cremation,
locations, music, readings, flowers, clothing, speakers, photos, people to contact, messages to play, charity,
religious/cultural preferences, personal notes). There is no approved question set, so this is the V1 development
catalogue from the Step 11 brief; replace it when product approves one.

| Category | Key | Prompt |
|---|---|---|
| `CEREMONY` | `ceremony.style` | How would you like your farewell or celebration of life to feel? |
| `CEREMONY` | `ceremony.setting` | Is there a place or type of setting that would feel meaningful to you? |
| `ATMOSPHERE` | `atmosphere.feeling` | What kind of atmosphere would you like people to experience? |
| `MUSIC_AND_READINGS` | `music-and-readings.music` | Are there any songs or pieces of music that are meaningful to you? |
| `MUSIC_AND_READINGS` | `music-and-readings.readings` | Are there any readings, poems, passages or words you would like included? |
| `PEOPLE_AND_TRADITIONS` | `people-and-traditions.involvement` | Are there particular people you would like involved in your farewell? |
| `PEOPLE_AND_TRADITIONS` | `people-and-traditions.traditions` | Are there any traditions or personal touches you would like remembered? |
| `PERSONAL_PREFERENCES` | `personal-preferences.details` | Are there any other personal preferences you would like your loved ones to know? |
| `PERSONAL_MESSAGE` | `personal-message.remember` | Is there anything you would like your loved ones to remember when the time comes? |
| `OTHER` | `other.additional-wishes` | Is there anything else you would like to share about your wishes? |

Every prompt is optional. Categories are a TypeScript list for grouping, not a database enum.

## Answers
Table `MyWishResponse` (same shape as `MyStoryResponse`, separate table): `id`, `ownerUserId`, `promptKey`,
`promptTextSnapshot`, `promptVersion`, `textContent`, timestamps, `deletedAt`, with `UNIQUE (ownerUserId, promptKey)`:
**one answer per customer and prompt**.

- **Snapshot and version:** copied from the catalogue on every save (the wording the current text answers). Never accepted
  from the client, never returned.
- **Text:** optional since Phase 15B (`textContent` nullable; omitted = unchanged, `null` = cleared). When sent: max 20,000
  characters (the existing `TEXT_CONTENT_MAX`, shared with Messages, Memory Vault and My Story; longer text is rejected
  with 400, never truncated), must contain something other than whitespace. Stored exactly as written: not trimmed,
  corrected, summarised, translated or turned into legal wording. Plain text, never HTML; clients escape it when rendering.
- **Content rule (Phase 15B):** a wish counts (`answered`, listed, returned) once it has text or a `READY` file. `PUT`
  refuses to leave a wish with neither (400 `Add some words, a photo or a recording before saving.`; nothing changes).
- **Never accepted:** `ownerUserId`, `promptKey` (from the URL), `promptTextSnapshot`, `promptVersion`, timestamps,
  `deletedAt`; unknown fields are 400.

## Endpoints
All under `/api/v1`, `SessionAuthGuard` + `CustomerGuard` (no session 401; `ADMIN`/`SUPER_ADMIN` 403).

| Method | Path | Result |
|---|---|---|
| `GET` | `/my-wishes/prompts[?category=CEREMONY]` | 200, catalogue order, each with `answered` and `response` |
| `GET` | `/my-wishes/prompts/:promptKey` | 200, one prompt with `answered` and `response` |
| `GET` | `/my-wishes/prompts/:promptKey/response` | 200, or 404 if not answered (or deleted) |
| `PUT` | `/my-wishes/prompts/:promptKey/response` | 200, created / updated / restored answer |
| `DELETE` | `/my-wishes/prompts/:promptKey/response` | 204 soft delete with its files; 404 if there is no live answer. Messages made from it stay |
| `POST` | `/my-wishes/prompts/:promptKey/response/messages` | 201, a new independent DRAFT Message from chosen parts (Phase 15B) |
| `POST` | `/my-wishes/prompts/:promptKey/response/media/upload-url` | 201, signed ImageKit upload (PHOTO/AUDIO/VIDEO); needs the notice acknowledged |
| `POST` | `/my-wishes/prompts/:promptKey/response/media/:mediaAssetId/complete` | 200, verified and scanned → `READY` |
| `GET` | `/my-wishes/prompts/:promptKey/response/media` | 200, the wish's live files (`[]` if none) |
| `GET` | `/my-wishes/prompts/:promptKey/response/media/:mediaAssetId/access-url` | 200, short-lived signed URL (`READY` only) |
| `DELETE` | `/my-wishes/prompts/:promptKey/response/media/:mediaAssetId` | 204, soft delete, then the file is removed |
| `GET` | `/my-wishes/disclaimer` | 200 `{ version, text, requiresAcknowledgement, acknowledged, acknowledgedAt }` (own state only) |
| `POST` | `/my-wishes/disclaimer/acknowledgement` | 200, same shape; body `{ version }` (current version only, idempotent) |

`PUT …/response` and `…/media/upload-url` (adding a file is writing a wish) are 409 until the current notice version is
acknowledged (Phase 15A); reading, completing an upload already authorised, deleting and creating a message never are.

Prompt: `{ key, category, version, prompt, answered, response }`; `response` is null or
`{ id, promptKey, textContent, mediaCount, createdAt, updatedAt }` (`textContent` may be null, `mediaCount` = `READY`
files). No `GET /my-wishes/responses`: My Story has no such list either, and
the prompt list already carries every answer.

## PUT, delete and re-answer
`PUT` is one atomic Prisma `upsert` on `(ownerUserId, promptKey)`: no row → create; live row → update; soft-deleted row →
update and `deletedAt = null` (restored, same `id`). Always 200, never a second row (Phase 15B: inside a transaction that
rolls back an empty wish). `DELETE` sets `deletedAt` on the wish and, in the same UPDATE, on its live files, then
`MediaCleanup` removes the files (retried if the provider is down); the answer then shows as unanswered,
`GET .../response` is 404, and the prompt can be answered again (empty, with the current wording).

## Ownership
Every query is `{ ownerUserId: <session user>, promptKey, deletedAt: null }` (the upsert uses the unique key). Two customers
answering the same prompt get separate rows; another customer's answer always looks unanswered (404). Deleting a user
cascades to their wishes.

## Logging and privacy
The module does not log. Wish text, funeral preferences, personal messages, session cookies and passwords must never be
logged or sent to analytics; at most ids, the prompt key and an outcome category.

## Rich wishes (Phase 15B)

Approved by the product owner 2026-10-09 (the Phase 14B My Story rules applied to My Wishes): a wish may hold any mix of
text, photos, audio and video; text is optional; no limit on the number of files (only the per-file size limits and the
storage quota).

- **Files** (`MyWishMediaAsset`, migration `my_wishes_media`, additive; `MyWishResponse.textContent` made nullable, no
  existing row changed): PHOTO (JPEG/PNG/WebP), AUDIO (MP3/M4A/WebM/WAV) and VIDEO (MP4/WebM) with the shared Phase 12
  allowlist and limits (no PDF, documents, archives or SVG), through the same pipeline as My Story media
  (`docs/media-storage.md`): server-signed direct upload to private ImageKit at
  `/for-after/users/<userId>/my-wishes/<responseId>/<kind>/<assetId>.<ext>` (ids only, through `MediaStorage`; the service
  has no ImageKit code), storage quota reserved before signing (`StorageQuota`, the Customer's single quota), then
  provider check, size/MIME, magic bytes and ClamAV before `READY` (the browser never decides). Infected or mismatched →
  `FAILED`, never signed or copied, and removed; scanner down → 503, stays pending (fail closed). A database `CHECK` keeps
  `kind` to PHOTO/AUDIO/VIDEO and `sizeBytes > 0`.
- **Access:** short-lived signed URLs for the owner only, live wish, live `READY` file. Never stored or logged.
- **Delete:** soft delete first (no more access), then `MediaCleanup` removes the provider file; failures are retried by
  its reconciler, which also retires stale `PENDING_UPLOAD` rows (the `myWishMediaAsset` table is in its list).
- **Upload shell:** a file needs a wish row to belong to: upload auth creates an empty, private one when there is none (or
  restores a deleted one empty, with the current wording). It is never shown as a wish until it has content.
- **Notice:** adding a file needs the current notice acknowledged, like saving text (the existing
  `MyWishesDisclaimerService.assertAcknowledged`, not a second check).

## Sharing after death (Phase 15B)

Product decisions approved 2026-10-09 (`task.md` Phase 01):

| Question | Decision |
|---|---|
| Private while alive | Yes. Only the Customer can read or edit their wishes |
| Who may receive them | People the Customer explicitly picks from their existing People I Love (Recipients). No "family" model: a relationship label grants nothing; only being a recipient of the Message does |
| Trusted Contacts | Never receive or read wish content. Their role stays reporting a death |
| Admins | Operate death verification; never read wish content (no wish data in admin APIs) |
| Mechanism | A Message snapshot, never the wish itself: My Wish → "Create message for loved ones" → independent DRAFT Message → chosen Recipients → `ON_DEATH` or `AFTER_DEATH` schedule → existing verified-death workflow → BullMQ release → `RecipientMessageAccessGrant` → Recipient Portal |
| Several messages | One wish can make any number of messages; different wishes can go to different people |
| Timing | `ON_DEATH` or `AFTER_DEATH` (existing `afterDeathDays`) for after-death sharing. `FIXED_DATE`/`NOW` stay available as for any Message but are not "after-death wish release" |
| Media | PHOTO / AUDIO / VIDEO allowed |
| Notice | Creating a message reads a wish, so it needs no acknowledgement (Phase 15A gates writing wishes only) |
| AI help | Deferred post-MVP (below) |

```text
My Wish (private, unchanged) ──"Create message for loved ones"──► new DRAFT Message (snapshot of the chosen parts)
  ──► People I Love ──► ON_DEATH / AFTER_DEATH ──► report → safeguard → admin verifies ──► release (BullMQ)
  ──► RecipientMessageAccessGrant + minimal release email ──► Recipient Portal
```

`POST /my-wishes/prompts/:promptKey/response/messages` takes the same body as Memory → Message and Story → Message:
`{ title, contentType, includeText, mediaAssetIds, recipientIds }`. `contentType` (TEXT/PHOTO/AUDIO/VIDEO/MIXED) is required
and never inferred; there is no WISH type. `mediaAssetIds` must be this wish's own `READY` files (else 400 `One or more
wish files are invalid.`, the same for another wish's or another Customer's); recipients follow the Message rules (own,
live). A missing, deleted, empty or another Customer's wish is 404. It returns the new Message; nothing is scheduled or
released by this call.

- Same code as Memory → Message and Story → Message (`MessageSnapshotService`, `WishToMessageService` is a thin
  adapter): the draft, its recipients and one `PENDING_UPLOAD` row per copy in one transaction (quota reserved), then
  each file is copied to its own private ImageKit file at the normal message path (`MediaStorage.copyObject`, new
  provider id) and checked again like an upload (magic bytes, ClamAV) before `READY`. A failed copy becomes `FAILED` and
  is cleaned up; the draft stays a draft and cannot be scheduled with an invalid composition; the wish and its files are
  untouched.
- **Snapshot:** text and files are copies. Editing or deleting the wish or its files (even after the message is
  scheduled) never changes, cancels or deletes the message; editing or deleting the message or its files never touches
  the wish. Linked cancellation would be a separate product decision.
- **Release:** only through the existing death workflow: a Trusted Contact report, the safety notice, the safeguard and
  review release nothing; the admin's verification activates `ON_DEATH` (now) and `AFTER_DEATH` (`verifiedDeathAt` +
  `afterDeathDays`) in PostgreSQL, and the normal queue releases them. No wish-specific schedule, worker, grant,
  email or portal exists.
- **Recipients** see only the released Message (and its copied files through normal Message authorisation), never
  `/my-wishes` routes, the catalogue, the prompt key, the notice state, the original files or other wishes. The release
  email is the normal minimal one, with no wish text or files.

## AI help: deferred post-MVP
**Decision (product owner, 2026-10-09): AI help for My Wishes is deferred to post-MVP**, in line with the MVP exclusion of AI
features (`PROJECT_OVERVIEW.md` §54, `task.md` "Out of scope for MVP"). Nothing AI-related is built: no AI button,
suggestions, generated or rewritten text, legal interpretation or provider SDK.

If AI is ever added post-MVP, it must be optional assistance the Customer reviews; its output must never be presented as
legal advice, legal validity or binding instructions; it must keep the notice visible, never decide on the Customer's
behalf, and never change saved text without their explicit action; and no preserved content may be sent to an AI
provider without a separately approved privacy and security design.

## Implementation notes
Shares with My Story the prompt-key format (`PROMPT_KEY_PATTERN`) and the answer-text rule (`AnswerText()`); the catalogue,
pipe, service and controller are its own. Tests: `src/my-wishes/my-wishes.service.spec.ts` (catalogue, neutral wording, key
pipe, DTOs, service with a Prisma mock that fails on any table other than `MyWishResponse`, guards, no logging) and
`test/my-wishes.e2e-spec.ts` (real app, sessions and PostgreSQL). Phase 15B: `my-wishes-media.service.spec.ts` (uploads,
notice gate, quota, magic bytes, malware, scanner outage, access, delete; Wish → Message), `test/my-wishes-rich.e2e-spec.ts`
(real PostgreSQL, Redis and both queues: files, isolation, snapshot copies, independence both ways, Trusted Contact report
→ no release → safeguard → review → admin verifies → `ON_DEATH` and overdue `AFTER_DEATH` released, future one waits →
Recipient reads copies, never My Wishes; Trusted Contact and admin never see wish content); frontend
`my-wishes-rich.test.tsx` and Playwright (`vault.spec.ts`, `portals.spec.ts`). Phase 15A: `my-wishes-disclaimer.service.spec.ts` (exact
wording, status, idempotent acknowledgement, version rules, audit, DTO, guards) and e2e (409 before acknowledgement,
concurrent submits → one row and one audit event, per-user state, a simulated version 2: read/delete still work, writes
wait, history kept); frontend `prompts.test.tsx` and Playwright (`e2e/vault.spec.ts`).

## Not built
Wills, estate planning, executors, medical directives, powers of attorney, legal-document generation, a legal review of the
notice (open), direct Recipient or Trusted Contact access to wishes, release of the wish itself (only Message copies are
released), AI (deferred post-MVP), search, custom prompts, prompt-version migration, admin access, an approved question
catalogue (the V1 catalogue is still a development placeholder).

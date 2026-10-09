# 📖 For After — My Story (Step 10)

> The customer's life story in their own words, answered one guided prompt at a time.

| | |
|---|---|
| **Status** | ✅ Step 10 (text answers) · V1 catalogue, 50,000-character answers, snapshot policy (Phase 14A) · photo/audio/video answers, linked memories, sharing as a Message (Phase 14B), 2026-10-08 |
| **Who can see it** | Only the Customer: no Recipient, Trusted Contact (incl. Step 14) or admin access |
| **Related** | [My Wishes](my-wishes.md) · [Memory Vault](memory-vault.md) · [API](api.md) |

**Contents:** [Private content](#my-story-is-private-customer-content) · [Prompt catalogue](#prompt-catalogue) ·
[Answers](#answers) · [Endpoints](#endpoints) · [PUT, delete and re-answer](#put-delete-and-re-answer) ·
[Rich answers](#rich-answers-phase-14b) · [Sharing: create a message](#sharing-create-a-message-from-an-answer-phase-14b) ·
[Ownership](#ownership) · [Logging](#logging) · [Testing](#testing) · [Not in Step 10](#not-in-step-10)

---

Guided prompts that help a customer write down their life in their own words: childhood, family, relationships, work,
travel, milestones, values, life lessons and legacy. The customer answers any prompt, in any order, and can come back later to
edit, delete or re-answer it. Step 10 is text only.

## My Story is private customer content
A `MyStoryResponse` is **not** a Message, a Memory Vault item, a Recipient or a schedule. It has no recipients, status,
schedule or release trigger of its own, and nothing is ever delivered from it directly. Only the customer who wrote it can
see it (text, files and linked memories): no Recipient, Trusted Contact or admin access, and no public endpoint.
**Approved policy (Phase 14B, 2026-10-08):** sharing an answer means creating a separate Message from chosen parts of it
(below); the answer itself is never given recipients, scheduled or released, and its linked memories are never shared.

## Prompt catalogue
Prompts are application content in `src/my-story/my-story.prompts.ts`, not database rows, so customers cannot change them.
Each prompt has:

| Field | Meaning |
|---|---|
| `key` | Permanent id, e.g. `legacy.remembered`. Stored with every answer; never renamed or reused. Not an array index, not the wording |
| `category` | For grouping only |
| `version` | Starts at 1; bump it when the wording changes |
| `prompt` | The question shown to the customer |

Keys are lowercase letters/digits with hyphens, in dot-separated sections. A malformed key (uppercase, slashes, `..`, URLs)
is 400; a well-formed key that is not in the catalogue is 404. `getPromptByKey()` is the only lookup.

**V1 catalogue, approved by the product owner on 2026-10-08 (Phase 14A).** 9 categories and 22 prompts, shown in this
order (a life, roughly in sequence). The 12 development prompts were kept with their exact keys, wording and version, so
every stored answer still matches; 10 prompts and the `WORK` and `TRAVEL` categories were added from the themes in
`PROJECT_OVERVIEW.md` §17. Labels come from the category id (`LIFE_LESSONS` → "Life lessons").

| # | Category | Key | Prompt |
|---|---|---|---|
| 1 | `CHILDHOOD` | `childhood.earliest-memory` | What is one of your earliest memories? |
| | | `childhood.home` | What was the place you grew up in like? |
| | | `childhood.school` | What do you remember most about your school days? |
| 2 | `FAMILY` | `family.influence` | Who had the greatest influence on you growing up? |
| | | `family.lesson-from-parents` | What is one lesson the people who raised you taught you that stayed with you? |
| | | `family.tradition` | What family tradition has meant the most to you? |
| 3 | `RELATIONSHIPS` | `relationships.love` | What has love taught you? |
| | | `relationships.friendship` | Tell us about a friendship that has mattered to you. |
| 4 | `WORK` | `work.first-job` | What do you remember about your first job? |
| | | `work.meaningful` | What work or role has felt most meaningful to you? |
| 5 | `TRAVEL` | `travel.place` | What is a place you have been that you still think about? |
| | | `travel.journey` | Tell us about a journey that stayed with you. |
| 6 | `MILESTONES` | `milestones.proudest` | What are you most proud of in your life? |
| | | `milestones.turning-point` | What moment changed the direction of your life? |
| | | `milestones.favourite-day` | What is a day you would happily live again? |
| 7 | `VALUES` | `values.guiding-values` | What values have guided the way you live? |
| | | `values.kindness` | What act of kindness has stayed with you? |
| 8 | `LIFE_LESSONS` | `life-lessons.hardest` | What lesson took you the longest to learn? |
| | | `life-lessons.advice` | What advice would you want the people you love to remember? |
| | | `life-lessons.younger-self` | What would you tell your younger self? |
| 9 | `LEGACY` | `legacy.remembered` | How would you like to be remembered? |
| | | `legacy.most-important` | What do you hope the people you love will carry forward from your life? |

**Catalogue rules (approved):**
- **Stable keys.** A key is permanent: never renamed, never reused for another question.
- **Versions.** Any change to a prompt's wording bumps its `version`; a change of meaning needs a **new key** instead.
  The catalogue stays code-defined (no admin editor); there is no catalogue-wide version.
- **Retired prompts.** A prompt is never deleted once answers may exist; it is marked `retired: true`. It is hidden
  unless the customer has answered it: then it is listed with its answer, which stays readable, editable and deletable.
  It takes no new answers and no re-answer after a delete (`PUT` → 404 `Prompt not found.`, like an unknown key).
  V1 retires nothing.
- A unit test pins the approved catalogue (categories, order, keys, the 12 original wordings) and checks integrity
  (unique well-formed keys, valid versions and categories, no blank or duplicate wording).

Categories are a TypeScript list, not a database enum: answers store the key, and the category comes from the catalogue.

## Answers
Table `MyStoryResponse`: `id`, `ownerUserId`, `promptKey`, `promptTextSnapshot`, `promptVersion`, `textContent`,
`createdAt`, `updatedAt`, `deletedAt`, with `UNIQUE (ownerUserId, promptKey)`: **one answer per customer and prompt**.

- **Snapshot and version (approved policy, Phase 14A): the wording first answered.** A new answer, or one written
  again after a delete, stores the catalogue's current wording and version. Editing a live answer changes only its text:
  the stored wording and version stay, even if the catalogue has been reworded since. They are never accepted from the
  client. They **are returned** with the answer (`promptTextSnapshot`, `promptVersion`), so the editor can show "You
  answered an earlier wording of this question: …" when it differs from the current prompt.
- **Text.** Optional since Phase 14B (an answer may be files or memories only); when sent, a string of at most **50,000
  characters** (approved, `MY_STORY_ANSWER_MAX`; My Wishes keeps 20,000) that contains something other than whitespace.
  Omitted = unchanged, `null` = cleared. It is stored exactly as written: not trimmed, rewritten, spell-checked or
  summarised. It is plain text: never interpreted as HTML; clients must escape it when rendering.
- **Server-controlled, never accepted:** `ownerUserId`, `promptKey` (it comes from the URL), `promptTextSnapshot`,
  `promptVersion`, `createdAt`, `updatedAt`, `deletedAt`. Unknown fields are 400.

## Endpoints
All under `/api/v1`, `SessionAuthGuard` + `CustomerGuard` (no session 401; `ADMIN`/`SUPER_ADMIN` 403).

| Method | Path | Result |
|---|---|---|
| `GET` | `/my-story/prompts[?category=CHILDHOOD]` | 200, catalogue order, each with `answered` and `response` |
| `GET` | `/my-story/prompts/:promptKey` | 200, one prompt with `answered` and `response` |
| `GET` | `/my-story/prompts/:promptKey/response` | 200, or 404 if not answered (or deleted) |
| `PUT` | `/my-story/prompts/:promptKey/response` | 200, created / updated / restored answer |
| `DELETE` | `/my-story/prompts/:promptKey/response` | 204 soft delete, with its files and memory links; 404 if there is no live answer |
| `POST` | `/my-story/prompts/:promptKey/response/messages` | 201, a new DRAFT Message from chosen parts (Phase 14B) |
| `POST` | `/my-story/prompts/:promptKey/response/media/upload-url` | 201, signed ImageKit upload (PHOTO/AUDIO/VIDEO) |
| `POST` | `/my-story/prompts/:promptKey/response/media/:mediaAssetId/complete` | 200, verified and scanned → `READY` |
| `GET` | `/my-story/prompts/:promptKey/response/media` | 200, the answer's live files (`[]` if none) |
| `GET` | `/my-story/prompts/:promptKey/response/media/:mediaAssetId/access-url` | 200, short-lived signed URL (`READY` only) |
| `DELETE` | `/my-story/prompts/:promptKey/response/media/:mediaAssetId` | 204, soft delete, then the file is removed |

Prompt: `{ key, category, version, prompt, answered, response }`, where `response` is null or
`{ id, promptKey, promptTextSnapshot, promptVersion, textContent, memories: [{ id, title, category }], mediaCount,
createdAt, updatedAt }` (`memories`: live linked memories; `mediaCount`: `READY` files). Never returned: `ownerUserId`,
`deletedAt`, storage keys or provider ids.

There is no `GET /my-story/responses`: `GET /my-story/prompts` already returns every answer with its prompt, so a separate
list would only duplicate it.

## PUT, delete and re-answer
`PUT` keeps one row per customer and prompt:

- live row → update the text only (the snapshot stays);
- otherwise one atomic Prisma `upsert` on `(ownerUserId, promptKey)`: no row → create it with the current wording;
  soft-deleted row → restore it (`deletedAt = null`, same `id` and `createdAt`) with the current wording;
- a retired prompt takes the first step only (no new answer, no re-answer).

It always returns **200** (the same request gives the same result), and never creates a second row.
`DELETE` sets `deletedAt` and, in the same transaction, soft-deletes the answer's files and removes its memory links;
the files are then removed from ImageKit (retried by `MediaCleanup`). A deleted answer disappears from the prompt list,
`GET .../response` is 404, and the prompt stays available to answer again (starting empty).

## Rich answers (Phase 14B)

Approved 2026-10-08: an answer may hold any mix of text, photos, audio, video and linked memories, with no limit on the
number of files (only the per-file size limits and the storage quota).

- **Content rule.** An answer counts (`answered`, listed, returned) once it has text, a `READY` file or a live linked
  memory. `PUT` refuses to leave an answer with none (400 `Add some words, a photo, a recording or a memory before
  saving.`).
- **Files** (`MyStoryMediaAsset`, migration `my_story_rich_answers`, additive): PHOTO (JPEG/PNG/WebP), AUDIO
  (MP3/M4A/WebM/WAV) and VIDEO (MP4/WebM) with the shared limits and the same pipeline as message and Memory Vault media
  (`docs/media-storage.md`): server-signed direct upload to private ImageKit at
  `/for-after/users/<userId>/my-story/<responseId>/<kind>/<assetId>.<ext>` (ids only), storage quota reserved before
  signing, then provider check, magic bytes and ClamAV scan before `READY` (the browser never decides). Infected or
  mismatched → `FAILED` and removed; scanner down → 503, stays pending. Signed URLs for the owner only, `READY` only.
  Deleting a file soft-deletes first, then `MediaCleanup` removes it (retried); stale uploads are retired by the same
  reconciler.
- **Upload shell.** A file needs an answer row to belong to: upload auth creates an empty, private one when there is
  none (or restores a deleted one empty, with the current wording). It is never shown as an answer until it has content;
  an abandoned one holds only uploads the reconciler retires.
- **Linked memories** (`MyStoryMemoryLink`): `memoryVaultItemIds` in the `PUT` body replaces the whole set (`[]`
  unlinks all; omitted = unchanged). Each must be the customer's own live memory (else 400 `One or more memories are
  invalid.`, same for missing, deleted or another customer's; max 100 as a technical safeguard). A memory deleted later
  just stops appearing; the answer stays. Links are private context: they grant nobody access and are never copied.

## Sharing: create a message from an answer (Phase 14B)

```text
My Story answer (private, unchanged) ──"Create a message"──► new DRAFT Message (a snapshot of the chosen parts)
  ──► People I Love (existing) ──► schedule (existing) ──► release (existing BullMQ) ──► access grant ──► Recipient Portal
```

`POST /my-story/prompts/:promptKey/response/messages` takes the same body as the Memory Vault equivalent:
`{ title, contentType, includeText, mediaAssetIds, recipientIds }`. `contentType` is required and never inferred;
`mediaAssetIds` must be this answer's own `READY` files (else 400 `One or more story files are invalid.`); recipients
follow the Message rules. Another customer's or a deleted answer is 404. It returns the new Message.

- Same code as Memory → Message (`MessageSnapshotService`): the draft, its recipients and one `PENDING_UPLOAD` row per
  copy in one transaction (quota reserved), then each file is copied to its own private ImageKit file at the normal
  message path (`MediaStorage.copyObject`) and checked again like an upload (magic bytes, ClamAV) before `READY`; a failed
  copy becomes `FAILED` and is cleaned up, the draft stays a draft.
- **Snapshot:** own text and own files. Editing or deleting the answer or its files never changes the message, and
  deleting the message or its files never touches the answer. One answer can make any number of messages.
- **Never copied:** linked memories, the prompt wording, category or key. Composition is checked at scheduling as for any
  message (e.g. PHOTO with copied text cannot be scheduled).
- Recipients only ever see the released Message; My Story routes are Customer-only.

## Ownership
Routes use the prompt key, not an answer id, so every query is `{ ownerUserId: <session user>, promptKey, deletedAt: null }`
(the upsert uses the `(ownerUserId, promptKey)` unique key). Two customers answering the same prompt get separate rows;
another customer's answer always looks like "not answered" (404). Deleting a user cascades to their answers.

## Logging
Nothing in the My Story module logs. Story text, session cookies and personal data must never be logged or sent to
analytics; at most ids, the prompt key and an outcome category.

## Testing
- Unit: `src/my-story/my-story.service.spec.ts` (approved catalogue + integrity, key pipe, DTOs incl. 50,000, snapshot
  policy, retired prompts, service with mocked Prisma, guards, no logging).
- E2E: `test/my-story.e2e-spec.ts` (real app, sessions and PostgreSQL: V1 order and filters, an answer written for an
  older wording keeps it on edit and takes the current one after delete + re-answer, cross-user, 50,000 limit).
- Phase 14B: `my-story-media.service.spec.ts` (uploads, checks, malware, access, delete; Story → Message),
  `my-story.service.spec.ts` (content rule, links), `test/my-story-rich.e2e-spec.ts` (files, links, cross-user, Story →
  Message → schedule → release → Recipient, independence both ways, composition, quota).
- Frontend: `prompts.test.tsx` (V1 category order/labels, earlier-wording notice, limits), `my-story-rich.test.tsx`
  (uploads, links, create-message flow) and Playwright (`e2e/vault.spec.ts`; `e2e/portals.spec.ts`: rich answer →
  message → real release → Recipient).

## Not built
Direct sharing of an answer (links, Recipient or Trusted Contact access), answer recipients/schedules/release (a message
is made instead), copying linked memories into a message, conversion to Memory Vault items, AI writing/summaries,
speech-to-text, custom prompts, search, pagination, admin prompt editing, admin access.

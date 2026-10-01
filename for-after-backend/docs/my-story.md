# 📖 For After — My Story (Step 10)

> The customer's life story in their own words, answered one guided prompt at a time.

| | |
|---|---|
| **Status** | ✅ Built in Step 10 (text answers) |
| **Who can see it** | Only the Customer: no Recipient, Trusted Contact (incl. Step 14) or admin access |
| **Related** | [My Wishes](my-wishes.md) · [Memory Vault](memory-vault.md) · [API](api.md) |

**Contents:** [Private content](#my-story-is-private-customer-content) · [Prompt catalogue](#prompt-catalogue) ·
[Answers](#answers) · [Endpoints](#endpoints) · [PUT, delete and re-answer](#put-delete-and-re-answer) ·
[Ownership](#ownership) · [Logging](#logging) · [Testing](#testing) · [Not in Step 10](#not-in-step-10)

---

Guided prompts that help a customer write down their life in their own words: childhood, family, relationships,
milestones, values, life lessons and legacy. The customer answers any prompt, in any order, and can come back later to
edit, delete or re-answer it. Step 10 is text only.

## My Story is private customer content
A `MyStoryResponse` is **not** a Message, a Memory Vault item, a Recipient or a schedule. It has no recipients, status,
schedule, release trigger or media, and nothing is ever delivered or shared from it. It is never converted into a Message or
a `MemoryVaultItem`. Only the customer who wrote it can see it: no Recipient, Trusted Contact or admin access, and no public
endpoint. (Sharing, release, media answers and "create a message from this answer" are possible later features, not built.)

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

**Status of the copy.** The product docs leave the final prompt set to discovery (`PROJECT_OVERVIEW.md` §17 lists only
"possible" categories). The V1 catalogue below is the development placeholder from the Step 10 brief; replace it when the
approved set exists.

| Category | Key | Prompt |
|---|---|---|
| `CHILDHOOD` | `childhood.earliest-memory` | What is one of your earliest memories? |
| `CHILDHOOD` | `childhood.home` | What was the place you grew up in like? |
| `FAMILY` | `family.influence` | Who had the greatest influence on you growing up? |
| `FAMILY` | `family.tradition` | What family tradition has meant the most to you? |
| `RELATIONSHIPS` | `relationships.love` | What has love taught you? |
| `MILESTONES` | `milestones.proudest` | What are you most proud of in your life? |
| `MILESTONES` | `milestones.turning-point` | What moment changed the direction of your life? |
| `VALUES` | `values.guiding-values` | What values have guided the way you live? |
| `LIFE_LESSONS` | `life-lessons.hardest` | What lesson took you the longest to learn? |
| `LIFE_LESSONS` | `life-lessons.advice` | What advice would you want the people you love to remember? |
| `LEGACY` | `legacy.remembered` | How would you like to be remembered? |
| `LEGACY` | `legacy.most-important` | What do you hope the people you love will carry forward from your life? |

Categories are a TypeScript list, not a database enum: answers store the key, and the category comes from the catalogue.

## Answers
Table `MyStoryResponse`: `id`, `ownerUserId`, `promptKey`, `promptTextSnapshot`, `promptVersion`, `textContent`,
`createdAt`, `updatedAt`, `deletedAt`, with `UNIQUE (ownerUserId, promptKey)`: **one answer per customer and prompt**.

- **Snapshot and version.** On every save the server copies the prompt's current wording and version from the catalogue.
  They record which question the current text answers, so a prompt can be reworded later without losing that context.
  They are never accepted from the client and never returned. (No version-migration logic exists yet.)
- **Text.** Required string, max 20,000 characters (the existing Message/Memory Vault limit, `TEXT_CONTENT_MAX`), and it must
  contain something other than whitespace. It is stored exactly as written: not trimmed, rewritten, spell-checked or
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
| `DELETE` | `/my-story/prompts/:promptKey/response` | 204 soft delete; 404 if there is no live answer |

Prompt: `{ key, category, version, prompt, answered, response }`, where `response` is null or
`{ id, promptKey, textContent, createdAt, updatedAt }`. Never returned: `ownerUserId`, `deletedAt`, `promptTextSnapshot`.

There is no `GET /my-story/responses`: `GET /my-story/prompts` already returns every answer with its prompt, so a separate
list would only duplicate it.

## PUT, delete and re-answer
`PUT` is one atomic Prisma `upsert` on `(ownerUserId, promptKey)`:

- no row → create it;
- live row → update the text (and snapshot);
- soft-deleted row → same update plus `deletedAt = null`, which restores it (same `id` and `createdAt`).

It always returns **200** (the same request gives the same result), and never creates a second row.
`DELETE` sets `deletedAt`. A deleted answer disappears from the prompt list, `GET .../response` is 404, and the prompt stays
available to answer again.

## Ownership
Routes use the prompt key, not an answer id, so every query is `{ ownerUserId: <session user>, promptKey, deletedAt: null }`
(the upsert uses the `(ownerUserId, promptKey)` unique key). Two customers answering the same prompt get separate rows;
another customer's answer always looks like "not answered" (404). Deleting a user cascades to their answers.

## Logging
Nothing in the My Story module logs. Story text, session cookies and personal data must never be logged or sent to
analytics; at most ids, the prompt key and an outcome category.

## Testing
- Unit: `src/my-story/my-story.service.spec.ts` (catalogue, key pipe, DTOs, service with mocked Prisma, guards, no logging).
- E2E: `test/my-story.e2e-spec.ts` (real app, sessions and PostgreSQL; no storage).

## Not in Step 10
Media answers (photo, audio, video), links to Memory Vault items, sharing, recipients, scheduling, release after death,
conversion to Messages or Memory Vault items, AI writing/summaries/suggestions, speech-to-text, custom prompts, search,
pagination, prompt-version migration, admin access.

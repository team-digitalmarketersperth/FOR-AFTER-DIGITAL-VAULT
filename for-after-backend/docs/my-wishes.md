# 🕊️ For After — My Wishes (Step 11)

| | |
|---|---|
| **Status** | ✅ Built in Step 11 (text answers) |
| **Who can see it** | Only the Customer: no Recipient, Trusted Contact (incl. Step 14) or admin access |
| **Related** | [My Story](my-story.md) · [Death verification](death-verification.md) · [API](api.md) |

**Contents:** [Not a legal document](#not-a-legal-document) · [Private content](#private-customer-content) ·
[Prompt catalogue](#prompt-catalogue) · [Answers](#answers) · [Endpoints](#endpoints) ·
[PUT, delete and re-answer](#put-delete-and-re-answer) · [Ownership](#ownership) · [Logging](#logging-and-privacy) ·
[AI guardrail](#future-ai-guardrail) · [Implementation notes](#implementation-notes) · [Not in Step 11](#not-in-step-11)

---

> **My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive,
> financial instruction or substitute for professional advice.**

A private place for a customer to write down how they would like their farewell, memorial or celebration of life to feel,
and what they would like the people who may one day organise it to know: ceremony and setting, atmosphere, music and
readings, people and traditions, other preferences and a personal message. Step 11 is text only.

## Not a legal document
My Wishes is informational and personal. It is **not** a will, testamentary document, advance health directive, medical
directive, power of attorney, financial instruction, binding funeral contract, estate-planning advice or legal advice, and
the API, data model and docs never describe it as legally binding. Field and API names use neutral words only (wish,
preference, guidance, response); prompts ask about preferences, never about instructions, executors or directives.

**Disclaimer.** The frontend must show a prominent disclaimer such as the one at the top of this page (the Step 18
frontend shows it, word for word, on the My Wishes list and on every answer page). It is not stored
per answer and there is no acknowledgement field: `acceptedLegalDisclaimer` or similar is rejected (400) like any unknown
field. If legal review later requires explicit acknowledgement, add a dedicated, versioned consent record rather than a flag
on every save. The API does not serve the disclaimer text yet (see open decisions).

## Private customer content
A `MyWishResponse` is its own domain: not a Message, Memory Vault item, My Story answer, Recipient or Trusted Contact. It has
no recipients, status, schedule, release trigger or media, and nothing is ever delivered, shared or released from it.
Saving a wish never creates a Message, schedule, memory or story answer. Only the customer who wrote it can see it:

- no Recipient access (no `recipientIds`, `sharedWith` or `releaseTo`);
- no Trusted Contact access: since Step 14 they can sign in and report a death, which grants no access to private
  content (they see only a true/false "preserved content exists", which counts wishes among other content);
- no admin access (`ADMIN`/`SUPER_ADMIN` get 403) and no public endpoint;
- no release (`NOW`, `FIXED_DATE`, `ON_DEATH`, `AFTER_DEATH`). How wishes might become available after a verified death is a
  future product decision.

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
- **Text:** required string, max 20,000 characters (the existing `TEXT_CONTENT_MAX`, shared with Messages, Memory Vault and
  My Story; longer text is rejected with 400, never truncated), must contain something other than whitespace. Stored exactly
  as written: not trimmed, corrected, summarised, translated or turned into legal wording. Plain text, never HTML; clients
  escape it when rendering.
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
| `DELETE` | `/my-wishes/prompts/:promptKey/response` | 204 soft delete; 404 if there is no live answer |

Prompt: `{ key, category, version, prompt, answered, response }`; `response` is null or
`{ id, promptKey, textContent, createdAt, updatedAt }`. No `GET /my-wishes/responses`: My Story has no such list either, and
the prompt list already carries every answer.

## PUT, delete and re-answer
`PUT` is one atomic Prisma `upsert` on `(ownerUserId, promptKey)`: no row → create; live row → update; soft-deleted row →
update and `deletedAt = null` (restored, same `id`). Always 200, never a second row. `DELETE` sets `deletedAt`; the answer
then shows as unanswered, `GET .../response` is 404, and the prompt can be answered again.

## Ownership
Every query is `{ ownerUserId: <session user>, promptKey, deletedAt: null }` (the upsert uses the unique key). Two customers
answering the same prompt get separate rows; another customer's answer always looks unanswered (404). Deleting a user
cascades to their wishes.

## Logging and privacy
The module does not log. Wish text, funeral preferences, personal messages, session cookies and passwords must never be
logged or sent to analytics; at most ids, the prompt key and an outcome category.

## Future AI guardrail
No AI is used in Step 11. If AI is ever added to My Wishes (suggestions, rewording, summaries), its output must never be
presented as legal advice or as legally binding instructions, must keep the disclaimer visible, and must never change the
customer's saved text without their explicit action.

## Implementation notes
Shares with My Story the prompt-key format (`PROMPT_KEY_PATTERN`) and the answer-text rule (`AnswerText()`); the catalogue,
pipe, service and controller are its own. Tests: `src/my-wishes/my-wishes.service.spec.ts` (catalogue, neutral wording, key
pipe, DTOs, service with a Prisma mock that fails on any table other than `MyWishResponse`, guards, no logging) and
`test/my-wishes.e2e-spec.ts` (real app, sessions and PostgreSQL).

## Not in Step 11
Wills, estate planning, executors, medical directives, powers of attorney, legal-document generation, acknowledgement
tracking, media, sharing, Recipient or Trusted Contact access, release or death-triggered publication, AI, search,
custom prompts, prompt-version migration, admin access.

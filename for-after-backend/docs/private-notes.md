# Private notes to self

A Customer can keep a private reminder on their own content ("Rewrite this
after Sarah graduates", "Find the better photo later"). It is owner metadata,
not content.

## Where

| Entity | Field | Set via |
|---|---|---|
| Message | `Message.privateNote` | `POST /messages`, `PATCH /messages/:id` (DRAFT only, like every message edit) |
| Memory Vault item | `MemoryVaultItem.privateNote` | `POST /memory-vault`, `PATCH /memory-vault/:id` |
| My Story answer | `MyStoryResponse.privateNote` | `PUT /my-story/prompts/:key/response` |
| My Wishes answer | `MyWishResponse.privateNote` | `PUT /my-wishes/prompts/:key/response` |

Nullable `TEXT` columns (migration `add_private_notes_to_preserved_content`,
additive; existing rows are `null`). No separate table or endpoint: the note
lives and dies with its parent (soft delete included).

## Rules

- **Format:** plain text, max **2,000** characters (the existing
  `Recipient.privateNote` limit). Trimmed; blank = `null`. Omitted = unchanged,
  `null` = cleared. Validated by the `PrivateNote()` DTO decorator.
- **Who sees it:** only the owner, through their own detail responses
  (message detail, memory detail, story/wish prompt and answer). Every read and
  write is owner-scoped like the parent; another Customer gets the same 404.
- **Never in:** message summaries, the Memory Vault list, `MessageVersion`,
  `MessageRelease`, access grants, release emails, the Recipient Portal, the
  Trusted Contact portal, admin APIs, death verification, the delivery
  timeline, readiness or attention items. All of these use explicit Prisma
  `select`s that do not name the field.
- **Sharing:** Memory → Message, Story → Message and Wish → Message copy only
  the chosen text and files (`MessageSnapshotService`); the new Message's
  `privateNote` is `null`.
- **Search:** not searched (Memory Vault search covers title and text only).
- **Versions:** not versioned. A note-only save makes no new `MessageVersion`;
  restoring a version changes content only and leaves the current note.
- **Autosave:** not autosaved (V1). Draft recovery payloads hold the editor's
  content fields only; the note is saved with the explicit Save.
- **Not content:** a note alone does not make a Story/Wish answer "answered".
  A deleted answer that is written again starts without its old note.
- **Activity / audit / logs:** the normal parent event only ("Message
  updated", "Memory updated", ...). The text is never in activity metadata,
  `AuditLog` or application logs.
- **Admins:** the admin application has no route that returns a note. This is
  an API/UI rule; people with direct database access can still read rows.
- **Export:** there is no Customer data export yet. When one is built, notes
  belong in the owner's own export only, never in anything a Recipient
  receives.

Tests: `test/private-notes.e2e-spec.ts`, `test/recipient-portal.e2e-spec.ts`
(released message excludes the note).

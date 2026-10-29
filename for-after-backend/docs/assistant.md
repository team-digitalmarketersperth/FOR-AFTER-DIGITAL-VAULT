# ✨ For After — Companion AI replies (Groq)

| | |
|---|---|
| **Status** | Built locally 2026-10-27, **verified with Groq mocked only**. Not verified against live Groq. Not deployed. |
| **Backend** | `src/assistant/` (`AssistantModule`): `POST /api/v1/assistant/reply` |
| **Frontend** | The one companion in the Customer shell: `for-after-frontend/src/components/companion/companion.tsx`, client `src/lib/api/assistant.ts` |
| **Provider** | Groq, OpenAI-compatible Chat Completions (`https://api.groq.com/openai/v1/chat/completions`), plain `fetch`, no SDK |
| **Storage** | None. No conversation, prompt or reply is stored or logged. |

## 1. Configuration (backend only)

| Name | Required | Default | Meaning |
|---|---|---|---|
| `GROQ_API_KEY` | for AI replies | — | Unset/empty: every request is `503`, the companion says AI is unavailable, quick answers still work. |
| `GROQ_MODEL` | no | `llama-3.3-70b-versatile` | A Groq production text model (checked on console.groq.com/docs/models, 2026-10-27). Never taken from a request. |
| `ASSISTANT_USER_LIMIT_PER_HOUR` | no | `30` | Requests per Customer per fixed hour. |
| `ASSISTANT_GLOBAL_LIMIT_PER_MINUTE` | no | `20` | Provider attempts per minute for the whole app (retries count). |
| `ASSISTANT_MAX_CONCURRENT` | no | `3` | Provider requests in flight for the whole app. |

These are **application limits**, not Groq quotas. Groq's limits depend on the account and model: check the
account's limits page in the Groq console. Config is read at startup: **restart the API** (and nothing else) after
changing any of these. The key never goes to the frontend (no `NEXT_PUBLIC_` value).

## 2. Endpoint

`POST /api/v1/assistant/reply`, Customer session (`SessionAuthGuard` + `CustomerGuard`; anonymous 401, other
principals denied), the app's Origin check (foreign Origin 403), `ValidationPipe` (unknown fields 400).

```jsonc
// request
{
  "page": "dashboard | people | trusted-contacts | messages | memory-vault | my-story | my-wishes | account",
  "action": "ask | draft | improve | shorten | expand | questions | caption",  // allowed per page, below
  "message": "what the Customer typed (≤ 2,000)",                               // optional; required for ask
  "source": "text the Customer chose to include (≤ 6,000)",                     // optional
  "promptKey": "my-story question key",                                        // my-story only; looked up in the catalogue
  "history": [{ "role": "user | assistant", "content": "≤ 3,000" }]             // ≤ 6 turns
}
// 200
{ "reply": "plain text", "truncated": false, "draft": false, "open": "people" }   // open: optional
```

`draft` and `open` come from optional marker lines the model may write (`[DRAFT]` first, `[OPEN: id]` last). The
server (`readMarkers`) removes every marker from the text and keeps the metadata only when it is valid:

- `draft: true` only if the reply started with `[DRAFT]`, was not cut short, and the request allows editor text
  (`draft`, `improve`, `shorten`, `expand`, or `ask` on a page with writing actions: Messages, Memory Vault,
  My Story, My Wishes). The `[DRAFT]` instruction is only given for those requests.
- `open` only if the id is one of the eight page ids above and is not the current page. Anything else (a URL,
  `javascript:`, an unknown id) is dropped. A reply that was nothing but markers is a `502`.

Total characters (message + source + history) ≤ 12,000; output ≤ 700 completion tokens (`truncated: true` when cut).

| Page | Actions |
|---|---|
| dashboard, people, trusted-contacts, account | `ask` |
| messages | `ask`, `draft`, `improve`, `shorten` |
| memory-vault | `ask`, `expand`, `caption` |
| my-story | `ask`, `expand`, `questions`, `improve` |
| my-wishes | `ask`, `draft`, `questions` |

Errors: `400` invalid/unsupported/too long · `404` unknown `promptKey` · `429` busy (Customer limit, app-wide limit,
in-flight cap, or Groq 429) · `502` Groq timeout, network, 5xx or malformed/empty output · `503` not configured, Groq
401/403/400/404 (key or model problem), or Redis unavailable (limits fail closed).

## 3. What is sent to Groq

Server-built instructions (rules + that page's application facts from `GUIDE` in `assistant.service.ts`), then the
history turns, then one user turn: the task, the My Story question text (from the catalogue), the included text
between `<source>` tags (treated as material, not instructions), and the typed message. **Nothing else**: no account
data, names, emails, private notes, files, signed URLs or other records. The server reads no saved entity, so there
is no cross-user lookup; identity comes from the session and is used only for the rate-limit key.

The panel is titled "For After AI companion" ("A little guidance, at your pace."). Under the composer: "AI suggestions ·
You choose what to share" and a "Privacy" disclosure, which starts "Only your messages and text you choose to include
are sent to an external AI service", names Groq and lists what is sent; the provider is not named elsewhere in the
chat UI. The Customer's answer text is
included only after they tick "Include the text in “<field>”" (a preview shows exactly what). No claim is made
about Groq retention, data residency or training: **check Groq's terms for the account before production**.

**Page knowledge.** `GUIDE` holds short, verified facts per page: purpose, real button labels, steps,
permission limits (for example, a trusted contact can report a death, add supporting documents and see the review
status, but cannot read anything or manage the account) and what is not in the app yet (no plans, payments or
billing). The current page's facts come first and the other pages' facts follow, so a question about another section
can still be answered. No private record is read to personalise them. **Maintenance:** when a page's labels or
workflow change, update its `GUIDE` entry from the code (not from `task.md` plans) and the spec's label checks.

**Response style (`RULES`).** Answer the actual question with the real labels; one manageable next step for broad
questions, a short numbered sequence only when steps are asked for; conditional wording because it cannot see the
account ("if you haven't yet…"); use earlier turns without repeating itself; at most one focused question, and one
small question before drafting for someone unsure what to write; ask for text again rather than guess if it is no
longer visible; no "Let me know if…" endings; say when something is not in For After; never claim an action; never
write as someone who has died or state another person's feelings as fact; plain text (no Markdown or links).

**Instructions, not training.** Reply quality comes from the server-built instructions (`RULES`, `TASK`, `GUIDE`
with the real menu and button names) sent with each request. No model is trained or fine-tuned, and no conversation
is collected for training.

## 4. Reliability

- One request budget of 25 s, retries included. At most one retry: Groq 5xx/498 or a network error (after 0.5 s),
  or a Groq 429 whose `retry-after` is ≤ 3 s. Never retried: 401/403/400/404/422, timeouts, browser cancellation.
- The browser closing the request (Stop, closing the panel, leaving) aborts the Groq call.
- In-flight cap: a Redis sorted set of request ids; released on success, error and cancellation; a crashed request
  stops counting after the budget + 5 s.
- Logs: `assistant_reply id=<8 chars> page action outcome ms tokens` and `assistant_provider_failed category status`.
  Never the key, prompts, included text, replies or provider error bodies. Observe tracing (when its keys are set)
  records outbound calls as `POST api.groq.com` spans; request bodies are not captured (Observe's body capture is off).

## 5. Frontend behaviour

- One companion, mounted in the Customer shell and keyed by account: not on public, auth, Admin, Recipient or
  Trusted Contact pages; signing out or switching account drops it and aborts any request.
- Opening it or navigating sends nothing. An empty conversation shows "What would you like help with?" and up to
  three suggested questions for the page (`PAGES` in `companion.tsx`): clicking one sends it exactly like a typed
  message (one request, shown as the Customer's turn first). There are no stored answers: every reply comes from the
  endpoint, and a failure shows a status with Try again (the question is kept and not repeated), never canned text.
- Follow-ups: each request sends the earlier turns of the same context as `history` (bounded by the limits above),
  never the current message, which goes once as the last turn.
- A new page, another My Story question, or the editor going away starts a new context: the conversation, typed
  text and included text are cleared, the request is aborted, and a late reply is ignored (context id check).
- Replies render as plain text (React-escaped), labelled "AI companion". "Thinking…" while waiting; Copy, Try again,
  Stop. The panel is modal: closing it stops the request, so the editor cannot be edited while a reply is generated.
- **Section links.** A reply with `open` shows "Open <section>" (for example "Open People I Love"); the URL comes from
  `PAGES` in `companion.tsx` (`/dashboard`, `/people`, `/trusted-contacts`, `/messages`, `/memory-vault`, `/my-story`,
  `/my-wishes`, `/settings`), never from the reply. It is a plain link (full page load), only followed when clicked,
  so the page's "leave with unsaved changes?" browser check still runs.
- **Editor hand-off ("Help me write").** `HelpMeWrite` registers one field: its key (entity and field), what is shown
  ("For:", the field label, the save button's name) and read/write access. Leaving the field or page releases it.

  | Editor | Field | Key | Saved only by |
  |---|---|---|---|
  | My Story (workspace and question page) | Your answer | question key (also sent as `promptKey`) | Save answer |
  | Messages (write / edit) | Message | `message:<id or new>:textContent` | Save draft / Save changes |
  | Memory Vault (save / edit) | The memory | `memory:<id or new>:textContent` | Save memory / Save changes |
  | My Wishes (question page) | Your answer | wish question key | Save answer |

  Titles, people, tags, private notes, files and linked memories are never read. "Use this draft" appears only on a
  reply with `draft: true`, for the field it was asked for, and places the text only if the field is unchanged since
  the request (otherwise: "… has changed since you asked", Copy instead). It never saves, sends or schedules; the
  field becomes unsaved and the editor's own Save is still needed. Caption suggestions (several options) are Copy
  only. On "Create message" pages reached from a memory, story or wish, the companion offers that section's writing
  actions for the message field.
- **Included text.** Only after ticking "Include the text in “<field>”", with a preview of exactly what is sent. The
  preview is a snapshot: if the field changed since, sending updates the preview first and sends nothing until the
  Customer sends again.

## 6. Manual smoke test (fictional content only; not run as part of the build)

1. Make sure `GROQ_API_KEY` is set in the backend `.env` and restart the API.
2. Sign in as a test Customer. Open the companion on the Dashboard; confirm no network request was made.
3. Type "Where should I start?" and Send. Expect a short plain-text reply about People I Love / Messages.
4. Go to My Story, type a fictional answer (e.g. "A blue kite at the beach with my fictional cousin Sam."),
   choose Help me write, tick Include, choose Polish my answer. Expect a reply, then Use this draft: the answer box
   changes, nothing is saved until Save answer.
5. Navigate to Memory Vault and reopen: the conversation is gone.
6. Temporarily unset the key, restart, Send: expect "The assistant isn't available right now".
7. Check the API log: only `assistant_reply …` metadata lines, no text.

### Manual evaluation checklist (live model; fictional data)

**Run 2026-10-29** against `openai/gpt-oss-120b` (20 requests, results and fixes in
[assistant-evaluation.md](assistant-evaluation.md)): 1–4, 6, 7 and 9 pass live; 8 passes on the client side
(server-side cancellation not observed live); 5 not re-verified after the drafting fix. Not complete: rerun 5,
and confirm 1–2 show no asterisks, on the next live check.

Expected behaviour, not fixed wording. Mocked tests only cover the integration.

1. Dashboard, "Where should I start?": one suggested step with conditional wording (no assumption it is undone),
   maybe "Open People I Love"; no list of every feature.
2. "I already added someone. What next?": builds on that; suggests a next step such as writing a message.
3. On Messages (Help me write), "Help me write a message for my daughter": asks one small question, no full draft.
4. "Something I admire about her.": a short draft using only that; "Use this draft" only if the reply is the text.
5. "Make that shorter.": a shorter version of the previous draft, not a new one.
6. "What can my trusted contact access?": report a death, add documents, see the status; cannot read anything or
   manage the account; the review releases nothing on its own.
7. Ask about billing or another missing feature: says it is not in For After; nothing invented.
8. Change page while a reply is pending: no reply lands on the new page; nothing from the old page is shown.
9. Edit the field after the reply arrives, then "Use this draft": refused with "has changed since you asked".

**Known limitations:** in-app links elsewhere in the app are not intercepted for unsaved changes (only the browser's
leave check runs); the server removes paired `**bold**` markers the model adds (seen live) but leaves `* ` bullets;
the model may not use the markers, in which case there is no link or "Use this draft" (Copy
still works); no undo for a placed draft beyond the editor's normal editing.

## 7. Before production

- Confirm Groq's data-use terms for the account and record the decision (privacy notice).
- Confirm the account's real limits; set the three limits so the whole app stays under them. Seen 2026-10-29: with
  ~2,000 tokens per request, five requests in 15 s hit the provider's per-minute limit (`429`), so the default
  `ASSISTANT_GLOBAL_LIMIT_PER_MINUTE=20` is too high for that account.
- A production key per environment, held in the host's secret store.

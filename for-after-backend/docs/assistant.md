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
{ "reply": "plain text", "truncated": false }
```

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

The companion shows that replies come from AI through Groq, an external service. The Customer's answer text is
included only after they tick "Include the text in my answer box" (a preview shows exactly what). No claim is made
about Groq retention, data residency or training: **check Groq's terms for the account before production**.

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
- Opening it or navigating sends nothing. Quick answers are static and labelled "from For After, not AI".
- A new page, another My Story question, or the editor going away starts a new context: the conversation, typed
  text and included text are cleared, the request is aborted, and a late reply is ignored (context id check).
- Replies render as plain text (React-escaped). Copy, Try again (same request; the typed text is kept on errors),
  Stop.
- "Use this draft" appears only on a reply written for the open My Story question, and only places the text if the
  answer is unchanged since the request; otherwise it says so (copy instead). It never saves: Save answer is still
  required. Messages, Memory Vault and My Wishes have no editor hand-off: Copy only.

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

## 7. Before production

- Confirm Groq's data-use terms for the account and record the decision (privacy notice).
- Confirm the account's real limits; set the three limits so the whole app stays under them.
- A production key per environment, held in the host's secret store.

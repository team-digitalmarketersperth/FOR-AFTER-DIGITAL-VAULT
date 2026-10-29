# Companion live evaluation — 2026-10-29

Bounded live check of the companion's answers against the configured AI service, using the checklist in
`assistant.md` ("Manual evaluation checklist"). Fictional content only. No prompts or replies are kept in
runtime logs; the excerpts below are the fictional test conversation.

## Setup

- **Model:** `GROQ_MODEL=openai/gpt-oss-120b` (Groq; key present in the backend `.env`, not shown or changed).
- **API:** a separate local instance on :4001, built with `nest build` into a temporary folder from the
  current source, run against the isolated test database `for_after_p24` and Redis :6390
  (`scripts/phase24/isolated-env.mjs`), with `EMAIL_PROVIDER=console`, `SMS_*_PROVIDER=console`, its own queue
  names and no worker. Observe tracing kept the local settings (the API does not start with them removed).
- **Frontend:** the production build (`next start -p 3100`), driven by Playwright; browser calls to :4000 were
  forwarded to :4001, every other external host blocked (none were requested).
- **Account:** a fictional Customer registered through `POST /auth/register` and verified with the logged
  console link; signed in through the normal login page; deleted afterwards.
- **Budget:** 20 generation requests, all used (4 runs: 9 + 7 + 2 + 2). No automatic retries by the script.

## Results

| # | Scenario | Expected | Observed (final run) | Status |
|---|---|---|---|---|
| 1 | Dashboard: "Where should I start?" | One step, conditional, no assumption | Round 1: unconditional, `**bold**`. Round 2 (after fix): "If you haven’t added anyone yet, start by opening "People I Love" and tap "Add someone you love"." plus "Open People I Love" → `/people`. Bold still sent by the model; removed by the server since round 3 (not re-run live; mocked test with the live string) | PASS (formatting fix verified with mocks only) |
| 2 | "I already added someone. What next?" | Builds on it, one next step | Round 1: five numbered steps with bold. Round 2: "If you haven’t written a message yet, go to "Messages" and tap "Write a message"…", "Open Messages" → `/messages`; history `[user, assistant]` | PASS (same bold note) |
| 3 | Messages, Help me write: "Help me write a message for my daughter." | One small question, no draft | Round 1: three questions at once. Round 3: "What would you like to express to your daughter in this message?" | PASS |
| 4 | "Something I admire about her: she loves painting and is patient with her younger brother." | Short draft from those facts only; Use this draft | Rounds 1–2: asked more questions (title, timing, "anything else?"). Round 3: a 3-sentence draft about painting and patience with her brother, `draft: true`; Use this draft filled "Message", status "It isn’t saved…", no save request. Some added imagery ("turning colors into stories") but no invented events | PASS |
| 5 | "Make that shorter." | Shorter version of the last draft | Round 2 (before the draft fix, so no earlier draft existed): a one-line draft from the given facts. Not re-run after the fix (budget) | NOT RE-VERIFIED |
| 6 | Trusted Contacts: "What can my trusted contact access?" | Report, documents, status; nothing else | Listed exactly those three; "cannot read any of your messages, memories, story or wishes, and … can’t manage or change any account settings" | PASS |
| 7 | Account settings: subscription / billing | Says it is not in For After | "There isn’t a subscription plan or billing section in For After…" | PASS |
| 8 | Change page while a reply is pending | No reply on the new page; nothing earlier sent | Sent on Messages, closed the panel, clicked People I Love: new page empty, no earlier text shown; next request `history: []`, no earlier text. The reply returned in 1.3 s and the forwarding proxy completes upstream calls, so server-side cancellation was **not observed live** (covered by mocked tests) | PASS (client side); server abort NOT OBSERVED |
| 9 | Edit the field after the reply, then Use this draft | Refused; edit kept; Copy | Round 2: ""Message" has changed since you asked, so the draft wasn’t placed. Copy it instead, or ask again."; edited text kept; Copy available | PASS |

No Markdown markers, `[DRAFT]` or `[OPEN …]` text appeared in any reply. Section links only appeared for
approved ids and pointed to app routes. "Use this draft" appeared only on replies the server marked as a draft
(rounds 2–3), never on questions or guidance. No save, send or schedule request was made in any run.

## Availability

Round 1: requests 6–9 got `429` from the provider (logged `assistant_provider_failed category=provider_429`)
after five requests of ~1,800–2,000 tokens each within about 15 s. This is the account's per-minute token limit,
not answer quality; later rounds paced requests 20 s apart and had no 429s. The app's own limits
(`ASSISTANT_GLOBAL_LIMIT_PER_MINUTE`, default 20) are far above what this account allows at that prompt size;
set them before production (see "Before production" in `assistant.md`).

## Fixes made

1. Instructions: broad questions get one or two sentences with one conditional step; at most one question per
   reply; once a detail is given, draft without asking about title, date, delivery or recipient; "Make it
   shorter" means the last draft; button names in double quotes, no asterisks. `draft` task asks one question,
   not three.
2. `ask` task text no longer says "asking for what is missing" (it made the model ask instead of drafting).
3. Server removes paired `**bold**` markers on one line from replies (the model kept adding them); a lone `*`
   stays. Mocked regression tests cover each fix (`assistant.service.spec.ts`).

## Remaining

- Scenario 5 after the draft fix, and scenario 1's bold removal, not seen live (budget used).
- `* ` bullet lists still appear in some replies (plain text, left as is). One extra reply in scenario 8 said a
  person's first name "is what the person will see when they get an email notification", which is not in the
  facts.
- Server-side cancellation of a live request not observed.

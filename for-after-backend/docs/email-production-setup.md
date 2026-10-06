# ✉️ For After — Transactional email (Step 24)

> How For After sends its four transactional emails through Brevo, how it is tested, and the manual steps to go live.
> Emails are **notifications and access only**: they never carry preserved content.

|                         |                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider**            | **[Brevo](https://www.brevo.com)** (selected), behind a provider-neutral `EmailProvider`. A Resend adapter remains as an optional, inactive alternative (§6)                                                                                                                                                |
| **Emails**              | Recipient sign-in code · Trusted Contact sign-in code · "A message is waiting for you" · account-holder safety notice · Customer email verification · password reset (Phase 04) · change-email link to the new address · "email changed" notice to the old one (Phase 08) · Trusted Contact invitation (Phase 10)                                   |
| **Not sent**            | Marketing, newsletters, SMS (OTP and invitations deferred), message content, photos, audio, signed links                                                                                                                                                                                                                      |
| **Code**                | `src/email/` (providers, templates, module) · `src/release-notifications/` (queue, worker, reconciler)                                                                                                                                                                                                      |
| **Status (2026-10-05)** | Brevo adapter complete and unit-tested. Development uses a **Brevo-verified personal sender, no custom domain**. Brevo's authorised-IP blocking is **turned off for development** and the key is accepted from the workstation (read-only check). First real OTP to an inbox: **pending confirmation** (§5) |

---

## 1. Architecture

```
Recipient / Trusted Contact OTP  ─┐
                                  ├─► EmailOtpDelivery ──────────────┐
Register / resend / forgot pw ────┤
Change email (confirm, notice) ───┼─► AuthTokensService ─────────────┤
Death report → workflow claim ────┼─► EmailDeathNoticeDelivery ──────┤
                                  │                                  ├─► EmailProvider ─► Brevo
Release transaction ─► ReleaseNotification row (PENDING)             │     (brevo | resend | console | disabled;
      └─► email-delivery queue ─► ReleaseNotificationProcessor ──────┘      tests: FakeEmailProvider)
```

Business code depends on `EmailProvider` (`send(message) → { providerMessageId }`, throws `EmailSendError { code,
retryable }`), never on a provider. Controllers never send email. Switching provider is a config change.

| Email                                             | Trigger                                                                                                         | Durability, retries, idempotency                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign-in code** (Recipient, Trusted Contact)     | `POST /…-auth/request-otp`, only when the email is eligible                                                     | Sent directly, not queued: a job would keep the plaintext code in Redis job data and failed-job history, where only its HMAC may live, and a retry after the 10-minute expiry is useless (the person asks for a new code). Still fire-and-forget, so response timing never reveals eligibility. A failed send is logged (`…_otp_delivery_failed`), never shown          |
| **Safety notice** to the account holder           | A Trusted Contact's death report (`afterReport`) and the death-verification reconciler                          | Existing workflow: an attempt is claimed in PostgreSQL only while the case is `PENDING_VERIFICATION` (a cancelled case is never emailed); the safeguard starts only after a successful send; failures are retried every reconcile interval. Idempotency key `death-safety/<caseId>`                                                                                     |
| **Verify email / reset password** (Phase 04)      | Registration and `resend-verification`; `forgot-password`, only for an eligible account                         | Sent directly, not queued, for the same reason as sign-in codes: the link's token must exist only in the email (PostgreSQL keeps its SHA-256). Fire-and-forget, so neither answer nor timing reveals whether the account exists. At most 3 per account per hour; a failed send is logged (`verify-email_failed` / `reset-password_failed`) and the person can ask again |
| **Change email** (Phase 08)                       | `POST /auth/change-email` (link to the NEW address) and its confirmation (notice to the OLD address)            | Link: sent directly, like the other token links (the raw token exists only in the email). Notice: sent after the change commits; a failure is logged (`email-changed_failed`) and never undoes the change. No durable retry                                                                                                                                             |
| **Trusted Contact invitation** (Phase 10)         | Adding a Trusted Contact with an email; `POST /trusted-contacts/:id/invitation` (resend)                        | Sent directly, not queued, like the other token links: only the SHA-256 of the token is stored. At most 3 per contact per hour. A failed send cancels that link and is reported to the Customer (`503` on resend; `NOT_SENT` on create); logged as `trusted_contact_invitation_failed`. Contains the account holder's display name only, never content |
| **"A message is waiting for you"** to a Recipient | A real release (`MessageReleaseService`), inside the same transaction as the `MessageRelease` and access grants | `ReleaseNotification` row per grant that has an email (unique `grantId`), job on the `email-delivery` queue (job id `release-notification-<id>`, payload = the row id only), worker re-checks PostgreSQL, idempotency key `release-notification/<id>`, exponential backoff, reconciler for missed enqueues                                                              |

Idempotency keys are provider-neutral. Brevo receives them as the `Idempotency-Key` email header (Resend as its
idempotency option). The app's own guards (skip `SENT` rows, claimed attempts) are the primary protection.

**A failed email never undoes or blocks anything else.** A release stays `RELEASED` and readable in the portal; an
OTP request still answers `202`; a death case just stays `PENDING_VERIFICATION` until the notice is sent.

## 2. Providers and configuration

| `EMAIL_PROVIDER`                        | Behaviour                                                                                              | Allowed                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `brevo` (selected)                      | `POST https://api.brevo.com/v3/smtp/email` over `fetch` (no SDK), 10 s timeout by default, one attempt | Always; production requires `brevo` or `resend`           |
| `resend` (optional, not active)         | Sends through the Resend SDK                                                                           | Always                                                    |
| `console`                               | Prints `[DEV ONLY] Email (<kind>) to s***@… \| subject \| plain text` (sign-in codes included)         | Only with `NODE_ENV=development`; startup fails otherwise |
| `disabled` (default outside production) | Nothing is sent; every send fails permanently (`email_disabled`)                                       | Not in production                                         |

Automated tests never call a provider: e2e runs set `EMAIL_PROVIDER=disabled`, and suites that check emails replace the
provider with `test/fake-email.ts` (an in-memory inbox that can simulate outages). The one real-network test,
`src/email/brevo-email-provider.live.spec.ts`, is skipped unless `BREVO_LIVE_TEST=1` (§5).

| Variable                                      |       Required        | Notes                                                                                                                   |
| --------------------------------------------- | :-------------------: | ----------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                              |   yes in production   | see above                                                                                                               |
| `BREVO_API_KEY`                               |     with `brevo`      | A Brevo **v3 API key** (`xkeysib-…`), not an SMTP key. **Server-side only.** Never in the frontend, a response or a log |
| `RESEND_API_KEY`                              |     with `resend`     | Only read when `EMAIL_PROVIDER=resend`; never required for Brevo                                                        |
| `EMAIL_FROM_ADDRESS`                          | with `brevo`/`resend` | A sender **verified in Brevo**. A verified personal address is fine for development; no custom domain is required       |
| `EMAIL_FROM_NAME`                             |          no           | Default `For After`                                                                                                     |
| `APP_BASE_URL`                                |   unless `disabled`   | App origin for links, no path (`http://localhost:3000`; `https://…` required in production)                             |
| `EMAIL_SEND_TIMEOUT_MS`                       |          no           | Default `10000`                                                                                                         |
| `EMAIL_QUEUE_NAME`                            |          no           | Default `email-delivery`                                                                                                |
| `EMAIL_JOB_ATTEMPTS` / `EMAIL_JOB_BACKOFF_MS` |          no           | Defaults `5` / `30000` (exponential: 30 s, 60 s, 120 s, 240 s)                                                          |
| `EMAIL_RECONCILE_INTERVAL_SECONDS`            |          no           | Default `60`; only rows older than 2 minutes are re-queued                                                              |

All of this is validated at startup (`emailSettings` / `createEmailProvider`): a missing key for the selected provider,
a missing sender, an unknown provider, `console` outside development or a non-https link in production stop the API
before it serves traffic. Only the selected provider's key is checked. The old `RECIPIENT_OTP_DELIVERY_MODE`,
`TRUSTED_CONTACT_OTP_DELIVERY_MODE` and `DEATH_VERIFICATION_NOTICE_DELIVERY_MODE` are gone; remove them from existing
`.env` files.

## 3. Templates and privacy

`src/email/email-templates.ts`: one shared layout (tables + inline styles; no images, scripts, web fonts or tracking
pixels; a plain-text part for every email), eight content functions. Brevo receives them as `htmlContent` and
`textContent`; templates are not stored in Brevo.

| Email           | Subject                                  | Contains                                                                                                                                                                     | Never contains                                                                                             |
| --------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Sign-in code    | Your For After sign-in code              | The 6-digit code as text, its expiry, "ignore if you didn't ask"                                                                                                             | A link, the person's name, what they have access to                                                        |
| Message waiting | A message is waiting for you             | "Hi {Recipient first name}," ("Hello," without one), "Something has been left for you", a link to `APP_BASE_URL/recipient/sign-in`                                           | Sender, title, text, photos, audio, signed URLs, a token, the Recipient's surname or private note          |
| Verify email    | Verify your For After email              | "Hi {first name}," ("Hello," without one), "please verify your email address", a single-use link `APP_BASE_URL/verify-email?token=…`, its 24 h lifetime                      | A password, code, session, account details or any vault content                                            |
| Reset password  | Reset your For After password            | Greeting, "we received a request", a single-use link `APP_BASE_URL/reset-password?token=…`, its 60-minute lifetime, "ignore if you didn't ask"                               | The current or a new password, a code, a session, any vault content                                        |
| Change email    | Verify your new For After email          | Greeting, "you asked to change the email address", "until you do, nothing changes", a single-use link `APP_BASE_URL/settings/verify-email-change?token=…`, its 24 h lifetime | A password, code, session, the old address or any vault content                                            |
| Email changed   | Your For After email address was changed | To the OLD address: greeting, "the email address was just changed and every device was signed out", "contact support if this wasn't you"                                     | Any link or token, the new address, any vault content                                                      |
| Safety notice   | Action needed on your For After account  | Greeting by the account holder's own name, "a report needs your attention", "nothing is released while it is reviewed", a link to `APP_BASE_URL/login`                       | Reporter, their note, the word "death", a confirm-alive link (confirming is a signed-in action in the app) |

Names are HTML-escaped. Links never carry a code or session; only the verify and reset links carry their own single-use token. **Tracking:** For After adds no pixels or tracked
links; keep the provider's open and click tracking **off** (Brevo: Transactional → Settings → Tracking), because these
emails go to grieving people and account holders under review.

**Logs and storage.** The provider logs `email_sent <kind> to s***@… id <provider message id>` or
`email_send_failed … (code: <safe code>, retryable: …)`; never the key, body, code or a full address. Brevo error
messages are discarded; only Brevo's short `code` (or `http_<status>`) is kept. `ReleaseNotification` stores status,
attempt count, the safe error code, the provider message id and timestamps only.

### Recipient release notifications (Step 24.1)

Every assigned Recipient is told once per released Message, and only after the release is real.

- **Timing.** The notification is written in the release transaction (`MessageReleaseService`), after the
  `MessageRelease` row and the Recipient's `RecipientMessageAccessGrant`, so an email never arrives before the access
  that lets the Recipient read it. Drafts, scheduling, rescheduling, unscheduling, media uploads, death reports, the
  safeguard and admin verification send nothing. FIXED_DATE, ON_DEATH and AFTER_DEATH share the one release path:
  ON_DEATH emails go when the activation releases (at verification), AFTER_DEATH ones only when the delay has passed and
  the message releases, not at verification. The frontend can never trigger it.
- **Per Recipient.** One `ReleaseNotification` row per access grant that has an email snapshot, so a message to three
  Recipients makes three rows, three jobs and three emails. Each row has its own job, retries and status: one
  Recipient's failure never delays or blocks another's. A second released message to the same Recipient is a new grant
  and therefore a new email; nothing is suppressed per Recipient.
- **Idempotency.** The key is the access grant: `ReleaseNotification.grantId` is unique, and a grant is unique per
  (release, Recipient), and a release per Message. Job id `release-notification-<rowId>`, provider idempotency key
  `release-notification/<rowId>`, and the worker skips SENT rows. BullMQ retries, a re-run release, the release and
  notification reconcilers, restarts and a second worker all land on the same row (tested end to end).
- **Address.** The grant's email snapshot taken at release (the same address Recipient OTP sign-in checks), never a
  later edit. The greeting uses the Recipient's current first name, read at send time; no name, no invented one.
- **Privacy.** The email holds the greeting, a fixed sentence and the sign-in link only. No title, text, photos, audio,
  signed or storage URLs, sender, death details, surname or private note. The link opens the sign-in page; it carries
  no code, token or session, and the Recipient still signs in by email OTP (`eligible` is unchanged: a released grant
  for that address).
- **No email address.** A mobile-only Recipient still gets a release and a grant (release is never blocked); no
  notification row is written and no email is attempted (there is no `SKIPPED_NO_EMAIL` state). No address is invented.
- **Failures.** A provider failure never touches the release or the grant: the message stays RELEASED and readable.
  Transient errors (timeout, network, 429, 5xx) retry with exponential backoff (`EMAIL_JOB_ATTEMPTS`,
  `EMAIL_JOB_BACKOFF_MS`); permanent ones (invalid address, unverified sender, 4xx) fail at once. Either way the row
  ends FAILED with a safe code, and the job is in the admin failed-jobs view for a retry. The release service has no
  retry logic of its own.
- **Reconciliation.** If the enqueue right after a release is lost, the notification reconciler re-queues PENDING rows
  older than two minutes, only for a live RELEASED message. The worker re-checks the same rule (RELEASED, not deleted,
  grant has an email) before sending, matching Recipient sign-in eligibility.
- **Not sent.** No "your message was released" email to the Customer, no SMS. The access-grant backfill script never
  emails past releases.

## 4. Operations

- **Admin Portal → Queues** shows `email-delivery` next to `message-release` and `death-verification`: counts, failed
  jobs with the job id, attempts, a sanitized reason (`email_send_failed: rate_limit_exceeded`) and "Email <id>"
  (the notification id; never an address or content).
- **Retry** re-runs the job through the normal worker: it re-checks PostgreSQL and sends only if the row is not `SENT`
  (and passes the same idempotency key), so a retry can never release anything.
- **Transient** errors are retried by BullMQ with backoff (the adapter itself never retries); after the last attempt
  the row is `FAILED`. Brevo: HTTP `429` (`rate_limit_exceeded`), any `5xx`, network errors and timeouts.
- **Permanent** errors fail at once: any other Brevo `4xx`, e.g. `unauthorized` (bad key or **unauthorised IP**),
  `invalid_parameter` / `missing_parameter` (unverified sender, malformed address), `insufficient_credits`,
  `duplicate_request`.
- **Redis down:** enqueueing after a release fails softly (logged); the reconciler re-queues `PENDING` rows when Redis
  is back. Nothing is ever marked `SENT` without the provider's acceptance.
- **Several API instances:** one job per row (deterministic job id) and the worker skips `SENT` rows, so a logical
  email is sent once.
- **Useful query:** `SELECT status, count(*) FROM "ReleaseNotification" GROUP BY status;`

**Diagnosing a missing sign-in code.** First check the API log for `recipient_otp_requested … eligible false` (or the
Trusted Contact equivalent). Not eligible means no code is generated or sent, by design; that is a data question, not
a provider fault. Only `eligible true` followed by `email_send_failed` points at the provider configuration.

**Troubleshooting `email_send_failed … (code: unauthorized, retryable: false)`.** Brevo answered `401`: the request
reached Brevo but the key was refused. Seen on 2026-10-05 with an eligible Recipient. Check, in order:

| Cause                                         | How to tell                                                                                                                                         | Fix                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Unrecognised IP** (the cause on 2026-10-05) | Brevo's message says "unrecognised IP address" (visible in the dashboard, or with a read-only `GET https://api.brevo.com/v3/account` using the key) | Add the IP at Security → Authorised IPs, or turn IP blocking off for **development only**. Home/office IPs change, so it can come back |
| **The running API has an old key**            | `.env` was edited or the key regenerated after the API started                                                                                      | Restart the API: `BREVO_API_KEY` is read once at startup                                                                               |
| **A shell variable overrides `.env`**         | PowerShell `Test-Path Env:BREVO_API_KEY` prints `True`                                                                                              | Remove the user/system variable, open a new terminal, restart                                                                          |
| **Wrong key type**                            | The key does not start with `xkeysib-` (an SMTP key starts with `xsmtpsib-`)                                                                        | Create a v3 API key (SMTP & API → API keys)                                                                                            |
| **Change not applied yet**                    | Brevo settings were changed a moment before the request                                                                                             | Wait a minute; request a new code                                                                                                      |

A `401` is permanent (`retryable: false`), so nothing retries it: once fixed, request a **new** code (and retry any
`FAILED` release notification from Admin Portal → Queues). Other permanent codes point elsewhere, e.g.
`invalid_parameter` / `missing_parameter` for an unverified sender or a malformed address.

## 5. Brevo setup (manual)

**Current development setup:**

1. ✅ Create the Brevo account.
2. ✅ Create a **v3 API key** (SMTP & API → API keys; it starts with `xkeysib-`). Put it in the backend `.env` only, as
   `BREVO_API_KEY`.
3. ✅ Verify a sender (Senders, Domains & Dedicated IPs → Senders). A personal address you control is fine for
   development; set it as `EMAIL_FROM_ADDRESS`. No custom domain is needed.
4. ✅ **Authorised IPs:** Brevo refuses API calls from IPs it has not seen (`401 unauthorized`, "unrecognised IP address").
   Either add the machine's IP at **Security → Authorised IPs** (`app.brevo.com/security/authorised_ips`) or turn IP
   blocking off. **2026-10-05:** turned off for development; a read-only account check and a no-send probe of the send
   endpoint then passed authentication. Turn it back on for production (below).
5. Set `EMAIL_PROVIDER=brevo`, `EMAIL_FROM_NAME=For After`, `APP_BASE_URL=http://localhost:3000`; restart the API (the
   workers run in the same process).
6. Transport check, independent of Recipient eligibility (sends one plain email, no code, to `BREVO_LIVE_TEST_TO` or
   the sender itself):

   ```bash
   BREVO_LIVE_TEST=1 npx vitest run src/email/brevo-email-provider.live.spec.ts
   ```

7. Then the app flows: request a sign-in code for an **eligible** fictional Recipient (released message + access grant)
   or Trusted Contact whose email you control; never real Customers. Success looks like
   `recipient_otp_requested … eligible true` followed by `email_sent recipient-otp to h***@… id <…>`; check Brevo →
   Transactional → Logs too. Pending: confirm a Recipient code and a Trusted Contact code arrive in the inbox.

With `EMAIL_PROVIDER=brevo` codes arrive by email only; they are not printed in the API terminal. The frontend
Playwright OTP tests read codes from the console provider's log lines, so run them with `EMAIL_PROVIDER=console`.

**Production (future deployment work):** authenticate a For After domain in Brevo (Senders, Domains & Dedicated IPs →
Domains: add exactly the DKIM / DMARC / Brevo-code records Brevo shows), switch `EMAIL_FROM_ADDRESS` to an address on
it (e.g. `notifications@mail.forafter.com.au`), **turn authorised-IP blocking back on** and add the production egress
IPs, turn tracking off, and keep the key in the secret manager. A personal sender is not suitable for production deliverability.

## 6. Resend (optional, not active)

`ResendEmailProvider` remains as a dormant alternative (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, a sender on a
domain verified in Resend). It is unit-tested and needs no changes to switch back; nothing reads Resend settings while
Brevo is selected. Resend refuses unverified domains (`validation_error`, permanent).

# ✉️ For After — Transactional email (Step 24)

> How For After sends its transactional emails through Microsoft Graph, how it is tested, and the manual steps to go live.
> Emails are **notifications and access only**: they never carry preserved content.

|                         |                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Provider**            | **Microsoft Graph** `sendMail` (selected, 2026-10-21), behind a provider-neutral `EmailProvider`. A Resend adapter remains as an optional, inactive alternative (§6). Brevo was removed on 2026-10-21 (§5) |
| **Emails**              | Recipient sign-in code · Trusted Contact sign-in code · "A message is waiting for you" · account-holder safety notice · Customer email verification · password reset (Phase 04) · change-email link to the new address · "email changed" notice to the old one (Phase 08) · Trusted Contact invitation (Phase 10)                                   |
| **Not sent**            | Marketing, newsletters, SMS (OTP and invitations deferred), message content, photos, audio, signed links                                                                                                                                                                                                                      |
| **Code**                | `src/email/` (providers, templates, module) · `src/release-notifications/` (queue, worker, reconciler)                                                                                                                                                                                                      |
| **Status (2026-10-21)** | Microsoft adapter complete; unit, wiring (API + worker) and load tests pass against **mocked** Microsoft endpoints only. **Live Microsoft verification is pending**: no real token request or email has been sent; tenant permissions, the secret and the sender mailbox are unverified (§7) |

---

## 1. Architecture

```
Recipient / Trusted Contact OTP  ─┐
                                  ├─► EmailOtpDelivery ──────────────┐
Register / resend / forgot pw ────┤
Change email (confirm, notice) ───┼─► AuthTokensService ─────────────┤
Death report → workflow claim ────┼─► EmailDeathNoticeDelivery ──────┤
                                  │                                  ├─► EmailProvider ─► Microsoft Graph
Release transaction ─► ReleaseNotification row (PENDING)             │     (microsoft | resend | console | disabled;
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

Idempotency keys are provider-neutral. Resend receives them as its idempotency option; **Microsoft Graph has no
idempotency key and none is sent**. The app's own guards (skip `SENT` rows, claimed attempts, deterministic job ids)
are the protection: they guarantee one logical email record, not one external delivery (§7).

**A failed email never undoes or blocks anything else.** A release stays `RELEASED` and readable in the portal; an
OTP request still answers `202`; a death case just stays `PENDING_VERIFICATION` until the notice is sent.

## 2. Providers and configuration

| `EMAIL_PROVIDER`                        | Behaviour                                                                                              | Allowed                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `resend` (optional, not active)         | Sends through the Resend SDK                                                                           | Always                                                    |
| `microsoft` (selected)                  | `POST https://graph.microsoft.com/v1.0/users/{mailbox}/sendMail` with an MSAL app-only token, 10 s timeout by default, one attempt (§7) | Always; production requires `microsoft` or `resend` |
| `console`                               | Prints `[DEV ONLY] Email (<kind>) to s***@… \| subject \| plain text` (sign-in codes included)         | Only with `NODE_ENV=development`; startup fails otherwise |
| `disabled` (default outside production) | Nothing is sent; every send fails permanently (`email_disabled`)                                       | Not in production                                         |

Automated tests never call a provider: e2e runs set `EMAIL_PROVIDER=disabled`, and suites that check emails replace the
provider with `test/fake-email.ts` (an in-memory inbox that can simulate outages); `test/microsoft-email-wiring.e2e-spec.ts`
runs the Microsoft provider against a stubbed Graph. The only real-network send,
`npm run email:send-test -- --to <address>`, is a manual command, never part of a test run (§7).

| Variable                                      |       Required        | Notes                                                                                                                   |
| --------------------------------------------- | :-------------------: | ----------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                              |   yes in production   | see above                                                                                                               |
| `RESEND_API_KEY`                              |     with `resend`     | Only read when `EMAIL_PROVIDER=resend`; never required for Microsoft                                                        |
| `EMAIL_FROM_ADDRESS`                          |     with `resend`     | A sender on a domain verified in Resend. Not read by Microsoft (which uses `EMAIL_FROM`)                                 |
| `EMAIL_FROM_NAME`                             |          no           | Default `For After`                                                                                                     |
| `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_SENDER_MAILBOX` / `EMAIL_FROM` | with `microsoft` | §7. Missing values and obvious placeholders stop startup; errors name the variable, never its value |
| `APP_BASE_URL`                                |   unless `disabled`   | App origin for links, no path (`http://localhost:3000`; `https://…` required in production)                             |
| `EMAIL_SEND_TIMEOUT_MS`                       |          no           | Default `10000`                                                                                                         |
| `EMAIL_QUEUE_NAME`                            |          no           | Default `email-delivery`                                                                                                |
| `EMAIL_JOB_ATTEMPTS` / `EMAIL_JOB_BACKOFF_MS` |          no           | Defaults `5` / `30000` (exponential: 30 s, 60 s, 120 s, 240 s)                                                          |
| `EMAIL_RECONCILE_INTERVAL_SECONDS`            |          no           | Default `60`; only rows older than 2 minutes are re-queued                                                              |

All of this is validated at startup (`emailSettings` / `createEmailProvider`): a missing key for the selected provider,
a missing sender, an unknown provider, `console` outside development or a non-https link in production stop the API
before it serves traffic. Only the selected provider's settings are checked; `EMAIL_PROVIDER=brevo` is now rejected. The old `RECIPIENT_OTP_DELIVERY_MODE`,
`TRUSTED_CONTACT_OTP_DELIVERY_MODE` and `DEATH_VERIFICATION_NOTICE_DELIVERY_MODE` are gone; remove them from existing
`.env` files.

## 3. Templates and privacy

`src/email/email-templates.ts`: one shared layout (tables + inline styles; no images, scripts, web fonts or tracking
pixels; a plain-text part for every email), content functions per email. Microsoft Graph receives the **HTML part
only** (its JSON `sendMail` takes one body; the MIME form would carry both parts but always saves a copy to Sent Items,
which this app avoids for sign-in codes). Resend receives both parts. Templates are never stored at the provider.

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
links; keep any provider-side tracking or link rewriting **off** (Exchange Online: no Safe Links rewriting for this mailbox if your tenant applies it to outbound mail), because these
emails go to grieving people and account holders under review.

**Logs and storage.** The Microsoft provider logs `email_accepted <kind> to s***@… status 202 request <Graph request id>`
or `email_send_failed … (code: <safe code>, retryable: …, retry-after: …, request: …)`; never the secret, token, body,
code or a full address. Graph error messages are discarded; only Graph's short error code (or `http_<status>`) is kept.
`ReleaseNotification` stores status, attempt count, the safe error code, the provider message id (for Microsoft: the
Graph request id) and timestamps only. Rows written while Brevo was the provider keep their Brevo message ids and error
codes unchanged; they are plain text and need no Brevo code to read.

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
  Transient errors (timeout, network, 401, 429, 5xx) retry with exponential backoff (`EMAIL_JOB_ATTEMPTS`,
  `EMAIL_JOB_BACKOFF_MS`); permanent ones (403, 404, other 4xx, a rejected app registration) fail at once. Either way the row
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
- **Dead letters + operator alert (Phase 17A):** a notification job that ends in `FAILED` also gets one
  `DeadLetterJob` row (ids + error code; never the address or email body) and one alert to `OPS_ALERT_EMAIL`
  (optional; unset = log line only). The alert goes **directly** through `EmailProvider` (kind `ops-alert`, one
  attempt), never through `email-delivery`: a provider outage gives one `FAILED` alert, logged, and no loop. Retrying
  from Admin → Queues → Dead letters reuses the same `ReleaseNotification` row and idempotency key (`SENT` → no-op).
- **Transient** errors are retried by BullMQ with backoff (the adapter itself never retries); after the last attempt
  the row is `FAILED`. Microsoft: HTTP `401`, `429` (`rate_limit_exceeded`), any `5xx`, network errors, timeouts and
  an unreachable token endpoint (`token_unavailable`). MSAL does not retry token requests itself, so the queue's
  backoff is the only retry layer.
- **Permanent** errors fail at once: `403` (`forbidden_<GraphCode>`), `404` (`mailbox_not_found`), any other `4xx`
  (e.g. `ErrorInvalidRecipients`), and `auth_rejected` (wrong tenant, client id or secret, or no admin consent).
- **Redis down:** enqueueing after a release fails softly (logged); the reconciler re-queues `PENDING` rows when Redis
  is back. Nothing is ever marked `SENT` without the provider's acceptance.
- **Several worker instances:** one job per row (deterministic job id) and the worker skips `SENT` rows, so a logical
  email is sent once. The `email-delivery` worker and its reconciler run in the worker process (`npm run worker:dev`,
  Phase 17B); OTP and safety-notice emails are still sent directly by the API.
- **Useful query:** `SELECT status, count(*) FROM "ReleaseNotification" GROUP BY status;`

**Diagnosing a missing sign-in code.** First check the API log for `recipient_otp_requested … eligible false` (or the
Trusted Contact equivalent). Not eligible means no code is generated or sent, by design; that is a data question, not
a provider fault. Only `eligible true` followed by `email_send_failed` points at the provider configuration.

**Troubleshooting Microsoft Graph failures** (codes from the `email_send_failed` log line):

| Code | Likely cause | Check / fix |
| --- | --- | --- |
| `auth_rejected` | Wrong `MS_TENANT_ID` / `MS_CLIENT_ID`, an expired or wrong `MS_CLIENT_SECRET` (the secret **value**, not its id) | Entra ID → App registrations → the app; create a new secret if needed, update `.env`, restart the API **and** the worker |
| `forbidden_ErrorAccessDenied` (message "Access is denied. Check credentials and try again.") | The app has no **effective** Mail.Send right on that mailbox. With Exchange RBAC for Applications (no Entra role needed; the token's `roles` may be empty): the Exchange service principal points at the wrong object, the mailbox id in `MS_SENDER_MAILBOX` is not the mailbox's Entra object id, or a new role assignment has not propagated yet (30 min to 2 h) | `Get-ServicePrincipal` → `AppId` = `MS_CLIENT_ID` **and** `ObjectId` = the Enterprise Application object id (the token's `oid`); `Get-Mailbox <upn> \| fl ExternalDirectoryObjectId,ExchangeGuid` → `MS_SENDER_MAILBOX` must be the `ExternalDirectoryObjectId` (not `ExchangeGuid`/`Guid`); `Test-ServicePrincipalAuthorization -Identity <AppId> -Resource <mailbox>`; then wait for propagation. Without RBAC: Entra Mail.Send + admin consent, `Test-ApplicationAccessPolicy` |
| `forbidden_ErrorSendAsDenied` | `EMAIL_FROM` differs from `MS_SENDER_MAILBOX` and the mailbox has no Send As right on it | Use the mailbox address as `EMAIL_FROM`, or grant Send As |
| `mailbox_not_found` | `MS_SENDER_MAILBOX` is not a mailbox (e.g. an application object id) or the user has no Exchange Online licence | Use the mailbox UPN or its user object id |
| `rate_limit_exceeded` / `ServiceUnavailable` | Graph or Exchange throttling | Retried automatically; check volume against mailbox sending limits |
| `token_unavailable` / `timeout` / `network_error` | Entra ID or Graph unreachable, or slower than `EMAIL_SEND_TIMEOUT_MS` | Retried automatically. A timeout is **ambiguous**: Exchange may still have accepted the message (§7) |

Each `email_send_failed` line also carries Graph's **sanitized** message (addresses and tokens redacted, 200 chars), `request`, `client-request` and `date`: quote those three to Microsoft support. Since 2026-10-21 the client request id is sent by the app on every Graph call.

Permanent failures are not retried: once fixed, request a **new** sign-in code (and retry any `FAILED` release
notification from Admin Portal → Queues).

## 5. Brevo (removed 2026-10-21)

Development used Brevo from 2026-10-05 until 2026-10-21. The adapter, its tests, its live test and the
`BREVO_API_KEY` setting were removed when Microsoft Graph became the provider; `EMAIL_PROVIDER=brevo` now stops
startup. Delivery history is untouched: `ReleaseNotification`, dead-letter and audit rows written while Brevo was active
keep their provider message ids and error codes as plain text. **Manual (outside this repository):** revoke the old
Brevo API key in the Brevo dashboard if it is no longer needed.

## 6. Resend (optional, not active)

`ResendEmailProvider` remains as a dormant alternative (`EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, a sender on a
domain verified in Resend). It is unit-tested and needs no changes to switch to; nothing reads Resend settings while
Microsoft is selected. Resend refuses unverified domains (`validation_error`, permanent).

## 7. Microsoft Graph (selected)

`MicrosoftGraphEmailProvider` (`src/email/microsoft-email-provider.ts`, selected by `emailProviderFor` in
`src/email/email-provider.factory.ts`) sends as one Exchange Online mailbox through Microsoft Graph.

| | |
| --- | --- |
| **Auth** | `@azure/msal-node` `ConfidentialClientApplication.acquireTokenByClientCredential`, scope `https://graph.microsoft.com/.default`, authority `https://login.microsoftonline.com/{MS_TENANT_ID}`. MSAL keeps the token in memory and renews it before expiry (verified with the real library against a mocked network in the unit tests). MSAL's own logging is off |
| **Send** | `POST https://graph.microsoft.com/v1.0/users/{MS_SENDER_MAILBOX}/sendMail`, `saveToSentItems: false` (no copies of sign-in codes or notices in Sent Items), From = `EMAIL_FROM` with `EMAIL_FROM_NAME` |
| **Body** | Graph's JSON message takes one body, so the template's **HTML** part is sent; the plain-text part is not (a MIME send would carry both) |
| **Result** | Any 2xx (Graph: **202 Accepted**) means Exchange accepted the message for delivery, **not** that it was delivered or reached an inbox. The Graph `request-id` is stored as `providerMessageId` for support |
| **API and worker** | Both processes build the provider from the same backend `.env` (`ConfigModule` in `AppModule` and `WorkerModule`); there is no separate worker env file. Restart **both** after changing `MS_*` values |
| **Templates, queues, privacy** | Unchanged: same templates, `email-delivery` queue, retries, dead letters and alerts; logs carry the kind, a masked address, status and request id only, never the secret, token, code or body |

Error mapping (the shared `EmailSendError` contract; the caller's retry policy applies):

| Graph / token outcome | `code` | Retryable |
| --- | --- | :---: |
| Timeout (token + send share `EMAIL_SEND_TIMEOUT_MS`) | `timeout` | ✅ |
| Network failure | `network_error` | ✅ |
| 429 | `rate_limit_exceeded` (Retry-After logged) | ✅ |
| 5xx | Graph error code or `http_5xx` (Retry-After logged) | ✅ |
| 401 | `unauthorized` (an expired or revoked token; MSAL renews it) | ✅ |
| 403 | `forbidden_<GraphCode>` (Mail.Send not granted, an application access policy, no Send As right) | ❌ |
| 404 | `mailbox_not_found` | ❌ |
| other 4xx | Graph error code or `http_4xx` | ❌ |
| Token: `invalid_client`, `unauthorized_client`, `invalid_request`, `invalid_scope`, `invalid_grant` | `auth_rejected` | ❌ |
| Token: anything else (Entra ID unreachable, throttled) | `token_unavailable` | ✅ |

**Retry-After**: logged, not scheduled. Queued emails retry on the queue's exponential backoff (30 s, 60 s, 120 s,
240 s), which is normally longer than Graph's Retry-After; OTP and other inline sends fail to the caller as before.
If longer Retry-After values show up in practice, add a BullMQ custom backoff that takes the larger of the two.

**Not exactly-once.** Graph `sendMail` has no idempotency key (the message's `idempotencyKey` is not sent). A send
that Exchange accepted but whose response was lost (timeout, worker crash) can be sent again by the retry: one
`ReleaseNotification` row, possibly two emails. See the Phase 24 load report for this window.

**Timeouts are ambiguous.** `EMAIL_SEND_TIMEOUT_MS` (default 10 s) covers the token request and the `sendMail` call
together. When it fires, the app cannot tell whether Exchange accepted the message: it records a retryable `timeout`,
and the queue's retry may send a second copy. For sign-in codes (not queued) the person simply asks for a new code.

**401 and token renewal.** MSAL caches the app-only token in memory per process and fetches a new one about five
minutes before it expires. A `401` from Graph is retried by the queue; if the cached token was revoked early, retries
keep failing until it expires (≤ ~1 h) or the worker restarts.

### Local test (one email, explicit recipient)

```bash
# .env: EMAIL_PROVIDER=microsoft plus the five values above (real ones, from the app registration)
npm run build
npm run email:send-test -- --to you@your-domain.example
```

`src/email/send-test-email.ts` sends **one** `provider-test` email (no account, code or link) to the address given,
through whatever `EMAIL_PROVIDER` selects. It refuses `NODE_ENV=production`, a missing or invalid `--to` and
`EMAIL_PROVIDER=disabled`, and prints only the outcome and request id. There is no HTTP route for it. Nothing in the
test suite or startup sends mail. The frontend Playwright OTP tests read codes from the console provider's log lines,
so run those against an API with `EMAIL_PROVIDER=console`.

### Development setup (manual, in Entra ID and Exchange Online)

1. Register an app (single tenant). Note the **tenant id** and **application (client) id**.
2. API permissions → Microsoft Graph → **Application** permission **Mail.Send** → grant admin consent.
3. Limit it to the sender mailbox: an Exchange Online **application access policy** (or RBAC for Applications)
   scoped to a mail-enabled group holding only that mailbox. Without this, Mail.Send can send as **any** mailbox in the
   tenant.
4. Certificates & secrets → a client secret with a short expiry, for development only. Put it in `.env`
   (`MS_CLIENT_SECRET`), never in the repository, frontend, logs or tickets.
5. `EMAIL_FROM` = the mailbox itself, or another address the mailbox has **Send As** rights on (else 403
   `ErrorSendAsDenied`).

### Production readiness (separate, not done)

- **No client secret in production.** Use a **certificate credential** (MSAL `clientCertificate`: thumbprint + private
  key from the secret manager) or a **federated credential** (workload identity federation; MSAL `clientAssertion`
  callback) so no shared secret exists. The provider warns at startup when `NODE_ENV=production` uses a secret; the
  certificate/federated wiring is a small change in `createMicrosoftEmailProvider` and is not implemented yet.
- Application access policy or RBAC scoping (step 3) verified with `Test-ApplicationAccessPolicy`.
- SPF/DKIM/DMARC for the sending domain in Exchange Online; sending limits of the mailbox reviewed against expected
  volume (Exchange per-mailbox recipient/rate limits apply).
- Credential rotation and expiry alerting; Graph throttling observed in staging before launch.
- A real send verified in staging through `npm run email:send-test` with an explicit recipient.

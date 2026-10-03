# ✉️ For After — Transactional email (Step 24)

> How For After sends its four transactional emails through Resend, how it is tested, and the manual steps to go live.
> Emails are **notifications and access only**: they never carry preserved content.

|                         |                                                                                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Provider**            | [Resend](https://resend.com) (production), behind a provider-neutral `EmailProvider`                                                                                     |
| **Emails**              | Recipient sign-in code · Trusted Contact sign-in code · "A message is waiting for you" · account-holder safety notice                                                    |
| **Not sent**            | Marketing, newsletters, invitations, SMS, message content, photos, audio, signed links                                                                                   |
| **Code**                | `src/email/` (provider, templates, module) · `src/release-notifications/` (queue, worker, reconciler)                                                                    |
| **Status (2026-10-03)** | Code complete and tested with a fake provider. **The Resend account has no domain yet**: real delivery from a custom sender is blocked until the domain is verified (§5) |

---

## 1. Architecture

```
Recipient / Trusted Contact OTP  ─┐
                                  ├─► EmailOtpDelivery ──────────────┐
Death report → workflow claim ────┼─► EmailDeathNoticeDelivery ──────┤
                                  │                                  ├─► EmailProvider ─► Resend
Release transaction ─► ReleaseNotification row (PENDING)             │     (resend | console | disabled;
      └─► email-delivery queue ─► ReleaseNotificationProcessor ──────┘      tests: FakeEmailProvider)
```

Business code depends on `EmailProvider` (`send(message) → { providerMessageId }`, throws `EmailSendError { code,
retryable }`), never on Resend. Controllers never send email.

| Email                                             | Trigger                                                                                                         | Durability, retries, idempotency                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sign-in code** (Recipient, Trusted Contact)     | `POST /…-auth/request-otp`, only when the email is eligible                                                     | Sent directly, not queued: a job would keep the plaintext code in Redis job data and failed-job history, where only its HMAC may live, and a retry after the 10-minute expiry is useless (the person asks for a new code). Still fire-and-forget, so response timing never reveals eligibility. A failed send is logged (`…_otp_delivery_failed`), never shown |
| **Safety notice** to the account holder           | A Trusted Contact's death report (`afterReport`) and the death-verification reconciler                          | Existing workflow: an attempt is claimed in PostgreSQL only while the case is `PENDING_VERIFICATION` (a cancelled case is never emailed); the safeguard starts only after a successful send; failures are retried every reconcile interval. Resend idempotency key `death-safety/<caseId>`                                                                     |
| **"A message is waiting for you"** to a Recipient | A real release (`MessageReleaseService`), inside the same transaction as the `MessageRelease` and access grants | `ReleaseNotification` row per grant that has an email (unique `grantId`), job on the `email-delivery` queue (job id `release-notification-<id>`, payload = the row id only), worker re-checks PostgreSQL, Resend idempotency key `release-notification/<id>`, exponential backoff, reconciler for missed enqueues                                              |

**A failed email never undoes or blocks anything else.** A release stays `RELEASED` and readable in the portal; an
OTP request still answers `202`; a death case just stays `PENDING_VERIFICATION` until the notice is sent.

## 2. Providers and configuration

| `EMAIL_PROVIDER`                        | Behaviour                                                                                      | Allowed                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `resend`                                | Sends through the Resend SDK (10 s timeout by default)                                         | Always; **required** with `NODE_ENV=production`           |
| `console`                               | Prints `[DEV ONLY] Email (<kind>) to s***@… \| subject \| plain text` (sign-in codes included) | Only with `NODE_ENV=development`; startup fails otherwise |
| `disabled` (default outside production) | Nothing is sent; every send fails permanently (`email_disabled`)                               | Not in production                                         |

Automated tests never call Resend: e2e runs set `EMAIL_PROVIDER=disabled`, and suites that check emails replace the
provider with `test/fake-email.ts` (an in-memory inbox that can simulate outages).

| Variable                                      |     Required      | Notes                                                                                        |
| --------------------------------------------- | :---------------: | -------------------------------------------------------------------------------------------- |
| `EMAIL_PROVIDER`                              | yes in production | see above                                                                                    |
| `RESEND_API_KEY`                              |   with `resend`   | **Server-side only.** Never in the frontend, a `NEXT_PUBLIC_*` variable, a response or a log |
| `EMAIL_FROM_ADDRESS`                          |   with `resend`   | A sender on a domain **verified in Resend** (e.g. `notifications@<verified domain>`)         |
| `EMAIL_FROM_NAME`                             |        no         | Default `For After`                                                                          |
| `APP_BASE_URL`                                | unless `disabled` | App origin for links, no path (`http://localhost:3000`; `https://…` required in production)  |
| `EMAIL_SEND_TIMEOUT_MS`                       |        no         | Default `10000`                                                                              |
| `EMAIL_QUEUE_NAME`                            |        no         | Default `email-delivery`                                                                     |
| `EMAIL_JOB_ATTEMPTS` / `EMAIL_JOB_BACKOFF_MS` |        no         | Defaults `5` / `30000` (exponential: 30 s, 60 s, 120 s, 240 s)                               |
| `EMAIL_RECONCILE_INTERVAL_SECONDS`            |        no         | Default `60`; only rows older than 2 minutes are re-queued                                   |

All of this is validated at startup (`emailSettings` / `createEmailProvider`): a missing key or sender, an unknown
provider, `console` outside development or a non-https link in production stop the API before it serves traffic. The
old `RECIPIENT_OTP_DELIVERY_MODE`, `TRUSTED_CONTACT_OTP_DELIVERY_MODE` and `DEATH_VERIFICATION_NOTICE_DELIVERY_MODE`
are gone; remove them from existing `.env` files.

## 3. Templates and privacy

`src/email/email-templates.ts`: one shared layout (tables + inline styles; no images, scripts, web fonts or tracking
pixels; a plain-text part for every email), four content functions.

| Email           | Subject                                 | Contains                                                                                                                                               | Never contains                                                                                             |
| --------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Sign-in code    | Your For After sign-in code             | The 6-digit code as text, its expiry, "ignore if you didn't ask"                                                                                       | A link, the person's name, what they have access to                                                        |
| Message waiting | A message is waiting for you            | "Something has been left for you", a link to `APP_BASE_URL/recipient/sign-in`                                                                          | Sender, title, text, photos, audio, signed URLs, a token                                                   |
| Safety notice   | Action needed on your For After account | Greeting by the account holder's own name, "a report needs your attention", "nothing is released while it is reviewed", a link to `APP_BASE_URL/login` | Reporter, their note, the word "death", a confirm-alive link (confirming is a signed-in action in the app) |

Names are HTML-escaped. Links never carry a code, token or session. **Tracking:** For After adds no pixels or tracked
links; keep Resend's open and click tracking **off** for the sending domain (it is a per-domain setting in the
dashboard), because these emails go to grieving people and account holders under review.

**Logs and storage.** The Resend provider logs `email_sent <kind> to s***@… id <resend id>` or
`email_send_failed … (code: <resend error name>, retryable: …)`; never the key, body, code or a full address.
`ReleaseNotification` stores status, attempt count, the safe error name, the Resend message id and timestamps only.
Outside `NODE_ENV=production` the Resend SDK itself also prints `[Resend API Error]` with the error name, message and
API path (no key, body or code); it is silent in production.

## 4. Operations

- **Admin Portal → Queues** shows `email-delivery` next to `message-release` and `death-verification`: counts, failed
  jobs with the job id, attempts, a sanitized reason (`email_send_failed: rate_limit_exceeded`) and "Email <id>"
  (the notification id; never an address or content).
- **Retry** re-runs the job through the normal worker: it re-checks PostgreSQL and sends only if the row is not `SENT`
  (and Resend dedupes by idempotency key), so a retry can never send twice or release anything.
- **Transient** Resend errors (`rate_limit_exceeded`, `daily_quota_exceeded`, `application_error`,
  `internal_server_error`, network errors, timeouts) are retried with backoff; after the last attempt the row is
  `FAILED`. **Permanent** errors (`validation_error`, `invalid_from_address`, `invalid_api_key`, …) fail at once.
- **Redis down:** enqueueing after a release fails softly (logged); the reconciler re-queues `PENDING` rows when Redis
  is back. Nothing is ever marked `SENT` without the provider's acceptance.
- **Several API instances:** one job per row (deterministic job id), the worker skips `SENT` rows, and Resend dedupes
  by idempotency key, so a logical email is sent once.
- **Useful query:** `SELECT status, count(*) FROM "ReleaseNotification" GROUP BY status;`

## 5. Going live with Resend (manual)

1. ✅ Create the Resend account (done).
2. Create an API key (**Sending access** is enough for the API; keep **Full access** keys out of servers). Put it in the
   backend environment only, as `RESEND_API_KEY`.
3. In Resend → **Domains**, add the sending domain (e.g. a subdomain such as `mail.forafter.com.au`, so the root
   domain's mail setup is untouched). Choose the region closest to the API.
4. Add **exactly the DNS records Resend shows** for that domain (SPF/MX and DKIM records, plus DMARC if you choose) at
   the DNS host. Do not copy values from anywhere else: they are generated per domain.
5. Wait until Resend shows the domain as **Verified**.
6. In the domain settings, turn **open tracking and click tracking off**.
7. Set `EMAIL_FROM_ADDRESS` to an address on that domain (e.g. `notifications@mail.forafter.com.au`),
   `EMAIL_FROM_NAME=For After`, `EMAIL_PROVIDER=resend` and `APP_BASE_URL` to the app origin.
8. Restart the API (the workers run in the same process).
9. Send a test: request a sign-in code for a Recipient or Trusted Contact address you control, or use Resend's test
   inbox `delivered@resend.dev` from a script; never real Customers.
10. Check the API log for `email_sent`, the Resend dashboard (**Emails**) for delivery, and Admin Portal → Queues for
    failures.

Until step 5 is done, sends from an unverified domain are refused by Resend (`validation_error`, permanent): OTP
emails silently fail (the request still answers `202`), safety notices are retried by the reconciler, and
release notifications end `FAILED` (retry them from the Admin Portal once the domain is verified). For local work
before then, use `EMAIL_PROVIDER=console`.

# ⏱️ For After — Message Release Execution (Step 12)

> When a scheduled `FIXED_DATE` message reaches its `scheduledFor` time, the backend moves it from `SCHEDULED` to
> `RELEASED`, using PostgreSQL as the source of truth and BullMQ only as a reminder.

| | |
|---|---|
| **Status** | ✅ Built in Step 12 · access grants added in Step 13 · death triggers added in Step 15 |
| **Executes** | `FIXED_DATE` at `scheduledFor`; `ON_DEATH` / `AFTER_DEATH` only via an activation of a **VERIFIED** death case |
| **Related** | [Scheduling](scheduling.md) · [Recipient Portal](recipient-portal.md) · [Death verification](death-verification.md) |

> ⚠️ **Release is not delivery.** `RELEASED` means the message reached its authorised release state in the backend. It
> does **not** mean an email or SMS was sent, a recipient viewed it, or media was downloaded. No email, SMS or push exists yet.

> ℹ️ **Step 13:** the same release transaction writes one `RecipientMessageAccessGrant` per live assigned Recipient,
> with their email/mobile snapshotted. The Recipient Portal authorizes only from these grants ([recipient-portal.md](recipient-portal.md)).
>
> ℹ️ **Step 15:** death reports still release nothing. After an admin **verifies** a death, each `ON_DEATH` /
> `AFTER_DEATH` Message gets a `DeathTriggeredMessageActivation` with a `dueAt`, and is released through this same
> queue, service and transaction ([death-verification.md](death-verification.md) §6).

## 🧭 Contents

1. [Source of truth](#1-source-of-truth)
2. [What executes](#2-what-executes)
3. [Components](#3-components)
4. [Configuration](#4-configuration)
5. [Queue jobs](#5-queue-jobs)
6. [Schedule API integration](#6-schedule-api-integration)
7. [Reconciliation](#7-reconciliation)
8. [Worker decision](#8-worker-decision)
9. [Idempotency and crash safety](#9-idempotency-and-crash-safety)
10. [Failures](#10-failures)
11. [After release](#11-after-release)
12. [Data model](#12-data-model)
13. [Testing](#13-testing)
14. [Manual test (Postman)](#14-manual-test-postman)
15. [Manual Redis recovery test](#15-manual-redis-recovery-test-development)
16. [Not in Step 12](#16-not-in-step-12)

---

## 1. Source of truth

```text
PostgreSQL MessageSchedule  = authoritative, durable (years ahead is fine)
Redis / BullMQ job          = temporary execution aid for the next 24 h
```

Redis can be flushed, restarted or down: no schedule is lost, and the reconciler rebuilds the jobs from PostgreSQL. A
job is only a reminder to check; the worker always re-reads PostgreSQL and never releases because a job exists.

---

## 2. What executes

| Trigger | Behaviour |
|---|---|
| `FIXED_DATE` | ✅ Executed at `scheduledFor` (UTC instant), unchanged since Step 12 |
| `ON_DEATH` | ✅ Step 15: executed at the activation `dueAt` = `verifiedAt`, only while the case is `VERIFIED` |
| `AFTER_DEATH` | ✅ Step 15: executed at the activation `dueAt` = `verifiedDeathAt + afterDeathDays`, only while the case is `VERIFIED` |
| Others | ❌ Not accepted by the API (Step 6); never executed |

The worker never invents a death: without a `DeathTriggeredMessageActivation` linked to a `VERIFIED` case, an
`ON_DEATH`/`AFTER_DEATH` job is **stale** and does nothing. `MessageSchedule.scheduledFor` stays `FIXED_DATE`-only.

---

## 3. Components

`src/message-release/`:

| Piece | Responsibility |
|---|---|
| `MessageReleaseService` | The only place that releases. Locks the message row, re-reads PostgreSQL, releases atomically or returns why not |
| `MessageReleaseQueue` | Owns the BullMQ queue: deterministic job ids, delay, lookahead, retries; `sync` after schedule changes, `ensure` for the reconciler |
| `MessageReleaseProcessor` | BullMQ worker: calls the service, logs the outcome, re-delays early jobs, rethrows errors for retry |
| `MessageReleaseReconciler` | At startup and every 60 s: queues every due-soon `FIXED_DATE` schedule that lacks a healthy job |

No controller: there is **no release endpoint** and no development trigger endpoint. The worker runs inside the API process.

---

## 4. Configuration

| Variable | Default | Meaning |
|---|:--:|---|
| `QUEUE_REDIS_URL` | empty → `REDIS_URL` | Redis for BullMQ, if it should be separate from sessions |
| `RELEASE_QUEUE_NAME` | `message-release` | Stable queue name (tests use their own) |
| `RELEASE_QUEUE_LOOKAHEAD_SECONDS` | `86400` | Only releases due within this window are put in Redis |
| `RELEASE_RECONCILE_INTERVAL_SECONDS` | `60` | Reconciliation interval |
| `RELEASE_JOB_ATTEMPTS` | `5` | BullMQ attempts per job |
| `RELEASE_JOB_BACKOFF_MS` | `5000` | Exponential backoff base: 5 s, 10 s, 20 s, 40 s |

Invalid numbers stop startup. Redis credentials are never logged (errors log a code only).

**Redis clients.** Sessions and OTP use the `redis` package (`RedisService`). BullMQ uses its own ioredis connections
created from the URL; the session client is not shared. Both can point at the same local Redis in development. The
producer uses `enableOfflineQueue: false` plus a 5 s timeout so a Redis outage never hangs an API request.

---

## 5. Queue jobs

| Aspect | Rule |
|---|---|
| **Job id** | `message-release-<messageId>` (BullMQ rejects custom ids with a single `:`) |
| **Payload** | `{ "messageId": "<uuid>" }` only. Never text, titles, recipient emails/mobiles, media URLs, storage keys or Trusted Contact data |
| **Delay** | `scheduledFor − now`, or `0` if due or overdue. Beyond the lookahead nothing is queued |
| **Retries** | 5 attempts, exponential backoff 5 s base |
| **Cleanup** | Completed jobs kept 24 h (max 1000), failed jobs 7 days (max 1000) |
| **Timers** | Never `setTimeout` for a release; the reconciliation timer only re-scans PostgreSQL |

---

## 6. Schedule API integration

The PostgreSQL change always commits first; the queue is synced afterwards, best-effort.

| Change | Queue effect |
|---|---|
| `POST` `FIXED_DATE` | job added (if within lookahead) |
| `POST` `ON_DEATH` / `AFTER_DEATH` | nothing queued |
| `PATCH` new `FIXED_DATE` time | old job removed, new one added (if within lookahead) |
| `PATCH` `FIXED_DATE` → `ON_DEATH` / `AFTER_DEATH` | job removed |
| `PATCH` `ON_DEATH` / `AFTER_DEATH` → `FIXED_DATE` | job added (if within lookahead) |
| `DELETE` (unschedule, → `DRAFT`) | job removed |
| Trusted Contact death report (Step 14) | **nothing** (no schedule is touched) |
| Admin verifies a death (Step 15) | activation rows created; one job per death-trigger Message due within the lookahead |

If Redis fails after the commit, the API still returns success: the schedule is saved, a `release_queue_sync_failed`
warning is logged, and the reconciler repairs the queue within one interval. A leftover job for an unscheduled or
changed message is harmless (see stale jobs).

Schedule `PATCH` runs in a transaction that first locks the message row (like unschedule and release), so a release can
never execute on the old time while a reschedule commits.

---

## 7. Reconciliation

Every 60 s and once at startup, per instance, for schedules matching:

```text
MessageSchedule.triggerType = FIXED_DATE
MessageSchedule.scheduledFor <= now + lookahead
Message.status = SCHEDULED and Message.deletedAt IS NULL
```

- Keep a job that is delayed/waiting/active and will fire no later than `scheduledFor`; otherwise (missing, completed,
  failed, or scheduled too late) replace it. Overdue schedules run immediately.
- Running on several instances at once is safe: job ids are deterministic and the worker decides from PostgreSQL. No
  leader election.
- One failing job does not stop the rest; a database error is logged and retried next tick.

**Recovery example:** PostgreSQL has 10 scheduled messages, Redis is empty → the app starts → the reconciler rebuilds
the jobs due within 24 h; the rest are queued as they come within the window.

---

## 8. Worker decision

Always from PostgreSQL, inside one transaction:

1. `SELECT … FROM "Message" WHERE id = $1 AND "deletedAt" IS NULL FOR UPDATE` (row lock, no write).
2. Not found / deleted → **stale**. `RELEASED` → **already released**. Any other non-`SCHEDULED` status → **stale**.
3. Read the schedule, the existing release and the live recipient count.
4. Work out `dueAt` (`releaseDueAt`): `FIXED_DATE` → `scheduledFor`; `ON_DEATH`/`AFTER_DEATH` → the activation `dueAt`,
   only if the activation's trigger matches, its case is `VERIFIED` and (AFTER_DEATH) `afterDeathDays` is set. No
   schedule, no due time, or any other trigger → **stale**.
5. `dueAt > now` (UTC, no tolerance) → **not due**: moved back to delayed for the stored time (no retry used).
6. A `MessageRelease` already exists → **already released**.
7. No live assigned recipient → **business block**: not released, stays `SCHEDULED`.
8. Otherwise create `MessageRelease { triggerType, scheduledFor: dueAt, releasedAt: now }`, the access grants, and set
   `status = RELEASED`, in the same transaction.

Composition is not re-checked: Step 8 validated it before scheduling and a `SCHEDULED` message cannot change.

| Outcome | Log category | Job |
|---|---|---|
| released | `release_success` | completed |
| already released | `release_already_completed` | completed |
| stale | `release_stale_job` | completed, no retry |
| not due | `release_not_due` | re-delayed |
| business block | `release_business_block` | completed; reconciler re-checks each interval |
| database error | `release_retryable_failure` | retried with backoff |
| retries exhausted | `release_retries_exhausted` | failed; reconciler re-queues |
| reconciler | `reconciliation_enqueued`, `reconciliation_error` | |

Logs contain message ids, job ids, attempt numbers, trigger type, `scheduledFor` and the category only. Never message
text, titles, recipient data, URLs, storage keys, cookies or credentials.

---

## 9. Idempotency and crash safety

- `MessageRelease.messageId` is `UNIQUE`: one release per message, whatever the queue does.
- The row lock serialises concurrent workers, retries, unschedule and schedule PATCH on the same message.
- Crash after commit but before BullMQ acknowledges: the retry sees `RELEASED` and does nothing.
- Status change and release row are one transaction: never one without the other.
- A unique violation (theoretical race) is reported as already released.

---

## 10. Failures

| Failure | What happens |
|---|---|
| **Redis down** | Scheduling still saves to PostgreSQL; queue sync fails fast and is logged; jobs are rebuilt when Redis is back. Releases due during the outage run as soon as the reconciler can queue them |
| **PostgreSQL down** | The worker cannot read state, so it throws and BullMQ retries; nothing is ever released from Redis data alone |
| **Retries exhausted** | The message stays `SCHEDULED` (never `CANCELLED` or `FAILED`); the reconciler queues it again next interval |

---

## 11. After release

- `GET /messages/:id` shows `status: "RELEASED"`. No new response fields, no queue details.
- The `MessageSchedule` row is kept for history; `MessageRelease` records what actually ran.
- `RecipientMessageAccessGrant` rows (one per live assigned Recipient) exist from the same commit. A retry never
  duplicates them (`already_released` before any write; unique key + `skipDuplicates`). The worker logs
  `recipient_release_grants_created ... count N`. Pre-Step 13 releases can be backfilled with
  `npm run backfill:access-grants` (dry run by default).
- The message is read-only: message PATCH/DELETE, media upload/complete/delete, schedule POST/PATCH/DELETE → `409`.
  `GET /schedule` still returns `200` (read-only history).
- No client can set `status`, `releasedAt`, `release`, `releaseId` or job fields (`400` as unknown fields).

---

## 12. Data model

```prisma
model MessageRelease {
  id           String             @id @default(uuid()) @db.Uuid
  messageId    String             @unique @db.Uuid
  message      Message            @relation(fields: [messageId], references: [id], onDelete: Cascade)
  triggerType  ReleaseTriggerType
  scheduledFor DateTime?
  releasedAt   DateTime
  createdAt    DateTime           @default(now())
  updatedAt    DateTime           @updatedAt
}
```

No content copy, recipient data or URLs. Migration `add_message_release_execution` (new table only). Recipient contact
snapshots live in `RecipientMessageAccessGrant` (Step 13). Delivery tables (`Delivery`, email/SMS records, views,
receipts) are deliberately not created yet.

---

## 13. Testing

- **Unit:** `src/message-release/*.spec.ts` (service with a mocked transaction, queue with a mocked BullMQ, processor,
  reconciler) and the schedule-service sync tests in `src/message-schedules/message-schedules.service.spec.ts`.
- **E2E:** `test/message-release.e2e-spec.ts` runs the real app, PostgreSQL, local Redis and a real BullMQ worker on a
  queue unique to the run (short future `FIXED_DATE`s, stale jobs, reschedule, death triggers, recovery, duplicates,
  read-only). `test/trusted-contact-portal.e2e-spec.ts` asserts that death reports release nothing.
- All e2e runs use `RELEASE_QUEUE_NAME=test-message-release` (`vitest.config.e2e.ts`) so test jobs never land in the
  dev server's queue.

> ℹ️ Every app instance, including e2e test apps, reconciles the database it points at. Due `FIXED_DATE` messages in the
> dev database are released by whichever instance sees them first; that is intended.

---

## 14. Manual test (Postman)

Base URL `http://localhost:4000/api/v1`. Postman keeps the session cookie. The FOR-AFTER collection automates this in
folder `11-Message-Release`.

1. Start PostgreSQL and Redis (`docker start for-after-redis`), then restart NestJS (`npm run start:dev`). The log shows no queue errors.
2. `POST /auth/login` as your test Customer.
3. `GET /recipients` (or `POST /recipients` `{"firstName":"Sofia"}`); keep `recipientId`.
4. `POST /messages`:
   `{"title":"Timed Release Test","contentType":"TEXT","textContent":"Fictional test message.","recipientIds":["{{recipientId}}"]}`
   → 201, keep `messageId`.
5. Make a time 2–3 minutes ahead **with a zone**, e.g.:
   - PowerShell: `(Get-Date).ToUniversalTime().AddMinutes(3).ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")`
   - local offset: `(Get-Date).AddMinutes(3).ToString("yyyy-MM-dd'T'HH:mm:sszzz")` (e.g. `…+08:00`)
   - Postman pre-request: `pm.environment.set("releaseAt", new Date(Date.now() + 3 * 60000).toISOString());`
6. `POST /messages/{{messageId}}/schedule` `{"triggerType":"FIXED_DATE","scheduledFor":"{{releaseAt}}"}` → 201.
7. `GET /messages/{{messageId}}` → `"status": "SCHEDULED"`.
8. Wait until the time passes. The server log shows `release_success message <id> …`.
9. `GET /messages/{{messageId}}` → `"status": "RELEASED"`. `GET …/schedule` still returns the schedule.
10. Database: `SELECT * FROM "MessageRelease" WHERE "messageId" = '<messageId>';` → exactly one row, `triggerType = FIXED_DATE`.
11. Wait a minute or two (a reconciliation pass) and query again → still one row.
12. Read-only: `PATCH /messages/{{messageId}}` → 409; `DELETE /messages/{{messageId}}/schedule` → 409.
13. Second message: schedule it 3 minutes ahead, then `DELETE …/schedule` → 204 (`DRAFT`). After the time: still `DRAFT`, no release row.
14. Third message: `{"triggerType":"ON_DEATH"}` → 201; stays `SCHEDULED` indefinitely, no release row.
15. Fourth message: `{"triggerType":"AFTER_DEATH","afterDeathDays":30}` → 201; stays `SCHEDULED`.

---

## 15. Manual Redis recovery test (development)

> ⚠️ **Do not `FLUSHALL`/`FLUSHDB`:** sessions and OTP challenges live in the same Redis, so flushing logs everyone out.
> Remove only the one test job.

1. Schedule a `FIXED_DATE` message about 5 minutes ahead; keep `messageId`.
2. Check its job, then delete only that job (backend folder, PowerShell):

   ```powershell
   $id = "<messageId>"
   node --input-type=module -e "import {Queue} from 'bullmq'; process.loadEnvFile('.env'); const q = new Queue('message-release', {connection:{url: process.env.REDIS_URL}}); const j = await q.getJob('message-release-$id'); console.log('before:', await j?.getState()); console.log('removed:', await q.remove('message-release-$id')); console.log('after:', await (await q.getJob('message-release-$id'))?.getState()); await q.close();"
   ```

   Expected: `before: delayed`, `removed: 1`, `after: undefined`. PostgreSQL is untouched.
3. Restart NestJS or wait up to 60 s. The log shows `reconciliation_enqueued 1 job(s)`.
4. Run the `getJob` check again: the state is `delayed`, rebuilt from PostgreSQL.
5. After the time passes: `RELEASED`, one `MessageRelease` row.

To wipe only the release queue (not sessions) in development:
`docker exec for-after-redis sh -c "redis-cli --scan --pattern 'bull:message-release:*' | xargs -r redis-cli del"`,
then restart NestJS.

---

## 16. Not in Step 12

Delivery (email/SMS/push), read/delivery receipts, dead-letter queue and alerting, a separate worker process, metrics
platform, `ANNUAL_AFTER_DEATH` and other recurring triggers.

> ✅ Added later: Recipient OTP + Portal (Step 13); Trusted Contact sign-in + death report intake (Step 14, releases
> nothing); death verification + `ON_DEATH`/`AFTER_DEATH` execution after an admin-verified death (Step 15).

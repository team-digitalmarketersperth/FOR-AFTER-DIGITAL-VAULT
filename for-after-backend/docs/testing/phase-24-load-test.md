# Phase 24 — Delivery-worker load test

> A repeatable harness for the release → access grant → "a message is waiting" email pipeline, run against the real
> separate worker process. Results: [`phase-24-results.md`](phase-24-results.md) §3; raw JSON per run in
> [`load-results/`](load-results/).

|                      |                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| **Harness**          | `scripts/load/delivery-load.mjs` (driver) + `scripts/load/worker-entry.mjs` (one worker process)      |
| **Isolation**        | `scripts/phase24/isolated-env.mjs`: dedicated PostgreSQL database `for_after_p24` + dedicated Redis `127.0.0.1:6390` only |
| **Targets**          | **Provisional.** No launch workload or SLO is documented (`PROJECT_OVERVIEW.md`, `docs/`), so every threshold below is a local acceptance criterion for this harness, not a production capacity claim |
| **Scope**            | Local machine only. Staging/production capacity is **not** measured                                  |

---

## 1. What runs

```
driver process (delivery-load.mjs)                    worker process × N (worker-entry.mjs)
├─ fake Graph sendMail server (127.0.0.1:random) ◀ POST ┤ dist/worker.module.js (WorkerModule, as `npm run worker:prod`)
│    records every attempt, simulates faults            │   release worker + reconciler
├─ API: dist/app.module.js (AppModule), in process      │   email-delivery worker + reconciler
│    producer only — fixtures through real HTTP routes  │   death-verification worker, dead letters + ops alerts
│    (register, login, recipients, messages, schedule,  │   EmailProvider = real MicrosoftGraphEmailProvider (fake
│     unschedule)                                       │   token) whose fetch goes to the fake server, not Graph
└─ monitor: PostgreSQL, BullMQ job timestamps, Redis
```

- **Real**: PostgreSQL, Redis, BullMQ, the API's validation/guards/scheduling, `MessageReleaseService`,
  `ReleaseNotificationProcessor` (row re-checks, idempotency key, attempts/backoff), dead letters and ops alerts, the
  Microsoft provider's error mapping and timeout (`EMAIL_SEND_TIMEOUT_MS`, 10 s). Since 2026-10-21; the 2026-10-21
  results in `phase-24-results.md` were measured with the (since removed) Brevo adapter against a fake Brevo endpoint.
- **Faked**: only the provider endpoint. Every email kind (release notifications, safety notices, ops alerts) goes
  through `EmailProvider`, so nothing can leave the machine; SMS providers are `disabled`.
- **No shortcuts**: messages become due through `POST /messages/:id/schedule` (FIXED_DATE) and are released by the
  worker's own delayed jobs; nothing is seeded in a released state. Production defaults are kept for release and email
  attempts (5), backoff (5 s / 30 s exponential), the send timeout and the worker concurrency (BullMQ default, 1 job at
  a time per queue per process). The reconcile interval is 60 s except in `dup-cancel` (5 s, to force reconciler
  passes during the run).
- **API alone consumes nothing**: before any worker starts, the driver asserts `getWorkersCount() = 0` on all three
  queues; in `dup-cancel` it also waits until the jobs are due and checks none became active.
- **Namespacing**: one run id per run → its own Customer (`p24load.<run>@example.test`), queues
  (`p24load-<run>-release|email|death`), throttle prefix and log folder. Cleanup deletes only that Customer (cascade),
  its dead letters, its queues and its keys (`--keep` to inspect).
- **Run one at a time**: every worker's release reconciler scans *all* due SCHEDULED messages in the database, so two
  runs (or a run and the e2e suite) on the same database would release each other's messages.

## 2. Fake provider

| Behaviour | How | Expected handling |
| --- | --- | --- |
| Latency | 80 ms ± 40 ms per request (`--latency-ms`, `--jitter-ms`) | — |
| Transient 5xx | `p500` share of release emails → `500 internal_error` | retryable, backoff |
| Throttling | `p429` share → `429 too_many_requests` | retryable (`rate_limit_exceeded`) |
| Timeout | `pTimeout` share held 12 s (> 10 s client timeout), **then accepted** | retryable `timeout`; the provider *did* accept it |
| Permanent | recipient `perm.<run>@example.test` → `400 invalid_parameter` | FAILED at once, dead letter, one ops alert |
| Crash window | at a progress point, one request is recorded as accepted and its response withheld; the driver kills that worker | stalled job → retried by another worker with the same `Idempotency-Key` |
| Provider dedupe | off by default; `--provider-dedupe` records a repeated key as deduplicated | shows both outcomes |

Faults apply to release notifications only; ops alerts and safety notices are always accepted.

## 3. Profiles

| Profile | Workload | Workers | Injected | Provisional acceptance |
| --- | --- | --- | --- | --- |
| `smoke` | 100 messages due at once | 1 | — | drain ≤ 180 s, p95 due→released ≤ 30 s, p95 due→sent ≤ 60 s |
| `burst` | 1,000 messages due at once | 1 | — | drain ≤ 1,200 s |
| `burst-2w` | 1,000 messages due at once | 2 | — | drain ≤ 900 s |
| `sustained` | 3 messages/s for 15 min (due 15 s after creation) | 2 | — | p95 due→released ≤ 30 s, p95 due→sent ≤ 60 s, backlog after the last arrival drained ≤ 120 s |
| `recovery` | 300 messages | 2 (+ replacements) | crash window at 10 %, graceful stop at 25 %, `SIGKILL` at 50 % | drain ≤ 600 s; crash window observed |
| `faults` | 300 messages, every 25th to a permanently rejected address | 2 | 10 % 5xx, 10 % 429, 3 % timeout | drain ≤ 1,200 s |
| `dup-cancel` | 300 messages | 2, started 15 s after due | 30 unscheduled before due, 30 unscheduled while due and waiting; every job re-added with its own id; 20 foreign-id duplicate release jobs; 10 jobs for cancelled messages; after settling, 20 foreign-id email jobs for SENT rows | drain ≤ 600 s |

Every profile is also judged on correctness, whatever the timings:

- settled before the profile deadline (else exit 1); the API alone consumed nothing
- every non-cancelled message released exactly once; no cancelled message released
- one grant per message × recipient; one notification row per grant; none PENDING
- FAILED only for permanent rejections (1 attempt) or retries exhausted (≥ 5 attempts)
- one dead letter and one ops alert per FAILED notification, and none otherwise
- a quiet reconcile window after settling adds no provider attempt and no release

Fan-out (`--fanout`), size (`--messages`), workers (`--workers`), rate/duration (`--rate`, `--duration`) and
latency are command-line options; `PROFILES` in the driver holds the rest.

## 4. Measurements

| Metric | Source |
| --- | --- |
| Messages, eligible deliveries, released, cancelled | PostgreSQL (`Message`, `MessageRelease`, `RecipientMessageAccessGrant`) |
| Due → released | `MessageRelease.releasedAt − scheduledFor` |
| Due → email recorded SENT (end to end) | `ReleaseNotification.sentAt − MessageRelease.scheduledFor` |
| Notification created → SENT | `sentAt − createdAt` |
| Queue wait / processing | BullMQ `processedOn − (timestamp + delay)` / `finishedOn − processedOn`, captured every second (completed jobs are trimmed at 1,000) |
| Throughput, drain | SENT rows / (last terminal − first due) |
| Retries, terminal failures, dead letters, alerts | `attemptCount`, `status`, `DeadLetterJob`, fake-provider `ops_alert` requests keyed by dead-letter id |
| Duplicates | grants per (message, recipient); notification rows per grant; provider requests per `Idempotency-Key` |
| Resources | worker CPU ms and peak RSS (sampled in-process), PostgreSQL connections (`pg_stat_activity`), Redis clients |

Percentiles use nearest rank; p95 only from 20 samples, p99 only from 100.

## 5. Reproduce

```bash
cd for-after-backend
docker run -d --name for-after-redis-p24 -p 127.0.0.1:6390:6379 redis:7-alpine redis-server --save "" --appendonly no
node scripts/phase24/isolated-env.mjs setup      # creates for_after_p24, migrates, marks the Redis
npm run build                                     # the harness runs the compiled dist/
node scripts/phase24/isolated-env.mjs -- node scripts/load/delivery-load.mjs --profile smoke
# … --profile burst | burst-2w | sustained | recovery | faults | dup-cancel   (one at a time)
```

Exit code 0 = every check passed. Teardown: `node scripts/phase24/isolated-env.mjs teardown` and
`docker rm -f for-after-redis-p24`.

# Phase 24 — Results (2026-10-21)

> Evidence for the two remaining Phase 24 items: critical security tests ([`phase-24-security-matrix.md`](phase-24-security-matrix.md))
> and the delivery-worker load test ([`phase-24-load-test.md`](phase-24-load-test.md)). **Local verification only.**

|                        |                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| **Commit**             | `d268f01` on `staging`, with a large uncommitted working tree (earlier phases plus this work); results are for the working tree, not the commit alone |
| **Machine**            | Windows 11 Pro, Intel i5-1145G7 (8 logical CPUs), 8 GB RAM                                         |
| **Runtime**            | Node v22.23.2, npm 11.20.0, TypeScript 6.0.3                                                       |
| **Dependencies**       | NestJS 12.0.4, @nestjs/throttler 6.7.0, BullMQ 6.3.9, Prisma 7.10.0, node-redis 6.2.1, pg 8.23.0, express-session 1.19.0, connect-redis 10.0.0, Vitest 4.1.11, supertest 7.3.0, @imagekit/nodejs 7.12.1, oxlint 1.85.0 |
| **Test PostgreSQL**    | Local server 18.6, database `for_after_p24` (created and migrated by `scripts/phase24/isolated-env.mjs setup`) |
| **Test Redis**         | Docker `for-after-redis-p24` (redis:7-alpine, 7.4.11) on `127.0.0.1:6390`, no persistence, carries the Phase 24 marker key |
| **Not touched**        | Development database `for_after` (one read-only census, §4) and the shared Redis on 6379           |
| **External services**  | None, except one live ImageKit expiry check (one synthetic file uploaded to `phase24/<run>/` and deleted) |

> **Provider note (added 2026-10-21, later the same day):** these runs used the Brevo adapter against a fake Brevo
> endpoint. Brevo has since been removed and the harness now drives `MicrosoftGraphEmailProvider` against a fake Graph
> endpoint (`scripts/load/`). Graph has no idempotency key, so the duplicate-delivery windows in §3 apply unchanged.

---

## 1. Commands

```bash
cd for-after-backend
docker run -d --name for-after-redis-p24 --label for-after.purpose=phase24-test \
  -p 127.0.0.1:6390:6379 redis:7-alpine redis-server --save "" --appendonly no
node scripts/phase24/isolated-env.mjs setup
npm run build

# Security + regression (e2e on the isolated targets)
node scripts/phase24/isolated-env.mjs -- npx vitest run --config ./vitest.config.e2e.ts
node scripts/phase24/isolated-env.mjs -- npx vitest run --config ./vitest.config.e2e.ts test/security-critical.e2e-spec.ts
node scripts/phase24/isolated-env.mjs -- npx vitest run --config ./vitest.config.e2e.ts test/death-verification.e2e-spec.ts
node scripts/phase24/imagekit-expired-url-check.mjs          # live provider: needs .env ImageKit keys

# Unit, types, lint
npm test
npx tsc --noEmit -p tsconfig.json
npm run lint

# Load (one at a time)
for p in smoke burst burst-2w recovery faults dup-cancel sustained; do
  node scripts/phase24/isolated-env.mjs -- node scripts/load/delivery-load.mjs --profile $p
done
```

The guard refuses a non-local database, a database name not ending in `_p24`/`_test`, Redis on port 6379, and any
Redis without the marker (verified: `P24_REDIS_URL=redis://127.0.0.1:6379 … → refused`).

---

## 2. Test results

| Run | Command | Passed | Failed | Skipped | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| E2E baseline, before Phase 24 changes | full e2e (isolated) | 549 (39 files) | 0 | 0 | first run of the existing suite on dedicated targets (1,075 s) |
| `security-critical` (new) | single file | 13 | 0 | 0 | §50 gaps, production OTP/login limits |
| `death-verification` (+1 new race test) | single file | 26 | 0 | 0 | duplicate admin approval |
| **E2E final** | full e2e (isolated) | **563 (40 files)** | 0 | 0 | 919 s; release-worker suites one at a time |
| Dead-letter cleanup re-check | `email-delivery`, `dead-letters`, `admin` + a temporary probe file | 48 + 1 | 0 | 0 | after the cleanup fix (§4); probe row removed (0 left) |
| Unit | `npm test` (isolated) | 1,280 (56 files) | 0 | 2 | skipped = opt-in live Brevo spec. **Flaky, pre-existing**: `auth.controller.spec` › *is limited to 5 attempts per minute* hit the 5 s default timeout in 2 of 3 full runs (passes alone, 16/16; file unchanged by this work); not fixed |
| Live ImageKit expiry | `imagekit-expired-url-check.mjs` | 1 | 0 | 0 | unsigned 403, valid 200, tampered 403, expired 403; file deleted |
| Types | `npx tsc --noEmit -p tsconfig.json` | ✅ | | | src + test |
| Lint | `npm run lint` | ✅ | | | 0 warnings |
| Build | `npm run build` | ✅ | | | |
| Frontend | — | — | — | — | not run: no frontend behaviour changed |

The final full e2e run predates the cleanup correction in §4 (a test-only hook); that change was re-verified with the
three dead-letter-producing suites and the probe above.

---

## 3. Load results

All runs: fan-out 1, fake provider latency 80 ± 40 ms, production retry/backoff/timeout settings, one job at a time
per queue per worker process (BullMQ default concurrency). Raw JSON: [`load-results/`](load-results/).

| Profile | Messages (cancelled) | Workers | Released | Sent / failed | Retries | Provider requests (keys accepted twice) | Dead letters / alerts | Due→released p50/p95/p99 s | Due→sent p50/p95/p99 s | Drain s | Sent/s | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| smoke | 100 | 1 | 100 | 100 / 0 | 0 | 100 (0) | 0 / 0 | 2.0 / 3.4 / 3.5 | 5.4 / 10.1 / 10.5 | 10.6 | 9.4 | ✅ |
| burst | 1,000 | 1 | 1,000 | 1,000 / 0 | 0 | 1,000 (0) | 0 / 0 | 10.3 / 20.2 / 21.1 | 57.4 / 108.9 / 113.2 | 114.5 | 8.7 | ✅ |
| burst-2w | 1,000 | 2 | 1,000 | 1,000 / 0 | 0 | 1,000 (0) | 0 / 0 | 11.3 / 17.9 / 18.5 | 33.4 / 58.6 / 60.9 | 61.6 | 16.3 | ✅ |
| recovery | 300 | 2 → 5 started | 300 | 300 / 0 | 0 | 302 (**2**) | 0 / 0 | 10.2 / 13.8 / 14.2 | 21.5 / 34.7 / 35.3 | 81.1 | 3.7 | ✅ |
| faults | 300 | 2 | 300 | 288 / 12 | 71 | 371 (**9**) | 12 / 12 | 3.5 / 6.4 / 6.6 | 40.6 / 75.4 / 139.6 | 234.8 | 1.2 | ✅ |
| dup-cancel | 300 (60) | 2, late start | 240 | 240 / 0 | 0 | 240 (0) | 0 / 0 | 49.5 / 53.6 / 54.1 | 57.5 / 66.8 / 67.2 | 67.4 | 3.6 | ✅ |
| sustained | 2,700 (3/s × 15 min) | 2 | 2,700 | 2,700 / 0 | 0 | 2,700 (0) | 0 / 0 | 0.02 / 0.09 / 0.14 | 0.15 / 0.24 / 0.31 | 0.2 after the last arrival | 3.0 (= arrival rate) | ✅ |

Queue timing (seconds, p50 / p95):

| Profile | Release queue wait | Release processing | Email queue wait (1st attempt) | Email processing (incl. provider) |
| --- | --- | --- | --- | --- |
| smoke | 2.0 / 3.4 | 0.03 / 0.05 | 3.3 / 6.6 | 0.11 / 0.14 |
| burst | 10.3 / 20.2 | 0.02 / 0.03 | 47.0 / 88.5 | 0.11 / 0.19 |
| burst-2w | 9.1 / 17.9 | 0.02 / 0.04 | 21.9 / 40.6 | 0.11 / 0.18 |
| recovery | 9.5 / 13.8 | 0.03 / 0.06 | 10.9 / 20.6 | 0.11 / 0.16 |
| faults | 3.5 / 6.4 | 0.04 / 0.08 | 23.4 / 41.8 | 0.11 / 0.16 |
| dup-cancel | 46.7 / 53.5 | 0.03 / 0.07 | 7.3 / 13.0 | 0.11 / 0.15 |
| sustained | 0.01 / 0.08 | 0.02 / 0.04 | 0.00 / 0.00 | 0.11 / 0.17 |

Resources: worker peak RSS 159–193 MB per process (sustained: 166/167 MB after 15 min, no growth; 43 s CPU each); PostgreSQL connections peaked at 7 (1 worker) to 15 (recovery,
replacements); Redis clients 17–26 (API + driver + workers).

### What the numbers say (under these conditions only)

- **The email step is the bottleneck.** Releases run at ≈ 50/s per worker; one email worker sends ≈ 9 notifications/s
  at ~110 ms per provider call, because each worker process handles one job at a time. A second process nearly
  doubled throughput (8.7 → 16.3/s; 1,000 drained in 61.6 s instead of 114.5 s). Capacity therefore scales with worker
  processes and **inversely with real provider latency**, which this run does not measure: at a real 300 ms Brevo
  round trip, expect roughly ⅓ of these rates per process.
- **Sustained 3/s for 15 min** (2 workers, ≈ 20 % of the measured 2-worker capacity): no backlog (peak 1 queued email),
  p99 due→sent 0.31 s, 2,700/2,700 sent. The sustained rate at which backlog starts to grow was not searched for; the
  burst runs bound it at ≈ 9 notifications/s per worker process under 80 ms provider latency.
- **Recovery**: a graceful stop closed in 0.2 s with no loss; two `SIGKILL`s lost nothing. Stalled jobs were picked up
  by other workers after BullMQ's lock expiry (≈ 30 s), which is the recovery delay to expect after a crash.
- **Faults**: every transient failure (32 × 5xx, 30 × 429, 9 × timeout) was retried to SENT with backoff; 12 permanent
  rejections became FAILED after one attempt, each with one dead letter and one ops alert. The 30 s exponential backoff
  dominates latency under faults (p99 due→sent 140 s).
- **Duplicates and cancellation**: 330 duplicate/foreign release jobs and 20 foreign email jobs for SENT rows caused no
  extra release, grant, row or provider request; every message unscheduled before due or while due-but-waiting stayed
  unreleased. With the API alone, due jobs stayed unconsumed (0 workers, 0 active).

### Exactly-once is not guaranteed externally

PostgreSQL guarantees one logical notification per grant (300/300 rows, 0 duplicates in every run). It does **not**
guarantee one external email:

| Window | Observed | Logical rows | Provider submissions |
| --- | --- | --- | --- |
| Provider accepted, worker killed before recording SENT (crash window + the unexpected kill) | recovery | 300 | 302 (2 keys submitted twice) |
| Provider slower than the 10 s client timeout but still accepted | faults | 300 | 9 keys submitted twice |

Each retry carries the same `Idempotency-Key: release-notification/<id>` (in the Brevo message `headers` object).
Whether Brevo deduplicates on it was **not verified**; if it does not, those are duplicate emails to a Recipient (a
privacy-neutral "a message is waiting" notice, but still a duplicate). With `--provider-dedupe` the fake shows the other
outcome (one delivery per key).

---

## 4. Defects found and fixed

| # | Defect | Evidence | Fix | Regression coverage |
| --- | --- | --- | --- | --- |
| 1 | E2E suites leaked `DeadLetterJob` rows (no FK) after deleting their test users; any worker later started on that database emailed `OPS_ALERT_EMAIL` about them | 24 orphaned rows after one full e2e run in `for_after_p24`; the smoke run's worker sent 16 alerts for them to the fake provider; read-only census of the development database found **285** orphaned rows (1 PENDING and 2 FAILED alerts still retryable) | `test/setup-e2e.ts`: after each file, delete dead letters created during that file whose entity no longer exists | The first version compared a JS `Date` with the `timestamp(3)` column; in a session with time zone `Asia/Calcutta` it matched nothing, and the final full run still leaked 20 rows (44 in total). Corrected to compare UTC text (`$1::timestamp`); a probe file that writes an orphaned dead letter now leaves 0 rows. The 44 rows already in `for_after_p24` were left (test database) |

No application (src/) defect was found: every §50 case and every load correctness check passed on the first run that
exercised it. The harness needed two corrections of its own (alerts are now matched to the run's dead letters by
idempotency key; FAILED may also mean retries exhausted).

---

## 5. Limitations and open items

- **Stripe webhook replay (§50)**: not testable — phase 21 (billing) is not built.
- **Local only**: no staging or production load or security run; the Railway demo topology (an extra proxy hop through
  Next.js) was not measured for limiter identity (matrix §3).
- **Provider deduplication**: unverified (above).
- **Login throttling is per IP only** (matrix §3): reported, no policy invented.
- **Alert volume**: one ops email per dead letter; a burst of permanent failures (e.g. a bad sender configuration)
  would send one alert per failed notification. The 15-minute cooldown only spaces *retries* of failed alerts.
- **Dead letters in the development database**: the 285 existing rows were left in place; remove them with
  `node scripts/dev-clean-orphan-queue-data.mjs` before running a worker with `OPS_ALERT_EMAIL` against `for_after`.
- **Throughput assumptions**: 80 ms fake provider latency, fan-out 1, one machine running PostgreSQL, Redis, the API,
  the driver and the workers together.

---

## 6. Cleanup

Each load run deletes its own Customer (cascade), dead letters, queues and keys. To remove the test environment:

```bash
node scripts/phase24/isolated-env.mjs teardown   # drops for_after_p24
docker rm -f for-after-redis-p24
```

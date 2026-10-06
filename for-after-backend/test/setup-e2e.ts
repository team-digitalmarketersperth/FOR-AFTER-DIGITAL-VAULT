import { randomUUID } from 'node:crypto';

// Throttler counters live in Redis (Phase 04) and every e2e file signs in from
// 127.0.0.1: a namespace per file and run keeps suites (and reruns within the
// window) from spending each other's limits. Production uses the default.
process.env.THROTTLE_KEY_PREFIX = `for_after:test:${randomUUID()}:throttle:`;

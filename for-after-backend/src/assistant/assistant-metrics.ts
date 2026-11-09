import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service.js';

/**
 * AI Operations aggregates (docs/assistant.md §8). Operational counts only:
 * never text, user ids, request ids or error strings. One Redis hash per UTC
 * hour, shared by every API instance, fields from the allowlists below.
 * Not a billing record: an outage, eviction or expiry leaves a gap.
 */
export const REQUEST_OUTCOMES = [
  'reply', // a reply was returned
  'reply_truncated', // returned, cut at the completion-token limit
  'empty_reply', // the provider answered with nothing usable (502)
  'not_configured', // no GROQ_API_KEY (503)
  'user_limit', // per-Customer hourly limit (429)
  'global_limit', // app-wide provider-attempt limit (429)
  'concurrency_limit', // app-wide in-flight cap (429)
  'limits_unavailable', // the limits' Redis could not be read (503, fail closed)
  'provider_rate_limited', // the provider's 429, after any retry (429)
  'provider_config', // the provider refused the key or request: 401/403/4xx (503)
  'provider_failure', // provider 5xx, network error or malformed reply (502)
  'timeout', // the 25 s budget ran out (502)
  'cancelled', // the browser closed the request
  'unknown', // anything else; never counted as success
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

/** One outbound provider call. */
export const ATTEMPT_RESULTS = [
  'ok',
  'provider_429',
  'provider_auth',
  'provider_request',
  'provider_5xx',
  'network',
  'malformed',
  'timeout',
  'cancelled',
] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

export type Usage = { input?: number; output?: number; total?: number };

const PREFIX = 'for_after:ai_metrics:';
const HOUR = 3_600_000;
export const RETENTION_HOURS = 192; // 8 days: the 7-day window is always complete
const LAST = `${PREFIX}last`;
const SINCE = `${PREFIX}since`;

export const bucketKey = (at: number) => `${PREFIX}h:${Math.floor(at / HOUR)}`;
const whole = (n: number) => Math.max(0, Math.round(n));

@Injectable()
export class AssistantMetrics {
  private readonly logger = new Logger('AssistantMetrics');
  private failing = false;

  constructor(private readonly redis: RedisService) {}

  /** Once per validated request, from the request's single `finally`. Never throws. */
  request(page: string, action: string, outcome: RequestOutcome, ms: number, now = Date.now()) {
    const d = `${page}:${action}`;
    const fields: Record<string, number> = { [`r:${d}:${outcome}`]: 1, [`rms:${d}:${outcome}`]: whole(ms) };
    const last =
      outcome === 'reply' || outcome === 'reply_truncated'
        ? 'reply'
        : ['provider_rate_limited', 'provider_config', 'provider_failure', 'timeout', 'empty_reply'].includes(outcome)
          ? 'provider_failure'
          : undefined;
    return this.write(fields, now, last);
  }

  /** Once per outbound provider call (retries included). Usage only as the provider reported it. */
  attempt(page: string, action: string, result: AttemptResult, ms: number, retry: boolean, usage?: Usage, now = Date.now()) {
    const d = `${page}:${action}`;
    const fields: Record<string, number> = { [`a:${d}:${result}`]: 1, [`ams:${d}`]: whole(ms) };
    if (retry) fields[`retry:${d}`] = 1;
    // Usage counted only when all three numbers came back; otherwise the attempt's usage is unknown.
    if (usage && [usage.input, usage.output, usage.total].every((n) => typeof n === 'number' && n >= 0)) {
      fields[`tk:${d}`] = 1;
      fields[`tin:${d}`] = whole(usage.input!);
      fields[`tout:${d}`] = whole(usage.output!);
      fields[`ttot:${d}`] = whole(usage.total!);
    }
    return this.write(fields, now);
  }

  private async write(fields: Record<string, number>, now: number, last?: string) {
    const key = bucketKey(now);
    try {
      const m = this.redis.client.multi();
      for (const [f, n] of Object.entries(fields)) m.hIncrBy(key, f, n);
      m.expire(key, RETENTION_HOURS * 3600);
      m.set(SINCE, String(now), { NX: true });
      if (last) m.hSet(LAST, last, String(now)).expire(LAST, RETENTION_HOURS * 3600);
      await m.exec();
      if (this.failing) this.logger.log('assistant_metrics_recovered');
      this.failing = false;
    } catch (err) {
      // Logged once per failure spell; the reply, limits and slots are unaffected.
      if (!this.failing) this.logger.warn(`assistant_metrics_failed (${err instanceof Error ? err.name : 'UNKNOWN'})`);
      this.failing = true;
    }
  }

  /**
   * The hourly buckets covering [now - hours, now]: the oldest one may start up
   * to an hour earlier (whole buckets are read) and the newest is partial.
   */
  async read(hours: number, now = Date.now()) {
    const first = Math.floor((now - hours * HOUR) / HOUR) + 1;
    const last = Math.floor(now / HOUR);
    const m = this.redis.client.multi();
    for (let h = first; h <= last; h++) m.hGetAll(`${PREFIX}h:${h}`);
    m.get(SINCE);
    m.hGetAll(LAST);
    const results = (await m.exec()) as unknown as (Record<string, string> | string | null)[];
    const lastSeen = results.pop() as Record<string, string>;
    const since = results.pop() as string | null;
    return {
      from: new Date(first * HOUR),
      to: new Date(now),
      buckets: results as Record<string, string>[],
      collectingSince: since ? new Date(Number(since)) : null,
      lastReplyAt: lastSeen.reply ? new Date(Number(lastSeen.reply)) : null,
      lastProviderFailureAt: lastSeen.provider_failure ? new Date(Number(lastSeen.provider_failure)) : null,
    };
  }
}

import { Injectable, Logger } from '@nestjs/common';
import {
  ATTEMPT_RESULTS,
  AssistantMetrics,
  REQUEST_OUTCOMES,
  type AttemptResult,
  type RequestOutcome,
} from '../assistant/assistant-metrics.js';
import { ASSISTANT_ACTIONS, ASSISTANT_PAGES, AssistantService } from '../assistant/assistant.service.js';
import type { AiOperationsQueryDto } from './dto/admin.dto.js';

export const AI_WINDOWS = { '24h': 24, '7d': 168 } as const;
const REPLIES: RequestOutcome[] = ['reply', 'reply_truncated'];

const zeros = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/**
 * Sums the hourly buckets for the window, optionally for one page and/or
 * action. Means are total duration / count over every bucket (weighted), with
 * the sample count; no percentiles (no histogram is kept). Unknown fields are
 * ignored, so nothing outside the allowlists can reach a response.
 */
export function summarise(buckets: Record<string, string>[], page?: string, action?: string) {
  const requests = zeros(REQUEST_OUTCOMES);
  const requestMs = zeros(REQUEST_OUTCOMES);
  const attempts = zeros(ATTEMPT_RESULTS);
  let attemptMs = 0;
  let retries = 0;
  const tokens = { reportedAttempts: 0, input: 0, output: 0, total: 0 };
  for (const bucket of buckets) {
    for (const [field, raw] of Object.entries(bucket)) {
      const [kind, p, a, last] = field.split(':');
      if (!(ASSISTANT_PAGES as readonly string[]).includes(p!) || !(ASSISTANT_ACTIONS as readonly string[]).includes(a!)) continue;
      if ((page && p !== page) || (action && a !== action)) continue;
      const n = Number(raw);
      if (!Number.isSafeInteger(n) || n < 0) continue;
      const outcome = last as RequestOutcome;
      if (kind === 'r' && outcome in requests) requests[outcome] += n;
      else if (kind === 'rms' && outcome in requestMs) requestMs[outcome] += n;
      else if (kind === 'a' && last! in attempts) attempts[last as AttemptResult] += n;
      else if (kind === 'ams' && !last) attemptMs += n;
      else if (kind === 'retry' && !last) retries += n;
      else if (kind === 'tk' && !last) tokens.reportedAttempts += n;
      else if (kind === 'tin' && !last) tokens.input += n;
      else if (kind === 'tout' && !last) tokens.output += n;
      else if (kind === 'ttot' && !last) tokens.total += n;
    }
  }
  const sum = (r: Record<string, number>, keys = Object.keys(r)) => keys.reduce((t, k) => t + r[k]!, 0);
  const mean = (total: number, count: number) => (count ? Math.round(total / count) : null);
  const totalRequests = sum(requests);
  const totalAttempts = sum(attempts);
  const replies = sum(requests, REPLIES);
  return {
    requests: {
      total: totalRequests,
      byOutcome: requests,
      meanMs: mean(sum(requestMs), totalRequests),
      replyMeanMs: mean(sum(requestMs, REPLIES), replies),
      replySamples: replies,
    },
    attempts: { total: totalAttempts, retries, byResult: attempts, meanMs: mean(attemptMs, totalAttempts) },
    // Usage is known only for attempts whose provider response reported all three numbers.
    tokens: { ...tokens, unknownAttempts: totalAttempts - tokens.reportedAttempts },
  };
}

/** AI Operations: configuration presence + observed aggregates. Never calls the provider. */
@Injectable()
export class AdminAiService {
  private readonly logger = new Logger(AdminAiService.name);

  constructor(
    private readonly assistant: AssistantService,
    private readonly metrics: AssistantMetrics,
  ) {}

  async operations(q: AiOperationsQueryDto, now = Date.now()) {
    const window = q.window ?? '24h';
    const base = {
      evaluatedAt: new Date(now).toISOString(),
      window,
      filters: { area: q.area ?? null, action: q.action ?? null },
      configuration: this.assistant.settings,
    };
    try {
      const read = await this.metrics.read(AI_WINDOWS[window], now);
      return {
        ...base,
        monitoring: 'available' as const,
        period: { from: read.from.toISOString(), to: read.to.toISOString() },
        collectingSince: read.collectingSince?.toISOString() ?? null,
        lastReplyAt: read.lastReplyAt?.toISOString() ?? null,
        lastProviderFailureAt: read.lastProviderFailureAt?.toISOString() ?? null,
        ...summarise(read.buckets, q.area, q.action),
      };
    } catch (err) {
      // Never zeros: the page says monitoring is unavailable.
      this.logger.error(`admin_ai_metrics_unavailable (${err instanceof Error ? err.name : 'UNKNOWN'})`);
      return { ...base, monitoring: 'unavailable' as const };
    }
  }
}

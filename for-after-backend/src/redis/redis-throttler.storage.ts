import type { ConfigService } from '@nestjs/config';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { RedisService } from './redis.service.js';

/**
 * @nestjs/throttler counters in Redis (Phase 04), so every API instance counts
 * the same hits. Reuses the app's one Redis client (not a BullMQ connection).
 * Keys are the throttler's own SHA-256 of route + throttler + IP, under
 * THROTTLE_KEY_PREFIX (default for_after:throttle:), apart from sessions,
 * OTP state and queues. A Redis error is thrown, so the request fails (500)
 * instead of going through unthrottled.
 *
 * ponytail: fixed window, and a blocked caller stays blocked until the window
 * ends (blockDuration is not tracked separately). That matches the throttler's
 * default (blockDuration = ttl), which every route here uses.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly prefix: string;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.prefix =
      config.get<string>('THROTTLE_KEY_PREFIX') || 'for_after:throttle:';
  }

  async increment(key: string, ttl: number, limit: number) {
    const k = `${this.prefix}${key}`;
    const [hits, , pttl] = (await this.redis.client
      .multi()
      .incr(k)
      .pExpire(k, ttl, 'NX')
      .pTTL(k)
      .exec()) as unknown as [number, number, number];
    const seconds = Math.max(1, Math.ceil(pttl / 1000));
    const isBlocked = hits > limit;
    return {
      totalHits: hits,
      timeToExpire: seconds,
      isBlocked,
      timeToBlockExpire: isBlocked ? seconds : 0,
    } satisfies Awaited<ReturnType<ThrottlerStorage['increment']>>;
  }
}

import type { ConfigService } from '@nestjs/config';
import {
  MessageReleaseQueue,
  releaseJobId,
  releaseSettings,
} from './message-release-queue.service.js';

// A fake bullmq Queue: no Redis is touched in unit tests.
const bull = vi.hoisted(() => ({
  queue: {
    add: vi.fn(),
    remove: vi.fn(),
    getJob: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
  },
  ctor: vi.fn(),
}));
vi.mock('bullmq', () => ({
  Queue: vi.fn(function (this: object, ...args: unknown[]) {
    bull.ctor(...args);
    return bull.queue;
  }),
}));

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2030-12-24T00:00:00Z');
const inMs = (ms: number) => new Date(NOW.getTime() + ms);
const HOUR = 3600_000;

const config = (env: Record<string, string> = {}) =>
  ({
    get: (key: string) =>
      ({ REDIS_URL: 'redis://localhost:6379', ...env })[key],
  }) as unknown as ConfigService;

const setup = (env?: Record<string, string>) => {
  vi.clearAllMocks();
  bull.queue.add.mockResolvedValue({});
  bull.queue.remove.mockResolvedValue(1);
  bull.queue.getJob.mockResolvedValue(undefined);
  return new MessageReleaseQueue(config(env));
};

const fixed = (scheduledFor: Date) => ({
  triggerType: 'FIXED_DATE' as const,
  scheduledFor,
});

describe('releaseSettings', () => {
  it('uses the documented defaults and REDIS_URL', () => {
    expect(releaseSettings(config())).toEqual({
      queueName: 'message-release',
      connection: { url: 'redis://localhost:6379' },
      lookaheadMs: 86400_000,
      reconcileIntervalMs: 60_000,
      attempts: 5,
      backoffMs: 5000,
    });
  });

  it('QUEUE_REDIS_URL overrides REDIS_URL; bad numbers stop startup', () => {
    expect(
      releaseSettings(config({ QUEUE_REDIS_URL: 'redis://queue:6379' }))
        .connection.url,
    ).toBe('redis://queue:6379');
    expect(() =>
      releaseSettings(config({ RELEASE_JOB_ATTEMPTS: '0' })),
    ).toThrow('RELEASE_JOB_ATTEMPTS');
  });

  it('creates the queue with the configured name, failing fast offline', () => {
    setup({ RELEASE_QUEUE_NAME: 'test-release' });
    expect(bull.ctor).toHaveBeenCalledWith('test-release', {
      connection: {
        url: 'redis://localhost:6379',
        enableOfflineQueue: false,
      },
    });
  });
});

describe('MessageReleaseQueue.sync', () => {
  it('uses a deterministic job id without a single colon', () => {
    expect(releaseJobId(ID)).toBe(`message-release-${ID}`);
    expect(releaseJobId(ID)).toBe(releaseJobId(ID));
  });

  it('queues a FIXED_DATE inside the lookahead with the exact delay, retries and backoff', async () => {
    const queue = setup();
    await queue.sync(ID, fixed(inMs(2 * HOUR)), NOW);
    expect(bull.queue.remove).toHaveBeenCalledWith(releaseJobId(ID));
    expect(bull.queue.add).toHaveBeenCalledWith(
      'release',
      { messageId: ID },
      expect.objectContaining({
        jobId: releaseJobId(ID),
        delay: 2 * HOUR,
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
      }),
    );
    // Payload holds the id only.
    expect(Object.keys(bull.queue.add.mock.calls[0][1])).toEqual(['messageId']);
    const opts = bull.queue.add.mock.calls[0][2];
    expect(opts.removeOnComplete).toBeTruthy();
    expect(opts.removeOnFail).toBeTruthy();
  });

  it('a due or overdue schedule runs immediately (delay 0)', async () => {
    const queue = setup();
    await queue.sync(ID, fixed(inMs(-5 * HOUR)), NOW);
    await queue.sync(ID, fixed(NOW), NOW);
    expect(bull.queue.add.mock.calls.map((c) => c[2].delay)).toEqual([0, 0]);
  });

  it('beyond the lookahead: stays in PostgreSQL only (old job removed)', async () => {
    const queue = setup();
    await queue.sync(ID, fixed(inMs(25 * HOUR)), NOW);
    expect(bull.queue.remove).toHaveBeenCalled();
    expect(bull.queue.add).not.toHaveBeenCalled();
  });

  it.each(['ON_DEATH', 'AFTER_DEATH'] as const)(
    '%s is never queued; a stale job is removed',
    async (triggerType) => {
      const queue = setup();
      await queue.sync(ID, { triggerType, scheduledFor: null }, NOW);
      expect(bull.queue.remove).toHaveBeenCalledWith(releaseJobId(ID));
      expect(bull.queue.add).not.toHaveBeenCalled();
    },
  );

  it('null (unscheduled) only removes the job', async () => {
    const queue = setup();
    await queue.sync(ID, null, NOW);
    expect(bull.queue.remove).toHaveBeenCalledWith(releaseJobId(ID));
    expect(bull.queue.add).not.toHaveBeenCalled();
  });

  it('never throws on Redis errors (the DB change stands)', async () => {
    const queue = setup();
    bull.queue.remove.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      queue.sync(ID, fixed(inMs(HOUR)), NOW),
    ).resolves.toBeUndefined();
    bull.queue.remove.mockResolvedValue(1);
    bull.queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      queue.sync(ID, fixed(inMs(HOUR)), NOW),
    ).resolves.toBeUndefined();
  });

  it('a hung Redis call times out instead of blocking the request', async () => {
    vi.useFakeTimers();
    try {
      const queue = setup();
      bull.queue.remove.mockReturnValue(new Promise(() => undefined));
      const done = queue.sync(ID, fixed(inMs(HOUR)), NOW);
      await vi.advanceTimersByTimeAsync(5000);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MessageReleaseQueue.ensure (reconciler)', () => {
  const job = (state: string, firesAt: Date) => ({
    getState: vi.fn().mockResolvedValue(state),
    timestamp: NOW.getTime(),
    opts: { delay: firesAt.getTime() - NOW.getTime() },
  });

  it('recreates a missing job (e.g. after Redis was flushed)', async () => {
    const queue = setup();
    expect(await queue.ensure(ID, inMs(HOUR), NOW)).toBe(true);
    expect(bull.queue.add).toHaveBeenCalledTimes(1);
  });

  it('leaves a healthy delayed, waiting or active job alone (duplicate runs are safe)', async () => {
    const queue = setup();
    for (const state of ['delayed', 'waiting', 'active']) {
      bull.queue.getJob.mockResolvedValue(job(state, inMs(HOUR)));
      expect(await queue.ensure(ID, inMs(HOUR), NOW)).toBe(false);
    }
    expect(bull.queue.add).not.toHaveBeenCalled();
    expect(bull.queue.remove).not.toHaveBeenCalled();
  });

  it('replaces a job that would fire too late, or that already finished', async () => {
    const queue = setup();
    bull.queue.getJob.mockResolvedValue(job('delayed', inMs(3 * HOUR)));
    expect(await queue.ensure(ID, inMs(HOUR), NOW)).toBe(true);
    bull.queue.getJob.mockResolvedValue(job('failed', inMs(0)));
    expect(await queue.ensure(ID, inMs(HOUR), NOW)).toBe(true);
    bull.queue.getJob.mockResolvedValue(job('completed', inMs(0)));
    expect(await queue.ensure(ID, inMs(HOUR), NOW)).toBe(true);
    expect(bull.queue.add).toHaveBeenCalledTimes(3);
    expect(bull.queue.add.mock.calls[0][2].delay).toBe(HOUR);
  });

  it('propagates Redis errors to the reconciler', async () => {
    const queue = setup();
    bull.queue.getJob.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(queue.ensure(ID, inMs(HOUR), NOW)).rejects.toThrow(
      'ECONNREFUSED',
    );
  });
});

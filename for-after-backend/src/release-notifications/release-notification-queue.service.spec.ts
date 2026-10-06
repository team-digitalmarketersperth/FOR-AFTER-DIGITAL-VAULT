import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  notificationJobId,
  ReleaseNotificationQueue,
} from './release-notification-queue.service.js';

// A fake bullmq Queue: no Redis is touched in unit tests.
const bull = vi.hoisted(() => ({
  queue: { add: vi.fn(), on: vi.fn(), close: vi.fn() },
}));
vi.mock('bullmq', () => ({
  Queue: vi.fn(function () {
    return bull.queue;
  }),
}));

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2030-12-24T00:00:00Z');

const setup = (rows: { id: string }[]) => {
  vi.clearAllMocks();
  bull.queue.add.mockResolvedValue({});
  const findMany = vi.fn().mockResolvedValue(rows);
  const config = {
    get: (key: string) =>
      ({ REDIS_URL: 'redis://localhost:6379' })[key as 'REDIS_URL'],
  } as unknown as ConfigService;
  const queue = new ReleaseNotificationQueue(config, {
    releaseNotification: { findMany },
  } as unknown as PrismaService);
  return { queue, findMany };
};

describe('ReleaseNotificationQueue (Step 24.1)', () => {
  it('one job per notification row, with an id derived from the row (re-adding is a no-op in BullMQ)', async () => {
    const { queue } = setup([]);
    await queue.enqueue(A);
    await queue.enqueue(A);
    expect(bull.queue.add).toHaveBeenCalledTimes(2);
    for (const [name, data, opts] of bull.queue.add.mock.calls) {
      expect(name).toBe('message-released');
      // Only the row id: no address, name, subject or content in Redis.
      expect(data).toEqual({ notificationId: A });
      expect(opts).toMatchObject({
        jobId: notificationJobId(A),
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
      });
    }
  });

  it('after a release: queues only that message’s PENDING rows', async () => {
    const { queue, findMany } = setup([{ id: A }, { id: B }]);
    expect(await queue.enqueueForMessage('m-1')).toBe(2);
    expect(findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', grant: { messageId: 'm-1' } },
      select: { id: true },
    });
    expect(bull.queue.add.mock.calls.map((c) => c[2].jobId)).toEqual([
      notificationJobId(A),
      notificationJobId(B),
    ]);
  });

  it('reconciler: only PENDING rows past the grace period, for a live RELEASED message', async () => {
    const { queue, findMany } = setup([{ id: A }]);
    expect(await queue.enqueueStale(NOW)).toBe(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: 'PENDING',
          createdAt: { lte: new Date(NOW.getTime() - 2 * 60_000) },
          grant: { message: { status: 'RELEASED', deletedAt: null } },
        },
        take: 200,
      }),
    );
  });

  it('a Redis failure is logged and reported, never thrown (the reconciler retries)', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { queue } = setup([{ id: A }, { id: B }]);
    bull.queue.add
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({});
    expect(await queue.enqueueStale(NOW)).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`email_queue_add_failed notification ${A}`),
    );
    warn.mockRestore();
  });
});

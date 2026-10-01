import type { PrismaService } from '../prisma/prisma.service.js';
import type { MessageReleaseQueue } from './message-release-queue.service.js';
import { MessageReleaseReconciler } from './message-release-reconciler.service.js';

const NOW = new Date('2030-12-24T00:00:00Z');
const DAY = 86400_000;
const rows = [
  { messageId: 'overdue', scheduledFor: new Date(NOW.getTime() - DAY) },
  { messageId: 'soon', scheduledFor: new Date(NOW.getTime() + 3600_000) },
];

const setup = (activationRows: object[] = []) => {
  const findMany = vi.fn().mockResolvedValue(rows);
  const activationsFindMany = vi.fn().mockResolvedValue(activationRows);
  const ensure = vi.fn().mockResolvedValue(true);
  const queue = {
    ensure,
    settings: { lookaheadMs: DAY, reconcileIntervalMs: 60_000 },
  };
  return {
    findMany,
    activationsFindMany,
    ensure,
    reconciler: new MessageReleaseReconciler(
      {
        messageSchedule: { findMany },
        deathTriggeredMessageActivation: { findMany: activationsFindMany },
      } as unknown as PrismaService,
      queue as unknown as MessageReleaseQueue,
    ),
  };
};

describe('MessageReleaseReconciler: death-trigger activations (Step 15)', () => {
  it('queues VERIFIED, still-SCHEDULED activations within the lookahead by dueAt', async () => {
    const dueAt = new Date(NOW.getTime() - DAY);
    const { activationsFindMany, ensure, reconciler } = setup([
      { messageId: 'on-death', dueAt },
    ]);
    await reconciler.reconcile(NOW);
    const { where } = activationsFindMany.mock.calls[0][0];
    expect(where).toEqual({
      dueAt: { lte: new Date(NOW.getTime() + DAY) },
      deathVerificationCase: { status: 'VERIFIED' },
      message: { status: 'SCHEDULED', deletedAt: null },
    });
    expect(ensure).toHaveBeenCalledWith('on-death', dueAt, NOW);
  });
});

describe('MessageReleaseReconciler', () => {
  it('reads only live SCHEDULED FIXED_DATE schedules due within the lookahead', async () => {
    const { findMany, reconciler } = setup();
    await reconciler.reconcile(NOW);
    const { where } = findMany.mock.calls[0][0];
    // Excludes DRAFT, RELEASED, CANCELLED, deleted, ON_DEATH, AFTER_DEATH
    // and anything beyond the window (those stay in PostgreSQL only).
    expect(where).toEqual({
      triggerType: 'FIXED_DATE',
      scheduledFor: { lte: new Date(NOW.getTime() + DAY) },
      message: { status: 'SCHEDULED', deletedAt: null },
    });
  });

  it('ensures a job for each (overdue ones too: ensure queues them at delay 0)', async () => {
    const { ensure, reconciler } = setup();
    expect(await reconciler.reconcile(NOW)).toEqual({
      checked: 2,
      enqueued: 2,
      failed: 0,
    });
    expect(ensure.mock.calls).toEqual([
      ['overdue', rows[0].scheduledFor, NOW],
      ['soon', rows[1].scheduledFor, NOW],
    ]);
  });

  it('running twice is harmless: present jobs are left alone', async () => {
    const { ensure, reconciler } = setup();
    await reconciler.reconcile(NOW);
    ensure.mockResolvedValue(false);
    expect(await reconciler.reconcile(NOW)).toEqual({
      checked: 2,
      enqueued: 0,
      failed: 0,
    });
  });

  it('concurrent calls share one run', async () => {
    const { findMany, reconciler } = setup();
    await Promise.all([reconciler.reconcile(NOW), reconciler.reconcile(NOW)]);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('one Redis failure does not stop the rest or touch PostgreSQL', async () => {
    const { ensure, findMany, reconciler } = setup();
    ensure.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await reconciler.reconcile(NOW)).toEqual({
      checked: 2,
      enqueued: 1,
      failed: 1,
    });
    // Read-only: the only Prisma call is the findMany.
    expect(Object.keys(findMany.mock.calls[0][0])).not.toContain('data');
  });

  it('a database error is logged, not thrown (the next tick retries)', async () => {
    const { findMany, ensure, reconciler } = setup();
    findMany.mockRejectedValue(new Error('db down'));
    expect(await reconciler.reconcile(NOW)).toEqual({
      checked: 0,
      enqueued: 0,
      failed: 0,
    });
    expect(ensure).not.toHaveBeenCalled();
  });

  it('runs at startup and then on an interval; stops on shutdown', () => {
    vi.useFakeTimers();
    try {
      const { findMany, reconciler } = setup();
      reconciler.onApplicationBootstrap();
      expect(findMany).toHaveBeenCalledTimes(1);
      reconciler.onModuleDestroy();
      vi.advanceTimersByTime(5 * 60_000);
      expect(findMany).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { Logger } from '@nestjs/common';
import { DelayedError, type Job } from 'bullmq';
import type { ReleaseNotificationQueue } from '../release-notifications/release-notification-queue.service.js';
import type { MessageReleaseQueue } from './message-release-queue.service.js';
import { MessageReleaseProcessor } from './message-release.processor.js';
import type {
  MessageReleaseService,
  ReleaseOutcome,
} from './message-release.service.js';

const ID = '11111111-1111-4111-8111-111111111111';
const DUE = new Date('2030-12-25T01:00:00Z');

const setup = (outcome?: ReleaseOutcome | Error) => {
  const release = vi.fn();
  if (outcome instanceof Error) release.mockRejectedValue(outcome);
  else release.mockResolvedValue(outcome);
  const notifications = { enqueueForMessage: vi.fn().mockResolvedValue(1) };
  const job = {
    id: `message-release-${ID}`,
    data: { messageId: ID },
    attemptsMade: 0,
    moveToDelayed: vi.fn().mockResolvedValue(undefined),
  };
  return {
    release,
    job,
    notifications,
    processor: new MessageReleaseProcessor(
      { release } as unknown as MessageReleaseService,
      {} as MessageReleaseQueue,
      notifications as unknown as ReleaseNotificationQueue,
    ),
    run: (j: object = job) =>
      new MessageReleaseProcessor(
        { release } as unknown as MessageReleaseService,
        {} as MessageReleaseQueue,
        notifications as unknown as ReleaseNotificationQueue,
      ).process(j as unknown as Job<{ messageId: string }>, 'token'),
  };
};

describe('MessageReleaseProcessor', () => {
  it('queues the Recipient emails after a release; a queue failure never fails the release (Step 24)', async () => {
    const released = {
      result: 'released',
      triggerType: 'FIXED_DATE',
      scheduledFor: DUE,
      grants: 1,
    } as const;
    const ok = setup(released);
    expect(await ok.run()).toBe('released');
    expect(ok.notifications.enqueueForMessage).toHaveBeenCalledWith(ID);
    const down = setup(released);
    down.notifications.enqueueForMessage.mockRejectedValue(
      new Error('redis down'),
    );
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    expect(await down.run()).toBe('released');
    warn.mockRestore();
    // Nothing to email when the release did not happen now.
    const again = setup({ result: 'already_released' });
    await again.run();
    expect(again.notifications.enqueueForMessage).not.toHaveBeenCalled();
  });

  it.each([
    [
      {
        result: 'released',
        triggerType: 'FIXED_DATE',
        scheduledFor: DUE,
        grants: 1,
      },
      'released',
    ],
    [{ result: 'already_released' }, 'already_released'],
    [{ result: 'stale', reason: 'status DRAFT' }, 'stale'],
    [{ result: 'blocked', reason: 'no live recipients' }, 'blocked'],
  ] as const)(
    'delegates to the release service and completes on %o',
    async (outcome, expected) => {
      const { release, run } = setup(outcome);
      expect(await run()).toBe(expected);
      expect(release).toHaveBeenCalledWith(ID);
    },
  );

  it('not due: moves the job back to delayed for the DB time (no release, no retry)', async () => {
    const { job, run } = setup({ result: 'not_due', dueAt: DUE });
    await expect(run()).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledWith(DUE.getTime(), 'token');
  });

  it('database errors are rethrown so BullMQ retries', async () => {
    const boom = new Error('connection lost');
    const { run } = setup(boom);
    await expect(run()).rejects.toBe(boom);
  });

  it('an invalid payload is dropped without touching the database', async () => {
    const { release, run, job } = setup({ result: 'already_released' });
    expect(await run({ ...job, data: { messageId: '../x' } })).toBe('stale');
    expect(await run({ ...job, data: {} })).toBe('stale');
    expect(release).not.toHaveBeenCalled();
  });

  it('logs ids and outcome categories only', async () => {
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    for (const outcome of [
      { result: 'released', scheduledFor: DUE, grants: 1 },
      { result: 'blocked', reason: 'no live recipients' },
      new Error('boom'),
    ] as const) {
      const { run } = setup(outcome as ReleaseOutcome | Error);
      await run().catch(() => undefined);
    }
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    expect(logged).toContain('release_success');
    expect(logged).toContain('recipient_release_grants_created');
    expect(logged).toContain('release_business_block');
    expect(logged).toContain('release_retryable_failure');
    expect(logged).toContain(ID);
    expect(logged).not.toMatch(/textContent|@|http|storageKey/);
    spies.forEach((s) => s.mockRestore());
  });
});

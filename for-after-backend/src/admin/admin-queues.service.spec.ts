import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ReleaseNotificationQueue } from '../release-notifications/release-notification-queue.service.js';
import type { DeathVerificationQueue } from '../death-verification/death-verification-queue.service.js';
import type { MessageReleaseQueue } from '../message-release/message-release-queue.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  AdminQueuesService,
  sanitizeFailedReason,
} from './admin-queues.service.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const actor = {
  type: 'ADMIN' as const,
  userId: '22222222-2222-4222-8222-222222222222',
};

const fakeJob = (over: Record<string, unknown> = {}) => ({
  id: `message-release-${MESSAGE_ID}`,
  name: 'release',
  attemptsMade: 5,
  opts: { attempts: 5 },
  timestamp: 1_790_000_000_000,
  finishedOn: 1_790_000_060_000,
  failedReason:
    'connect ECONNREFUSED redis://default:s3cr3t@cache.internal:6379\n    at Socket.<anonymous> (/app/node_modules/x.js:1:1)',
  stacktrace: ['Error: secret stack'],
  data: { messageId: MESSAGE_ID, textContent: 'Dear Sofia', extra: 'x' },
  getState: vi.fn(async () => 'failed'),
  retry: vi.fn(async () => undefined),
  ...over,
});

const fakeQueue = (job?: ReturnType<typeof fakeJob>) => ({
  getJobCounts: vi.fn(async () => ({
    waiting: 1,
    active: 0,
    delayed: 3,
    prioritized: 0,
    failed: job ? 1 : 0,
    completed: 25,
  })),
  getFailedCount: vi.fn(async () => (job ? 1 : 0)),
  getFailed: vi.fn(async () => (job ? [job] : [])),
  getJob: vi.fn(async (id: string) => (job && id === job.id ? job : undefined)),
});

const setup = (job = fakeJob()) => {
  const release = fakeQueue(job);
  const death = fakeQueue();
  const email = fakeQueue();
  const audit: Record<string, unknown>[] = [];
  const prisma = {
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return { id: 'a' };
      },
    },
  };
  const service = new AdminQueuesService(
    prisma as unknown as PrismaService,
    { queue: release } as unknown as MessageReleaseQueue,
    { queue: death } as unknown as DeathVerificationQueue,
    { queue: email } as unknown as ReleaseNotificationQueue,
  );
  return { service, release, death, job, audit };
};

describe('AdminQueuesService', () => {
  it('summarizes only the allowlisted queues', async () => {
    const { service } = setup();
    const summary = await service.summary();
    expect(summary.map((q) => q.name)).toEqual([
      'message-release',
      'death-verification',
      'email-delivery',
    ]);
    expect(summary[0]).toEqual({
      name: 'message-release',
      waiting: 1,
      active: 0,
      delayed: 3,
      prioritized: 0,
      failed: 1,
      completed: 25,
    });
    expect(await service.failedTotal()).toBe(1);
  });

  it('rejects any queue name outside the allowlist', async () => {
    const { service } = setup();
    for (const name of [
      'bull:message-release',
      'test-message-release',
      '*',
      '',
    ]) {
      await expect(service.failed(name, 1, 25)).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.retry(name, 'x', actor)).rejects.toThrow(
        NotFoundException,
      );
    }
  });

  it('lists failed jobs sanitized: no stack, credentials, content or extra payload', async () => {
    const { service } = setup();
    const res = await service.failed('message-release', 1, 25);
    expect(res.items).toEqual([
      {
        jobId: `message-release-${MESSAGE_ID}`,
        queue: 'message-release',
        name: 'release',
        attemptsMade: 5,
        maxAttempts: 5,
        failedReasonSanitized: 'connect ECONNREFUSED [url]',
        createdAt: new Date(1_790_000_000_000),
        failedAt: new Date(1_790_000_060_000),
        payload: { messageId: MESSAGE_ID },
      },
    ]);
    expect(JSON.stringify(res)).not.toMatch(/s3cr3t|stack|Dear Sofia|internal/);
    expect(res.pagination).toEqual({ page: 1, limit: 25, total: 1, pages: 1 });
  });

  it('sanitizes failed reasons', () => {
    expect(sanitizeFailedReason(undefined)).toBeNull();
    expect(
      sanitizeFailedReason(
        'fetch https://bucket.s3.test/a?X-Amz-Signature=abc failed for lisa@example.com',
      ),
    ).toBe('fetch [url] failed for [email]');
    expect(sanitizeFailedReason('x'.repeat(500))).toHaveLength(200);
  });

  it('retries a failed job with a fresh attempt budget, audited', async () => {
    const { service, job, audit } = setup();
    const res = await service.retry('message-release', job.id, actor);
    expect(res).toEqual({
      queue: 'message-release',
      jobId: job.id,
      state: 'waiting',
    });
    expect(job.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
    });
    expect(audit).toEqual([
      expect.objectContaining({
        eventType: 'FAILED_JOB_RETRIED',
        actorUserId: actor.userId,
        subjectType: 'Job',
        subjectId: job.id,
        metadata: { queue: 'message-release', attemptsMade: 5 },
      }),
    ]);
  });

  it('retry: bad id 400, unknown 404, not failed 409, retry refused 409', async () => {
    const { service, job, audit } = setup();
    await expect(
      service.retry('message-release', 'bad id!', actor),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.retry('message-release', 'message-release-nope', actor),
    ).rejects.toThrow(NotFoundException);
    job.getState.mockResolvedValueOnce('completed');
    await expect(
      service.retry('message-release', job.id, actor),
    ).rejects.toThrow(ConflictException);
    job.retry.mockRejectedValueOnce(new Error('Job is locked redis://u:p@h'));
    await expect(
      service.retry('message-release', job.id, actor),
    ).rejects.toThrow(ConflictException);
    expect(audit).toEqual([]);
  });

  it('Redis errors become a generic 503; dashboard total becomes null', async () => {
    const { service, release } = setup();
    release.getJobCounts.mockRejectedValue(
      new Error('connect ECONNREFUSED redis://default:s3cr3t@cache:6379'),
    );
    const err = await service.summary().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(
      JSON.stringify((err as ServiceUnavailableException).getResponse()),
    ).not.toContain('s3cr3t');
    expect(await service.failedTotal()).toBeNull();
  });
});

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { type Job, UnrecoverableError, type Worker } from 'bullmq';
import { AdminQueuesService } from '../admin/admin-queues.service.js';
import type { DeathVerificationQueue } from '../death-verification/death-verification-queue.service.js';
import {
  type EmailMessage,
  EmailProvider,
  EmailSendError,
} from '../email/email-provider.js';
import type { MessageReleaseQueue } from '../message-release/message-release-queue.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReleaseNotificationQueue } from '../release-notifications/release-notification-queue.service.js';
import {
  DeadLetterService,
  isTerminalFailure,
  safeErrorCode,
  sanitizeFailedReason,
} from './dead-letter.service.js';

const MESSAGE_ID = '11111111-1111-4111-8111-111111111111';
const OCC_ID = '33333333-3333-4333-8333-333333333333';
const CASE_ID = '44444444-4444-4444-8444-444444444444';
const NOTE_ID = '55555555-5555-4555-8555-555555555555';
const OPS = 'ops@example.test';
const actor = {
  type: 'ADMIN' as const,
  userId: '22222222-2222-4222-8222-222222222222',
};

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

// In-memory deadLetterJob with the same unique key and conditional updates.
const fakeDb = () => {
  const rows: Row[] = [];
  const audit: Row[] = [];
  const matches = (r: Row, where: Where) =>
    Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('not' in v) return r[k] !== (v as { not: unknown }).not;
        if ('lt' in v) return (r[k] as Date) < (v as { lt: Date }).lt;
      }
      return r[k] === v;
    });
  const apply = (r: Row, data: Row) => {
    for (const [k, v] of Object.entries(data)) {
      r[k] =
        v && typeof v === 'object' && 'increment' in v
          ? (r[k] as number) + (v as { increment: number }).increment
          : v;
    }
  };
  const prisma = {
    deadLetterJob: {
      createMany: vi.fn(async ({ data }: { data: Row[] }) => {
        let count = 0;
        for (const d of data) {
          if (
            rows.some((r) => r.queueName === d.queueName && r.jobId === d.jobId)
          )
            continue;
          rows.push({
            id: randomUUID(),
            failureCount: 1,
            status: 'OPEN',
            resolution: null,
            requeuedAt: null,
            resolvedAt: null,
            alertStatus: 'PENDING',
            alertedAt: null,
            ...d,
          });
          count++;
        }
        return { count };
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => apply(r, data));
        return { count: hit.length };
      }),
      findUniqueOrThrow: vi.fn(
        async ({ where }: { where: { queueName_jobId: Row } }) => {
          const k = where.queueName_jobId;
          const r = rows.find(
            (x) => x.queueName === k.queueName && x.jobId === k.jobId,
          );
          if (!r) throw new Error('not found');
          return { ...r };
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = rows.find((x) => x.id === where.id);
        return r ? { ...r } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: Where; data: Row }) => {
        const r = rows.find((x) => x.id === where.id)!;
        apply(r, data);
        return r;
      }),
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => (audit.push(data), data),
    },
    message: { findUnique: vi.fn(async () => ({ id: MESSAGE_ID })) },
    messageRecipientRelease: {
      findUnique: vi.fn(async () => ({ messageId: MESSAGE_ID })),
    },
    deathVerificationCase: { findUnique: vi.fn(async () => ({ id: CASE_ID })) },
    releaseNotification: { findUnique: vi.fn(async () => ({ id: NOTE_ID })) },
  };
  return { rows, audit, prisma };
};

class Inbox extends EmailProvider {
  readonly name = 'fake';
  sent: EmailMessage[] = [];
  fail?: EmailSendError;
  send = vi.fn((m: EmailMessage) => {
    if (this.fail) return Promise.reject(this.fail);
    this.sent.push(m);
    return Promise.resolve({ providerMessageId: 'x' });
  });
}

const setup = (alertTo: string | null = OPS) => {
  const db = fakeDb();
  const inbox = new Inbox();
  const config = { get: () => alertTo } as unknown as ConfigService;
  const service = new DeadLetterService(
    db.prisma as unknown as PrismaService,
    inbox,
    config,
  );
  return { ...db, inbox, service };
};

const job = (over: Record<string, unknown> = {}) =>
  ({
    id: `message-release-${MESSAGE_ID}`,
    name: 'release',
    attemptsMade: 5,
    opts: { attempts: 5 },
    finishedOn: 1_790_000_060_000,
    // A payload must never be copied, even if it carried more than ids.
    data: { messageId: MESSAGE_ID, textContent: 'Dear Sofia, private' },
    ...over,
  }) as unknown as Job;

const dbDown = Object.assign(
  new Error('connect ECONNREFUSED postgresql://app:hunter2@db.internal:5432/x'),
  { code: 'ECONNREFUSED' },
);

describe('isTerminalFailure (BullMQ emits failed after every attempt)', () => {
  it('only the last attempt, or an UnrecoverableError, is terminal', () => {
    expect(isTerminalFailure(job({ attemptsMade: 4 }), new Error('x'))).toBe(
      false,
    );
    expect(isTerminalFailure(job(), new Error('x'))).toBe(true);
    expect(
      isTerminalFailure(job({ attemptsMade: 1 }), new UnrecoverableError('x')),
    ).toBe(true);
    expect(isTerminalFailure(job({ attemptsMade: 1, opts: {} }), undefined)).toBe(
      true,
    );
  });
});

describe('sanitizeFailedReason / safeErrorCode', () => {
  it('drops stacks, URLs, emails and secret=value pairs; caps length', () => {
    const out = sanitizeFailedReason(
      'auth failed password=hunter2 api_key: xkeysib-123 Bearer abc.def for lisa@example.com via redis://u:p@h:6379\n at x (/app/y.js:1:1)',
    );
    expect(out).toBe(
      'auth failed password=[redacted] api_key=[redacted] Bearer [redacted] for [email] via [url]',
    );
    expect(out).not.toMatch(/hunter2|xkeysib|abc\.def|lisa|u:p|y\.js/);
    expect(sanitizeFailedReason('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeFailedReason('the session expired')).toBe(
      'the session expired',
    );
  });

  it('keeps a short safe code only', () => {
    expect(safeErrorCode(dbDown)).toBe('ECONNREFUSED');
    expect(safeErrorCode(new EmailSendError('rate_limit_exceeded', true))).toBe(
      'rate_limit_exceeded',
    );
    expect(safeErrorCode(new UnrecoverableError('x'))).toBe(
      'UnrecoverableError',
    );
    expect(safeErrorCode({ code: 'has spaces and secrets' })).toBe(
      'unknown_error',
    );
  });
});

describe('DeadLetterService', () => {
  it('ordinary retry attempts record nothing and alert nobody', async () => {
    const { service, rows, inbox } = setup();
    const worker = new EventEmitter();
    service.watch(worker as unknown as Worker, 'message-release');
    for (let a = 1; a < 5; a++)
      worker.emit('failed', job({ attemptsMade: a }), dbDown);
    await new Promise((r) => setTimeout(r, 10));
    expect(rows).toEqual([]);
    expect(inbox.send).not.toHaveBeenCalled();
  });

  it('exhausted retries → one sanitized row (ids only) and one minimal alert', async () => {
    const { service, rows, inbox } = setup();
    const worker = new EventEmitter();
    service.watch(worker as unknown as Worker, 'message-release');
    worker.emit('failed', job(), dbDown);
    await vi.waitFor(() => expect(rows[0]?.alertStatus).toBe('SENT'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      queueName: 'message-release',
      jobId: `message-release-${MESSAGE_ID}`,
      jobName: 'release',
      entityType: 'Message',
      entityId: MESSAGE_ID,
      attemptsMade: 5,
      errorCode: 'ECONNREFUSED',
      errorMessage: 'connect ECONNREFUSED [url]',
      failedAt: new Date(1_790_000_060_000),
      status: 'OPEN',
      failureCount: 1,
    });
    expect(JSON.stringify(rows)).not.toMatch(/Dear Sofia|hunter2|db\.internal/);
    expect(inbox.sent).toHaveLength(1);
    const [alert] = inbox.sent;
    expect(alert).toMatchObject({
      kind: 'ops-alert',
      to: OPS,
      subject: 'For After queue failure requires attention',
      idempotencyKey: `dead-letter/${String(rows[0].id)}/1`,
    });
    expect(alert.text).toContain('Queue: message-release');
    expect(alert.text).toContain(`Entity: Message ${MESSAGE_ID}`);
    expect(alert.text).toContain('Error code: ECONNREFUSED');
    expect(alert.text).toContain('Action: Review Admin');
    // Not even the sanitized message: the alert is ids + code only.
    expect(alert.text + alert.html).not.toMatch(
      /Dear Sofia|hunter2|internal|ECONNREFUSED \[url\]|password/,
    );
  });

  it('the same failure observed twice (concurrently) → one row, one alert', async () => {
    const { service, rows, inbox } = setup();
    const ids = await Promise.all([
      service.record('message-release', job(), dbDown),
      service.record('message-release', job(), dbDown),
    ]);
    expect(ids.filter(Boolean)).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].failureCount).toBe(1);
    expect(inbox.send).toHaveBeenCalledTimes(1);
  });

  it('a later failure while still OPEN only counts; after resolve it reopens and alerts once more', async () => {
    const { service, rows, inbox } = setup();
    await service.record('message-release', job(), dbDown);
    expect(
      await service.record(
        'message-release',
        job({ finishedOn: 1_790_000_120_000 }),
        dbDown,
      ),
    ).toBeNull();
    expect(rows[0]).toMatchObject({ status: 'OPEN', failureCount: 2 });
    expect(inbox.send).toHaveBeenCalledTimes(1);

    await service.resolve('message-release', String(rows[0].jobId), 'released');
    expect(rows[0]).toMatchObject({
      status: 'RESOLVED',
      resolution: 'released',
    });
    // A stale callback for the old failure does not reopen it.
    await service.record(
      'message-release',
      job({ finishedOn: 1_790_000_120_000 }),
      dbDown,
    );
    expect(rows[0].status).toBe('RESOLVED');

    await service.record(
      'message-release',
      job({ finishedOn: 1_790_000_999_000 }),
      dbDown,
    );
    expect(rows[0]).toMatchObject({
      status: 'OPEN',
      failureCount: 3,
      resolution: null,
    });
    expect(inbox.send).toHaveBeenCalledTimes(2);
    expect(inbox.sent[1].idempotencyKey).toBe(
      `dead-letter/${String(rows[0].id)}/3`,
    );
  });

  it('completion of a job resolves its dead letter with a safe outcome only', async () => {
    const { service, rows } = setup();
    const worker = new EventEmitter();
    service.watch(worker as unknown as Worker, 'email-delivery');
    await service.record(
      'email-delivery',
      job({ id: `release-notification-${NOTE_ID}`, data: { notificationId: NOTE_ID } }),
      new Error('email_send_failed: x'),
    );
    worker.emit('completed', { id: `release-notification-${NOTE_ID}` }, {
      weird: 'object <b>',
    });
    await vi.waitFor(() => expect(rows[0].status).toBe('RESOLVED'));
    expect(rows[0].resolution).toBe('completed');
    expect(rows[0].entityType).toBe('ReleaseNotification');
  });

  it('maps every queue to its canonical entity', async () => {
    const { service, rows } = setup(null);
    await service.record(
      'message-release',
      job({
        id: `message-release-occurrence-${OCC_ID}`,
        data: { messageId: MESSAGE_ID, occurrenceId: OCC_ID },
      }),
      dbDown,
    );
    await service.record(
      'death-verification',
      job({
        id: `death-verification-safeguard-${CASE_ID}`,
        name: 'safeguard',
        data: { caseId: CASE_ID, note: 'private death note' },
      }),
      dbDown,
    );
    expect(rows.map((r) => [r.entityType, r.entityId])).toEqual([
      ['MessageRecipientRelease', OCC_ID],
      ['DeathVerificationCase', CASE_ID],
    ]);
    expect(JSON.stringify(rows)).not.toContain('private death note');
  });

  it('no OPS_ALERT_EMAIL → logged only, NOT_CONFIGURED, nothing sent', async () => {
    const { service, rows, inbox } = setup(null);
    await service.record('message-release', job(), dbDown);
    expect(rows[0].alertStatus).toBe('NOT_CONFIGURED');
    expect(inbox.send).not.toHaveBeenCalled();
  });

  it('email provider down: the email-delivery dead letter is kept, its alert fails once, no loop', async () => {
    const { service, rows, inbox, prisma } = setup();
    inbox.fail = new EmailSendError('network_error', true);
    const id = await service.record(
      'email-delivery',
      job({
        id: `release-notification-${NOTE_ID}`,
        data: { notificationId: NOTE_ID },
      }),
      Object.assign(new Error('email_send_failed: network_error'), {
        code: 'network_error',
      }),
    );
    expect(id).toBe(rows[0].id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      errorCode: 'network_error',
      alertStatus: 'FAILED',
      alertedAt: null,
    });
    // One direct attempt; no second dead letter for the alert itself.
    expect(inbox.send).toHaveBeenCalledTimes(1);
    expect(prisma.deadLetterJob.createMany).toHaveBeenCalledTimes(1);
  });

  it('a database failure while recording never throws into the worker', async () => {
    const { service, prisma, inbox } = setup();
    prisma.deadLetterJob.createMany.mockRejectedValueOnce(dbDown);
    await expect(
      service.record('message-release', job(), dbDown),
    ).resolves.toBeNull();
    expect(inbox.send).not.toHaveBeenCalled();
  });

  it('rejects an OPS_ALERT_EMAIL that is not an address', () => {
    expect(() => setup('not-an-address')).toThrow(/OPS_ALERT_EMAIL/);
  });
});

describe('AdminQueuesService dead letters', () => {
  const admin = () => {
    const ctx = setup();
    const releases = {
      queue: {},
      ensure: vi.fn(async () => true),
      ensureOccurrence: vi.fn(async () => true),
    };
    const deaths = { queue: {}, requeueSafeguard: vi.fn(async () => undefined) };
    const emails = { queue: {}, requeue: vi.fn(async () => undefined) };
    const service = new AdminQueuesService(
      ctx.prisma as unknown as PrismaService,
      releases as unknown as MessageReleaseQueue,
      deaths as unknown as DeathVerificationQueue,
      emails as unknown as ReleaseNotificationQueue,
    );
    return { ...ctx, admin: service, releases, deaths, emails };
  };

  it('retries an OPEN dead letter once via the canonical helper, audited with ids only', async () => {
    const t = admin();
    const id = (await t.service.record('message-release', job(), dbDown))!;
    const res = await t.admin.retryDeadLetter(id, actor);
    expect(res).toMatchObject({ id, status: 'REQUEUED' });
    expect(t.releases.ensure).toHaveBeenCalledWith(MESSAGE_ID, expect.any(Date));
    expect(t.audit).toEqual([
      expect.objectContaining({
        eventType: 'DEAD_LETTER_RETRY_REQUESTED',
        subjectType: 'DeadLetterJob',
        subjectId: id,
        metadata: {
          queue: 'message-release',
          jobId: `message-release-${MESSAGE_ID}`,
          outcome: 'requeued',
        },
      }),
    ]);
    // The run's completion closes it.
    await t.service.resolve('message-release', res.jobId, 'already_released');
    expect(t.rows[0]).toMatchObject({
      status: 'RESOLVED',
      resolution: 'already_released',
    });
  });

  it('two admins retrying at once → one requeue, one 409', async () => {
    const t = admin();
    const id = (await t.service.record('message-release', job(), dbDown))!;
    const results = await Promise.allSettled([
      t.admin.retryDeadLetter(id, actor),
      t.admin.retryDeadLetter(id, actor),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult)
        .reason,
    ).toBeInstanceOf(ConflictException);
    expect(t.releases.ensure).toHaveBeenCalledTimes(1);
    expect(t.audit).toHaveLength(1);
  });

  it('routes each entity to its queue helper', async () => {
    const t = admin();
    const occ = (await t.service.record(
      'message-release',
      job({
        id: `message-release-occurrence-${OCC_ID}`,
        data: { messageId: MESSAGE_ID, occurrenceId: OCC_ID },
      }),
      dbDown,
    ))!;
    const kase = (await t.service.record(
      'death-verification',
      job({ id: `death-verification-safeguard-${CASE_ID}`, data: { caseId: CASE_ID } }),
      dbDown,
    ))!;
    const note = (await t.service.record(
      'email-delivery',
      job({ id: `release-notification-${NOTE_ID}`, data: { notificationId: NOTE_ID } }),
      dbDown,
    ))!;
    for (const id of [occ, kase, note]) await t.admin.retryDeadLetter(id, actor);
    expect(t.releases.ensureOccurrence).toHaveBeenCalledWith(
      MESSAGE_ID,
      OCC_ID,
      expect.any(Date),
      expect.any(Date),
    );
    expect(t.deaths.requeueSafeguard).toHaveBeenCalledWith(
      CASE_ID,
      expect.any(Date),
    );
    expect(t.emails.requeue).toHaveBeenCalledWith(NOTE_ID);
  });

  it('entity gone → RESOLVED as stale, nothing queued', async () => {
    const t = admin();
    t.prisma.message.findUnique.mockResolvedValueOnce(null as never);
    const id = (await t.service.record('message-release', job(), dbDown))!;
    const res = await t.admin.retryDeadLetter(id, actor);
    expect(res).toMatchObject({ status: 'RESOLVED', resolution: 'stale' });
    expect(t.releases.ensure).not.toHaveBeenCalled();
  });

  it('Redis down → back to OPEN, 503, not audited; unknown 404; resolved 409', async () => {
    const t = admin();
    const id = (await t.service.record('message-release', job(), dbDown))!;
    t.releases.ensure.mockRejectedValueOnce(new Error('Redis timeout'));
    await expect(t.admin.retryDeadLetter(id, actor)).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(t.rows[0].status).toBe('OPEN');
    expect(t.audit).toEqual([]);
    await expect(t.admin.retryDeadLetter(randomUUID(), actor)).rejects.toThrow(
      NotFoundException,
    );
    await t.service.resolve('message-release', String(t.rows[0].jobId), 'stale');
    await expect(t.admin.retryDeadLetter(id, actor)).rejects.toThrow(
      ConflictException,
    );
  });
});

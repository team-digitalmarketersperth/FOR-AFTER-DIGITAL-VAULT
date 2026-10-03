import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import {
  EmailSendError,
  type EmailMessage,
  type EmailProvider,
} from '../email/email-provider.js';
import type { EmailConfig } from '../email/email.module.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  NotificationJobData,
  ReleaseNotificationQueue,
} from './release-notification-queue.service.js';
import { ReleaseNotificationProcessor } from './release-notification.processor.js';

const ID = '11111111-1111-4111-8111-111111111111';
const row = (over: object = {}) => ({
  status: 'PENDING',
  grant: {
    recipientEmailNormalized: 'sofia@example.com',
    message: { status: 'RELEASED' },
  },
  ...over,
});

const setup = (
  found: unknown,
  send: () => Promise<{ providerMessageId: string | null }>,
) => {
  const sent: EmailMessage[] = [];
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    releaseNotification: {
      findUnique: vi.fn().mockResolvedValue(found),
      update,
    },
  };
  const email = {
    name: 'fake',
    send: (m: EmailMessage) => (sent.push(m), send()),
  } as EmailProvider;
  const processor = new ReleaseNotificationProcessor(
    prisma as unknown as PrismaService,
    {} as ReleaseNotificationQueue,
    email,
    { settings: { appBaseUrl: 'https://app.example.com' } } as EmailConfig,
  );
  const job = (attemptsMade = 0) =>
    ({
      data: { notificationId: ID },
      attemptsMade,
      opts: { attempts: 5 },
    }) as unknown as Job<NotificationJobData>;
  return { processor, job, sent, update };
};
const ok = () => Promise.resolve({ providerMessageId: 'em_1' });

describe('ReleaseNotificationProcessor', () => {
  beforeEach(() =>
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
  );
  afterEach(() => vi.restoreAllMocks());

  it('sends one minimal email with an idempotency key, then records SENT', async () => {
    const { processor, job, sent, update } = setup(row(), ok);
    expect(await processor.process(job())).toBe('sent');
    expect(sent).toEqual([
      expect.objectContaining({
        kind: 'message-released',
        to: 'sofia@example.com',
        subject: 'A message is waiting for you',
        idempotencyKey: `release-notification/${ID}`,
      }),
    ]);
    expect(sent[0].text).toContain('https://app.example.com/recipient/sign-in');
    expect(update).toHaveBeenCalledWith({
      where: { id: ID },
      data: expect.objectContaining({
        status: 'SENT',
        providerMessageId: 'em_1',
        lastErrorCode: null,
      }),
    });
  });

  it.each([
    ['already sent', row({ status: 'SENT' }), 'already_sent'],
    ['unknown row', null, 'stale'],
    [
      'message not RELEASED',
      row({
        grant: {
          recipientEmailNormalized: 'a@b.co',
          message: { status: 'SCHEDULED' },
        },
      }),
      'stale',
    ],
    [
      'no email on the grant',
      row({
        grant: {
          recipientEmailNormalized: null,
          message: { status: 'RELEASED' },
        },
      }),
      'stale',
    ],
  ])('%s → nothing sent', async (_, found, outcome) => {
    const { processor, job, sent, update } = setup(found, ok);
    expect(await processor.process(job())).toBe(outcome);
    expect(sent).toHaveLength(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('a transient failure is retried: still PENDING until the last attempt, then FAILED', async () => {
    const fail = () =>
      Promise.reject(new EmailSendError('rate_limit_exceeded', true));
    const first = setup(row(), fail);
    await expect(first.processor.process(first.job(0))).rejects.toThrow(
      'email_send_failed: rate_limit_exceeded',
    );
    expect(first.update.mock.calls[0][0].data).toEqual({
      attemptCount: { increment: 1 },
      lastErrorCode: 'rate_limit_exceeded',
    });
    const last = setup(row(), fail);
    await expect(
      last.processor.process(last.job(4)),
    ).rejects.not.toBeInstanceOf(UnrecoverableError);
    expect(last.update.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      lastErrorCode: 'rate_limit_exceeded',
    });
  });

  it('a permanent failure fails at once (no retries) with a safe code only', async () => {
    const { processor, job, update } = setup(row(), () =>
      Promise.reject(new EmailSendError('invalid_from_address', false)),
    );
    const err = await processor.process(job(0)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(String(err)).toBe(
      'UnrecoverableError: email_send_failed: invalid_from_address',
    );
    expect(update.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      lastErrorCode: 'invalid_from_address',
    });
  });
});

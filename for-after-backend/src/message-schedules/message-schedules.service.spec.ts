import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import type { MessageReleaseQueue } from '../message-release/message-release-queue.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CreateMessageScheduleDto } from './dto/create-message-schedule.dto.js';
import { UpdateMessageScheduleDto } from './dto/update-message-schedule.dto.js';
import {
  ALREADY_SCHEDULED,
  checkSchedule,
  MessageSchedulesService,
  NO_RECIPIENTS,
} from './message-schedules.service.js';

const NOW = new Date('2026-09-25T00:00:00Z');
const FUTURE = '2026-12-25T09:00:00+05:30';
const PAST = '2026-01-01T00:00:00Z';

const stored = {
  id: 's1',
  triggerType: 'FIXED_DATE',
  scheduledFor: new Date('2026-12-25T03:30:00Z'),
  afterDeathDays: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('x', {
    code,
    clientVersion: 'test',
  });

// `updated` = rows matched by the conditional status UPDATE.
const setup = (updated = 1) => {
  const message = {
    updateMany: vi.fn().mockResolvedValue({ count: updated }),
    findFirst: vi.fn().mockResolvedValue(null),
    // Composition read inside the transaction: a complete TEXT message.
    findUniqueOrThrow: vi.fn().mockResolvedValue({
      contentType: 'TEXT',
      textContent: 'Fictional text.',
      mediaAssets: [],
    }),
  };
  const messageSchedule = {
    create: vi.fn().mockResolvedValue(stored),
    findFirst: vi.fn().mockResolvedValue(stored),
    update: vi.fn().mockResolvedValue(stored),
    delete: vi.fn().mockResolvedValue(stored),
  };
  const tx = { message, messageSchedule };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  // Never throws (MessageReleaseQueue.sync swallows and logs Redis errors).
  const releaseQueue = { sync: vi.fn().mockResolvedValue(undefined) };
  return {
    message,
    messageSchedule,
    $transaction,
    releaseQueue,
    service: new MessageSchedulesService(
      { ...tx, $transaction } as unknown as PrismaService,
      releaseQueue as unknown as MessageReleaseQueue,
    ),
  };
};

const owned = { id: 'm1', ownerUserId: 'owner-a', deletedAt: null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const errorsFor = async (cls: typeof CreateMessageScheduleDto, body: object) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe('CreateMessageScheduleDto', () => {
  it.each([
    { triggerType: 'FIXED_DATE', scheduledFor: FUTURE },
    { triggerType: 'FIXED_DATE', scheduledFor: '2026-12-25T01:00Z' },
    { triggerType: 'ON_DEATH' },
    { triggerType: 'AFTER_DEATH', afterDeathDays: 0 },
    { triggerType: 'AFTER_DEATH', afterDeathDays: 36_500 },
  ])('accepts the shape of %o', async (body) => {
    expect(await errorsFor(CreateMessageScheduleDto, body)).toEqual([]);
  });

  it.each([
    'NOW',
    'BIRTHDAY',
    'ANNIVERSARY',
    'CUSTOM_EVENT',
    'ANNUAL_AFTER_DEATH',
    'SOMETHING',
    null,
    undefined,
  ])('rejects unsupported triggerType %s', async (triggerType) => {
    expect(
      await errorsFor(CreateMessageScheduleDto, { triggerType }),
    ).toContain('triggerType');
  });

  it.each([
    ['scheduledFor', { scheduledFor: '2026-12-25' }],
    ['scheduledFor', { scheduledFor: '2026-12-25T09:00:00' }],
    ['scheduledFor', { scheduledFor: '2026-02-30T09:00:00Z' }],
    ['scheduledFor', { scheduledFor: 'next christmas' }],
    ['afterDeathDays', { afterDeathDays: -1 }],
    ['afterDeathDays', { afterDeathDays: 1.5 }],
    ['afterDeathDays', { afterDeathDays: '30' }],
    ['afterDeathDays', { afterDeathDays: 36_501 }],
    ['status', { status: 'RELEASED' }],
    ['messageId', { messageId: 'm2' }],
  ])('rejects %s in %o', async (field, patch) => {
    expect(
      await errorsFor(CreateMessageScheduleDto, {
        triggerType: 'FIXED_DATE',
        ...patch,
      }),
    ).toContain(field);
  });

  it('update DTO allows partial input but not a null or unsupported trigger', async () => {
    const errors = (body: object) =>
      errorsFor(
        UpdateMessageScheduleDto as typeof CreateMessageScheduleDto,
        body,
      );
    expect(await errors({})).toEqual([]);
    expect(await errors({ afterDeathDays: 10 })).toEqual([]);
    expect(await errors({ triggerType: null })).toContain('triggerType');
    expect(await errors({ triggerType: 'NOW' })).toContain('triggerType');
  });
});

describe('checkSchedule (complete final state)', () => {
  const date = new Date(FUTURE);
  it.each([
    { triggerType: 'FIXED_DATE', scheduledFor: date, afterDeathDays: null },
    { triggerType: 'ON_DEATH', scheduledFor: null, afterDeathDays: null },
    { triggerType: 'AFTER_DEATH', scheduledFor: null, afterDeathDays: 30 },
    { triggerType: 'AFTER_DEATH', scheduledFor: null, afterDeathDays: 0 },
  ] as const)('accepts %o', (s) => {
    expect(() => checkSchedule(s, NOW)).not.toThrow();
  });

  it.each([
    ['FIXED_DATE without scheduledFor', 'FIXED_DATE', null, null],
    ['FIXED_DATE in the past', 'FIXED_DATE', new Date(PAST), null],
    ['FIXED_DATE exactly now', 'FIXED_DATE', NOW, null],
    ['FIXED_DATE with afterDeathDays', 'FIXED_DATE', date, 10],
    ['ON_DEATH with scheduledFor', 'ON_DEATH', date, null],
    ['ON_DEATH with afterDeathDays', 'ON_DEATH', null, 5],
    ['AFTER_DEATH without afterDeathDays', 'AFTER_DEATH', null, null],
    ['AFTER_DEATH with scheduledFor', 'AFTER_DEATH', date, 30],
    ['NOW (reserved)', 'NOW', null, null],
    ['BIRTHDAY (reserved)', 'BIRTHDAY', null, null],
  ] as const)('rejects %s', (_, triggerType, scheduledFor, afterDeathDays) => {
    expect(() =>
      checkSchedule({ triggerType, scheduledFor, afterDeathDays }, NOW),
    ).toThrow(BadRequestException);
  });
});

describe('MessageSchedulesService', () => {
  it('create: DRAFT → SCHEDULED and inserts the schedule in one transaction', async () => {
    const { message, messageSchedule, $transaction, service } = setup();
    await service.create('owner-a', 'm1', {
      triggerType: 'FIXED_DATE',
      scheduledFor: FUTURE,
    });
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(message.updateMany).toHaveBeenCalledWith({
      where: {
        ...owned,
        status: 'DRAFT',
        schedule: { is: null },
        recipients: { some: { recipient: { deletedAt: null } } },
      },
      data: { status: 'SCHEDULED' },
    });
    const { data, select } = messageSchedule.create.mock.calls[0][0];
    expect(data).toEqual({
      messageId: 'm1',
      triggerType: 'FIXED_DATE',
      scheduledFor: new Date('2026-12-25T03:30:00Z'),
      afterDeathDays: null,
    });
    expect(select).not.toHaveProperty('messageId');
    expect(select).not.toHaveProperty('message');
  });

  it.each([
    [{ triggerType: 'ON_DEATH' }, null, null],
    [{ triggerType: 'AFTER_DEATH', afterDeathDays: 30 }, null, 30],
    [{ triggerType: 'AFTER_DEATH', afterDeathDays: 0 }, null, 0],
  ] as const)('create stores %o as given', async (dto, scheduledFor, days) => {
    const { messageSchedule, service } = setup();
    await service.create('owner-a', 'm1', dto);
    expect(messageSchedule.create.mock.calls[0][0].data).toEqual({
      messageId: 'm1',
      triggerType: dto.triggerType,
      scheduledFor,
      afterDeathDays: days,
    });
  });

  it('create validates composition inside the transaction, after the lock, active media only', async () => {
    const { message, service } = setup();
    await service.create('owner-a', 'm1', { triggerType: 'ON_DEATH' });
    expect(message.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      message.findUniqueOrThrow.mock.invocationCallOrder[0],
    );
    const { where, select } = message.findUniqueOrThrow.mock.calls[0][0];
    expect(where).toEqual({ id: 'm1' });
    expect(select.mediaAssets.where).toEqual({ deletedAt: null });
  });

  it.each([
    [
      'TEXT with blank text',
      { contentType: 'TEXT', textContent: null, mediaAssets: [] },
    ],
    [
      'PHOTO without a photo',
      { contentType: 'PHOTO', textContent: null, mediaAssets: [] },
    ],
    [
      'pending media',
      {
        contentType: 'PHOTO',
        textContent: null,
        mediaAssets: [{ kind: 'PHOTO', status: 'PENDING_UPLOAD' }],
      },
    ],
    [
      'failed media',
      {
        contentType: 'MIXED',
        textContent: 'Hi',
        mediaAssets: [{ kind: 'AUDIO', status: 'FAILED' }],
      },
    ],
  ])(
    'incomplete composition (%s) → 409 and no schedule (rolled back)',
    async (_, composition) => {
      const { message, messageSchedule, service } = setup();
      message.findUniqueOrThrow.mockResolvedValue(composition);
      await expect(
        service.create('owner-a', 'm1', { triggerType: 'ON_DEATH' }),
      ).rejects.toThrow(ConflictException);
      expect(messageSchedule.create).not.toHaveBeenCalled();
    },
  );

  it('a complete PHOTO composition schedules', async () => {
    const { message, messageSchedule, service } = setup();
    message.findUniqueOrThrow.mockResolvedValue({
      contentType: 'PHOTO',
      textContent: null,
      mediaAssets: [{ kind: 'PHOTO', status: 'READY' }],
    });
    await service.create('owner-a', 'm1', { triggerType: 'ON_DEATH' });
    expect(messageSchedule.create).toHaveBeenCalledTimes(1);
  });

  it('schedule PATCH changes triggers only: no composition re-check', async () => {
    const { message, service } = setup();
    await service.update('owner-a', 'm1', { triggerType: 'ON_DEATH' });
    expect(message.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('create rejects an invalid final state before touching the database', async () => {
    const { $transaction, service } = setup();
    await expect(
      service.create('owner-a', 'm1', {
        triggerType: 'FIXED_DATE',
        scheduledFor: PAST,
      }),
    ).rejects.toThrow(BadRequestException);
    expect($transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['another user’s, deleted or missing message', null, NotFoundException],
    [
      'an already scheduled message',
      {
        status: 'SCHEDULED',
        schedule: { id: 's1' },
        _count: { recipients: 1 },
      },
      ConflictException,
    ],
    [
      'a RELEASED message',
      { status: 'RELEASED', schedule: null, _count: { recipients: 1 } },
      ConflictException,
    ],
    [
      'a CANCELLED message',
      { status: 'CANCELLED', schedule: null, _count: { recipients: 1 } },
      ConflictException,
    ],
    [
      'a draft with no live recipient',
      { status: 'DRAFT', schedule: null, _count: { recipients: 0 } },
      BadRequestException,
    ],
  ])('create refuses %s without inserting', async (_, found, error) => {
    const { message, messageSchedule, service } = setup(0);
    message.findFirst.mockResolvedValue(found);
    await expect(
      service.create('owner-b', 'm1', { triggerType: 'ON_DEATH' }),
    ).rejects.toThrow(error);
    expect(messageSchedule.create).not.toHaveBeenCalled();
  });

  it('create: the missing-recipient error is explicit', async () => {
    const { message, service } = setup(0);
    message.findFirst.mockResolvedValue({
      status: 'DRAFT',
      schedule: null,
      _count: { recipients: 0 },
    });
    await expect(
      service.create('owner-a', 'm1', { triggerType: 'ON_DEATH' }),
    ).rejects.toThrow(NO_RECIPIENTS);
  });

  it('create: a concurrent duplicate (unique messageId) becomes 409', async () => {
    const { messageSchedule, service } = setup();
    messageSchedule.create.mockRejectedValue(prismaError('P2002'));
    await expect(
      service.create('owner-a', 'm1', { triggerType: 'ON_DEATH' }),
    ).rejects.toThrow(ALREADY_SCHEDULED);
  });

  it('get is scoped through the owning, live message', async () => {
    const { messageSchedule, service } = setup();
    await service.findForMessage('owner-a', 'm1');
    expect(messageSchedule.findFirst.mock.calls[0][0].where).toEqual({
      messageId: 'm1',
      message: owned,
    });
  });

  it('cross-user get, update and delete are 404', async () => {
    const { messageSchedule, service } = setup(0);
    messageSchedule.findFirst.mockResolvedValue(null);
    await expect(service.findForMessage('owner-b', 'm1')).rejects.toThrow(
      NotFoundException,
    );
    await expect(
      service.update('owner-b', 'm1', { triggerType: 'ON_DEATH' }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.remove('owner-b', 'm1')).rejects.toThrow(
      NotFoundException,
    );
    expect(messageSchedule.update).not.toHaveBeenCalled();
    expect(messageSchedule.delete).not.toHaveBeenCalled();
  });

  it('update FIXED_DATE → ON_DEATH clears scheduledFor, scoped to a SCHEDULED message', async () => {
    const { messageSchedule, service } = setup();
    await service.update('owner-a', 'm1', { triggerType: 'ON_DEATH' });
    const { where, data } = messageSchedule.update.mock.calls[0][0];
    expect(where).toEqual({
      messageId: 'm1',
      message: { ...owned, status: 'SCHEDULED' },
    });
    expect(data).toEqual({
      triggerType: 'ON_DEATH',
      scheduledFor: null,
      afterDeathDays: null,
    });
  });

  it('update ON_DEATH → AFTER_DEATH requires the offset', async () => {
    const { messageSchedule, service } = setup();
    messageSchedule.findFirst.mockResolvedValue({
      ...stored,
      triggerType: 'ON_DEATH',
      scheduledFor: null,
    });
    await expect(
      service.update('owner-a', 'm1', { triggerType: 'AFTER_DEATH' }),
    ).rejects.toThrow(BadRequestException);
    await service.update('owner-a', 'm1', {
      triggerType: 'AFTER_DEATH',
      afterDeathDays: 30,
    });
    expect(messageSchedule.update.mock.calls[0][0].data).toEqual({
      triggerType: 'AFTER_DEATH',
      scheduledFor: null,
      afterDeathDays: 30,
    });
  });

  it('update validates the merged state, not just the sent fields', async () => {
    const { messageSchedule, service } = setup();
    // Stored FIXED_DATE + a stray afterDeathDays: contradictory, not ignored.
    await expect(
      service.update('owner-a', 'm1', { afterDeathDays: 10 }),
    ).rejects.toThrow('FIXED_DATE does not take afterDeathDays.');
    // Clearing the date of a FIXED_DATE schedule leaves it incomplete.
    await expect(
      service.update('owner-a', 'm1', { scheduledFor: null }),
    ).rejects.toThrow('FIXED_DATE requires scheduledFor.');
    expect(messageSchedule.update).not.toHaveBeenCalled();
  });

  it('update and unschedule of a RELEASED/CANCELLED message are 409', async () => {
    const { message, messageSchedule, service } = setup(0);
    messageSchedule.findFirst.mockResolvedValue(null);
    for (const status of ['RELEASED', 'CANCELLED']) {
      message.findFirst.mockResolvedValue({ status });
      await expect(
        service.update('owner-a', 'm1', { triggerType: 'ON_DEATH' }),
      ).rejects.toThrow(ConflictException);
      await expect(service.remove('owner-a', 'm1')).rejects.toThrow(
        ConflictException,
      );
    }
  });

  it('update losing a race (P2025) is 404, not a 500', async () => {
    const { messageSchedule, service } = setup();
    messageSchedule.update.mockRejectedValue(prismaError('P2025'));
    await expect(
      service.update('owner-a', 'm1', { triggerType: 'ON_DEATH' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('unschedule: SCHEDULED → DRAFT and deletes the schedule in one transaction', async () => {
    const { message, messageSchedule, $transaction, service } = setup();
    await service.remove('owner-a', 'm1');
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(message.updateMany).toHaveBeenCalledWith({
      where: { ...owned, status: 'SCHEDULED', schedule: { isNot: null } },
      data: { status: 'DRAFT' },
    });
    expect(messageSchedule.delete).toHaveBeenCalledWith({
      where: { messageId: 'm1' },
    });
  });

  it('unschedule failing inside the transaction propagates (so it rolls back)', async () => {
    const { messageSchedule, service } = setup();
    messageSchedule.delete.mockRejectedValue(new Error('boom'));
    await expect(service.remove('owner-a', 'm1')).rejects.toThrow('boom');
  });

  it('does not swallow unexpected database errors', async () => {
    const { message, messageSchedule, service } = setup();
    message.updateMany.mockRejectedValue(new Error('boom'));
    await expect(
      service.create('owner-a', 'm1', { triggerType: 'ON_DEATH' }),
    ).rejects.toThrow('boom');
    message.updateMany.mockResolvedValue({ count: 1 });
    messageSchedule.update.mockRejectedValue(prismaError('P2003'));
    await expect(
      service.update('owner-a', 'm1', { triggerType: 'ON_DEATH' }),
    ).rejects.toThrow(Prisma.PrismaClientKnownRequestError);
    expect(message.findFirst).not.toHaveBeenCalled();
  });
});

// Step 12: PostgreSQL first, then the release queue (docs/message-release.md).
describe('MessageSchedulesService release-queue sync', () => {
  const fixed = { triggerType: 'FIXED_DATE' as const, scheduledFor: FUTURE };

  it('create FIXED_DATE syncs the queue after the transaction committed', async () => {
    const { $transaction, releaseQueue, service } = setup();
    await service.create('owner-a', 'm1', fixed);
    expect(releaseQueue.sync).toHaveBeenCalledWith('m1', stored);
    expect($transaction.mock.invocationCallOrder[0]).toBeLessThan(
      releaseQueue.sync.mock.invocationCallOrder[0],
    );
  });

  it('create ON_DEATH / AFTER_DEATH: sync is told the trigger (it queues nothing)', async () => {
    const { messageSchedule, releaseQueue, service } = setup();
    const onDeath = { ...stored, triggerType: 'ON_DEATH', scheduledFor: null };
    messageSchedule.create.mockResolvedValue(onDeath);
    await service.create('owner-a', 'm1', { triggerType: 'ON_DEATH' });
    expect(releaseQueue.sync).toHaveBeenCalledWith('m1', onDeath);
  });

  it('a failed or refused create never touches the queue', async () => {
    const { message, messageSchedule, releaseQueue, service } = setup(0);
    message.findFirst.mockResolvedValue(null);
    await expect(service.create('owner-a', 'm1', fixed)).rejects.toThrow();
    const ok = setup();
    ok.messageSchedule.create.mockRejectedValue(new Error('db down'));
    await expect(ok.service.create('owner-a', 'm1', fixed)).rejects.toThrow();
    expect(releaseQueue.sync).not.toHaveBeenCalled();
    expect(ok.releaseQueue.sync).not.toHaveBeenCalled();
    expect(messageSchedule.create).not.toHaveBeenCalled();
  });

  it('a Redis failure after commit leaves the schedule created', async () => {
    // sync() never throws; even if it did resolve late, create returns the row.
    const { releaseQueue, service } = setup();
    releaseQueue.sync.mockImplementation(async () => undefined);
    await expect(service.create('owner-a', 'm1', fixed)).resolves.toBe(stored);
  });

  it('PATCH locks the message, writes, then syncs the new timing', async () => {
    const { message, messageSchedule, releaseQueue, service } = setup();
    const later = { ...stored, scheduledFor: new Date('2027-01-01T00:00:00Z') };
    messageSchedule.update.mockResolvedValue(later);
    await service.update('owner-a', 'm1', {
      scheduledFor: '2027-01-01T00:00:00Z',
    });
    expect(message.updateMany).toHaveBeenCalledWith({
      where: { ...owned, status: 'SCHEDULED' },
      data: { status: 'SCHEDULED' },
    });
    expect(message.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      messageSchedule.update.mock.invocationCallOrder[0],
    );
    expect(releaseQueue.sync).toHaveBeenCalledWith('m1', later);
  });

  it('PATCH FIXED_DATE → ON_DEATH syncs (which removes the stale job)', async () => {
    const { messageSchedule, releaseQueue, service } = setup();
    const onDeath = { ...stored, triggerType: 'ON_DEATH', scheduledFor: null };
    messageSchedule.update.mockResolvedValue(onDeath);
    await service.update('owner-a', 'm1', { triggerType: 'ON_DEATH' });
    expect(releaseQueue.sync).toHaveBeenCalledWith('m1', onDeath);
  });

  it('PATCH ON_DEATH → FIXED_DATE syncs the new job', async () => {
    const { messageSchedule, releaseQueue, service } = setup();
    messageSchedule.findFirst.mockResolvedValue({
      ...stored,
      triggerType: 'ON_DEATH',
      scheduledFor: null,
    });
    await service.update('owner-a', 'm1', fixed);
    expect(messageSchedule.update.mock.calls[0][0].data).toMatchObject({
      triggerType: 'FIXED_DATE',
    });
    expect(releaseQueue.sync).toHaveBeenCalledWith('m1', stored);
  });

  it('PATCH that loses the lock (released/unscheduled meanwhile) is refused, no sync', async () => {
    const { message, messageSchedule, releaseQueue, service } = setup(0);
    message.findFirst.mockResolvedValue({ status: 'RELEASED' });
    await expect(
      service.update('owner-a', 'm1', { triggerType: 'ON_DEATH' }),
    ).rejects.toThrow(ConflictException);
    expect(messageSchedule.update).not.toHaveBeenCalled();
    expect(releaseQueue.sync).not.toHaveBeenCalled();
  });

  it('unschedule removes the job best-effort after the DRAFT transition', async () => {
    const { $transaction, releaseQueue, service } = setup();
    await service.remove('owner-a', 'm1');
    expect(releaseQueue.sync).toHaveBeenCalledWith('m1', null);
    expect($transaction.mock.invocationCallOrder[0]).toBeLessThan(
      releaseQueue.sync.mock.invocationCallOrder[0],
    );
  });

  it('refused unschedule (RELEASED) does not touch the queue', async () => {
    const { message, releaseQueue, service } = setup(0);
    message.findFirst.mockResolvedValue({ status: 'RELEASED' });
    await expect(service.remove('owner-a', 'm1')).rejects.toThrow(
      ConflictException,
    );
    expect(releaseQueue.sync).not.toHaveBeenCalled();
  });
});

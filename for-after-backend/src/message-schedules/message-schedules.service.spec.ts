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
  ALREADY_RELEASED_TO_SOME,
  ALREADY_SCHEDULED,
  checkSchedule,
  MessageSchedulesService,
  MISSING_BIRTHDAY,
  NO_RECIPIENTS,
} from './message-schedules.service.js';

const NOW = new Date('2026-09-25T00:00:00Z');
const FUTURE = '2026-12-25T09:00:00+05:30';
const PAST = '2026-01-01T00:00:00Z';

// Phase 16 fields, all unset (FIXED_DATE / ON_DEATH / AFTER_DEATH / NOW).
const nulls = {
  timezone: null,
  localTime: null,
  annualMonth: null,
  annualDay: null,
  eventDate: null,
  eventLabel: null,
};
// A complete state for checkSchedule.
const st = (triggerType: string, fields: object = {}) =>
  ({
    triggerType,
    scheduledFor: null,
    afterDeathDays: null,
    ...nulls,
    ...fields,
  }) as Parameters<typeof checkSchedule>[0];

const stored = {
  id: 's1',
  triggerType: 'FIXED_DATE',
  scheduledFor: new Date('2026-12-25T03:30:00Z'),
  afterDeathDays: null,
  ...nulls,
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
  const messageRecipientRelease = {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([]),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const messageRecipient = {
    count: vi.fn().mockResolvedValue(0),
    findMany: vi.fn().mockResolvedValue([]),
  };
  const messageRelease = { count: vi.fn().mockResolvedValue(0) };
  const recipientMessageAccessGrant = { count: vi.fn().mockResolvedValue(0) };
  const tx = {
    recipientMessageAccessGrant,
    message,
    messageSchedule,
    messageRecipientRelease,
    messageRecipient,
    messageRelease,
  };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  // Never throws (MessageReleaseQueue.sync swallows and logs Redis errors).
  const releaseQueue = {
    sync: vi.fn().mockResolvedValue(undefined),
    syncOccurrences: vi.fn().mockResolvedValue(undefined),
  };
  return {
    message,
    messageSchedule,
    messageRecipientRelease,
    messageRecipient,
    messageRelease,
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
    { triggerType: 'NOW' },
    {
      triggerType: 'BIRTHDAY',
      timezone: 'Australia/Perth',
      localTime: '09:00',
    },
    {
      triggerType: 'ANNIVERSARY',
      timezone: 'Asia/Kolkata',
      localTime: '23:59',
      annualMonth: 2,
      annualDay: 29,
    },
    {
      triggerType: 'CUSTOM_EVENT',
      timezone: 'America/New_York',
      localTime: '00:00',
      eventDate: '2027-06-01',
      eventLabel: 'Graduation day',
    },
    {
      triggerType: 'ANNUAL_AFTER_DEATH',
      timezone: 'Australia/Sydney',
      localTime: '10:30',
    },
  ])('accepts the shape of %o', async (body) => {
    expect(await errorsFor(CreateMessageScheduleDto, body)).toEqual([]);
  });

  it.each(['SOMETHING', 'now', null, undefined])(
    'rejects unknown triggerType %s',
    async (triggerType) => {
      expect(
        await errorsFor(CreateMessageScheduleDto, { triggerType }),
      ).toContain('triggerType');
    },
  );

  it.each([
    ['localTime', { localTime: '9:00' }],
    ['localTime', { localTime: '24:00' }],
    ['localTime', { localTime: '09:00:00' }],
    ['annualMonth', { annualMonth: 13 }],
    ['annualDay', { annualDay: 0 }],
    ['eventDate', { eventDate: '2027-02-30' }],
    ['eventDate', { eventDate: '2027-06-01T00:00:00Z' }],
    ['eventLabel', { eventLabel: '<script>alert(1)</script>' }],
    ['eventLabel', { eventLabel: '   ' }],
    ['eventLabel', { eventLabel: 'x'.repeat(101) }],
    ['eventLabel', { eventLabel: 'line\u0000break' }],
    ['timezone', { timezone: 'x'.repeat(65) }],
  ])('rejects %s in %o', async (field, patch) => {
    expect(
      await errorsFor(CreateMessageScheduleDto, {
        triggerType: 'CUSTOM_EVENT',
        ...patch,
      }),
    ).toContain(field);
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
    expect(await errors({ triggerType: 'NOW' })).toEqual([]);
    expect(await errors({ triggerType: 'LATER' })).toContain('triggerType');
  });
});

describe('checkSchedule (complete final state)', () => {
  const date = new Date(FUTURE);
  const tz = { timezone: 'Australia/Perth', localTime: '09:00' };
  it.each([
    st('FIXED_DATE', { scheduledFor: date }),
    st('ON_DEATH'),
    st('AFTER_DEATH', { afterDeathDays: 30 }),
    st('AFTER_DEATH', { afterDeathDays: 0 }),
    st('NOW'),
    st('BIRTHDAY', tz),
    st('ANNUAL_AFTER_DEATH', tz),
    st('ANNIVERSARY', { ...tz, annualMonth: 2, annualDay: 29 }),
  ])('accepts %o', (s) => {
    expect(() => checkSchedule(s, NOW)).not.toThrow();
  });

  it.each([
    ['FIXED_DATE without scheduledFor', st('FIXED_DATE')],
    [
      'FIXED_DATE in the past',
      st('FIXED_DATE', { scheduledFor: new Date(PAST) }),
    ],
    ['FIXED_DATE exactly now', st('FIXED_DATE', { scheduledFor: NOW })],
    [
      'FIXED_DATE with afterDeathDays',
      st('FIXED_DATE', { scheduledFor: date, afterDeathDays: 10 }),
    ],
    [
      'FIXED_DATE with a timezone',
      st('FIXED_DATE', { scheduledFor: date, ...tz }),
    ],
    ['ON_DEATH with scheduledFor', st('ON_DEATH', { scheduledFor: date })],
    ['ON_DEATH with afterDeathDays', st('ON_DEATH', { afterDeathDays: 5 })],
    ['AFTER_DEATH without afterDeathDays', st('AFTER_DEATH')],
    [
      'AFTER_DEATH with scheduledFor',
      st('AFTER_DEATH', { scheduledFor: date, afterDeathDays: 30 }),
    ],
    ['NOW with a date', st('NOW', { scheduledFor: date })],
    ['NOW with birthday fields', st('NOW', tz)],
    [
      'BIRTHDAY without a time',
      st('BIRTHDAY', { timezone: 'Australia/Perth' }),
    ],
    [
      'BIRTHDAY with scheduledFor',
      st('BIRTHDAY', { ...tz, scheduledFor: date }),
    ],
    [
      'BIRTHDAY with a fixed offset',
      st('BIRTHDAY', { ...tz, timezone: '+08:00' }),
    ],
    [
      'BIRTHDAY with UTC (not a zone name)',
      st('BIRTHDAY', { ...tz, timezone: 'UTC' }),
    ],
    [
      'BIRTHDAY with a made-up zone',
      st('BIRTHDAY', { ...tz, timezone: 'Mars/Olympus' }),
    ],
    ['ANNIVERSARY without month/day', st('ANNIVERSARY', tz)],
    [
      'ANNIVERSARY 30 Feb',
      st('ANNIVERSARY', { ...tz, annualMonth: 2, annualDay: 30 }),
    ],
    [
      'ANNIVERSARY 31 Apr',
      st('ANNIVERSARY', { ...tz, annualMonth: 4, annualDay: 31 }),
    ],
    [
      'ANNUAL_AFTER_DEATH with afterDeathDays',
      st('ANNUAL_AFTER_DEATH', { ...tz, afterDeathDays: 1 }),
    ],
    [
      'ANNUAL_AFTER_DEATH without a zone',
      st('ANNUAL_AFTER_DEATH', { localTime: '09:00' }),
    ],
    [
      'CUSTOM_EVENT with a client scheduledFor',
      st('CUSTOM_EVENT', {
        ...tz,
        eventDate: new Date('2027-01-01'),
        eventLabel: 'Wedding',
        scheduledFor: date,
      }),
    ],
    [
      'CUSTOM_EVENT without a label',
      st('CUSTOM_EVENT', { ...tz, eventDate: new Date('2027-01-01') }),
    ],
    [
      'CUSTOM_EVENT in the past',
      st('CUSTOM_EVENT', {
        ...tz,
        eventDate: new Date('2026-09-24'),
        eventLabel: 'Wedding',
      }),
    ],
  ])('rejects %s', (_, s) => {
    expect(() => checkSchedule(s, NOW)).toThrow(BadRequestException);
  });

  it('CUSTOM_EVENT: local date + time + IANA zone -> derived UTC scheduledFor', () => {
    const out = checkSchedule(
      st('CUSTOM_EVENT', {
        timezone: 'Australia/Perth',
        localTime: '09:00',
        eventDate: new Date('2026-12-25'),
        eventLabel: 'Christmas',
      }),
      NOW,
    );
    expect(out.scheduledFor).toEqual(new Date('2026-12-25T01:00:00Z'));
  });

  it('CUSTOM_EVENT later today in its own zone is still the future', () => {
    // NOW = 2026-09-25T00:00Z = 08:00 in Perth; 09:00 Perth is in an hour.
    expect(() =>
      checkSchedule(
        st('CUSTOM_EVENT', {
          timezone: 'Australia/Perth',
          localTime: '09:00',
          eventDate: new Date('2026-09-25'),
          eventLabel: 'Today',
        }),
        NOW,
      ),
    ).not.toThrow();
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
      ...nulls,
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
      ...nulls,
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
    expect(await service.findForMessage('owner-a', 'm1')).toEqual({
      ...stored,
      releasedRecipientCount: 0,
    });
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
      ...nulls,
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
      ...nulls,
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
    await expect(service.create('owner-a', 'm1', fixed)).resolves.toEqual({
      ...stored,
      releasedRecipientCount: 0,
    });
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

// Phase 16: NOW and the per-Recipient recurring triggers.
describe('MessageSchedulesService Phase 16 triggers', () => {
  const birthdayDto = {
    triggerType: 'BIRTHDAY' as const,
    timezone: 'Australia/Perth',
    localTime: '09:00',
  };

  it('NOW: composition checked in the transaction, queued only after commit', async () => {
    const { message, messageSchedule, $transaction, releaseQueue, service } =
      setup();
    const now = { ...stored, triggerType: 'NOW', scheduledFor: null };
    messageSchedule.create.mockResolvedValue(now);
    await service.create('owner-a', 'm1', { triggerType: 'NOW' });
    expect(message.findUniqueOrThrow).toHaveBeenCalled();
    expect(messageSchedule.create.mock.calls[0][0].data).toEqual({
      messageId: 'm1',
      triggerType: 'NOW',
      scheduledFor: null,
      afterDeathDays: null,
      ...nulls,
    });
    expect(releaseQueue.sync).toHaveBeenCalledWith('m1', now);
    expect($transaction.mock.invocationCallOrder[0]).toBeLessThan(
      releaseQueue.sync.mock.invocationCallOrder[0],
    );
    // Never released here: the status UPDATE only ever sets SCHEDULED.
    for (const [arg] of message.updateMany.mock.calls) {
      expect(arg.data).toEqual({ status: 'SCHEDULED' });
    }
  });

  it('NOW with an incomplete composition: 409, nothing queued', async () => {
    const { message, releaseQueue, service } = setup();
    message.findUniqueOrThrow.mockResolvedValue({
      contentType: 'TEXT',
      textContent: null,
      mediaAssets: [],
    });
    await expect(
      service.create('owner-a', 'm1', { triggerType: 'NOW' }),
    ).rejects.toThrow(ConflictException);
    expect(releaseQueue.sync).not.toHaveBeenCalled();
  });

  it('BIRTHDAY: refuses when a live assigned Recipient has no birthday (no silent skip)', async () => {
    const { messageRecipient, messageRecipientRelease, releaseQueue, service } =
      setup();
    messageRecipient.count.mockResolvedValue(1);
    await expect(service.create('owner-a', 'm1', birthdayDto)).rejects.toThrow(
      MISSING_BIRTHDAY,
    );
    expect(messageRecipient.count.mock.calls[0][0].where).toEqual({
      messageId: 'm1',
      recipient: { deletedAt: null, birthday: null },
    });
    expect(messageRecipientRelease.createMany).not.toHaveBeenCalled();
    expect(releaseQueue.syncOccurrences).not.toHaveBeenCalled();
  });

  it('BIRTHDAY: one first occurrence per live Recipient on their own birthday', async () => {
    const { messageRecipient, messageRecipientRelease, releaseQueue, service } =
      setup();
    messageRecipient.findMany.mockResolvedValue([
      { recipientId: 'ra', recipient: { birthday: new Date('1990-03-10') } },
      { recipientId: 'rb', recipient: { birthday: new Date('2001-07-24') } },
    ]);
    const pending = [{ id: 'o1', dueAt: new Date('2027-03-10T01:00:00Z') }];
    messageRecipientRelease.findMany.mockResolvedValue(pending);
    await service.create('owner-a', 'm1', birthdayDto);
    // Live Recipients only.
    expect(messageRecipient.findMany.mock.calls[0][0].where).toEqual({
      messageId: 'm1',
      recipient: { deletedAt: null },
    });
    expect(messageRecipientRelease.createMany).toHaveBeenCalledWith({
      data: [
        {
          messageId: 'm1',
          recipientId: 'ra',
          occurrenceYear: 2027,
          dueAt: new Date('2027-03-10T01:00:00Z'),
        },
        {
          messageId: 'm1',
          recipientId: 'rb',
          occurrenceYear: 2027,
          dueAt: new Date('2027-07-24T01:00:00Z'),
        },
      ],
      skipDuplicates: true,
    });
    expect(releaseQueue.syncOccurrences).toHaveBeenCalledWith('m1', pending);
  });

  it('ANNUAL_AFTER_DEATH: scheduling creates no occurrence (only a verified death does)', async () => {
    const { messageRecipient, messageRecipientRelease, service } = setup();
    await service.create('owner-a', 'm1', {
      triggerType: 'ANNUAL_AFTER_DEATH',
      timezone: 'Australia/Perth',
      localTime: '09:00',
    });
    expect(messageRecipient.findMany).not.toHaveBeenCalled();
    expect(messageRecipientRelease.createMany).not.toHaveBeenCalled();
  });

  it('CUSTOM_EVENT stores the derived UTC time with its local intent', async () => {
    const { messageSchedule, service } = setup();
    await service.create('owner-a', 'm1', {
      triggerType: 'CUSTOM_EVENT',
      timezone: 'Australia/Perth',
      localTime: '09:00',
      eventDate: '2027-04-10',
      eventLabel: 'Graduation',
    });
    expect(messageSchedule.create.mock.calls[0][0].data).toMatchObject({
      triggerType: 'CUSTOM_EVENT',
      scheduledFor: new Date('2027-04-10T01:00:00Z'),
      eventDate: new Date('2027-04-10'),
      timezone: 'Australia/Perth',
      localTime: '09:00',
      eventLabel: 'Graduation',
    });
  });

  it('PATCH re-derives CUSTOM_EVENT time from the merged local fields', async () => {
    const { messageSchedule, service } = setup();
    messageSchedule.findFirst.mockResolvedValue({
      ...stored,
      triggerType: 'CUSTOM_EVENT',
      scheduledFor: new Date('2027-04-10T01:00:00Z'),
      timezone: 'Australia/Perth',
      localTime: '09:00',
      eventDate: new Date('2027-04-10'),
      eventLabel: 'Graduation',
    });
    await service.update('owner-a', 'm1', { localTime: '18:00' });
    expect(messageSchedule.update.mock.calls[0][0].data.scheduledFor).toEqual(
      new Date('2027-04-10T10:00:00Z'),
    );
  });

  it('PATCH and unschedule refused once any Recipient was released (recurring)', async () => {
    const { messageRelease, messageSchedule, releaseQueue, service } = setup();
    messageRelease.count.mockResolvedValue(1);
    messageSchedule.findFirst.mockResolvedValue({
      ...stored,
      triggerType: 'BIRTHDAY',
      scheduledFor: null,
      timezone: 'Australia/Perth',
      localTime: '09:00',
    });
    await expect(
      service.update('owner-a', 'm1', { localTime: '10:00' }),
    ).rejects.toThrow(ALREADY_RELEASED_TO_SOME);
    await expect(service.remove('owner-a', 'm1')).rejects.toThrow(
      ALREADY_RELEASED_TO_SOME,
    );
    expect(messageSchedule.update).not.toHaveBeenCalled();
    expect(messageSchedule.delete).not.toHaveBeenCalled();
    expect(releaseQueue.sync).not.toHaveBeenCalled();
  });

  it('unschedule drops pending occurrences with the schedule', async () => {
    const { messageRecipientRelease, messageSchedule, service } = setup();
    await service.remove('owner-a', 'm1');
    expect(messageRecipientRelease.deleteMany).toHaveBeenCalledWith({
      where: { messageId: 'm1' },
    });
    expect(messageSchedule.delete).toHaveBeenCalled();
  });

  it('PATCH BIRTHDAY to FIXED_DATE drops pending occurrences', async () => {
    const { messageRecipientRelease, messageSchedule, service } = setup();
    messageSchedule.findFirst.mockResolvedValue({
      ...stored,
      triggerType: 'BIRTHDAY',
      scheduledFor: null,
      timezone: 'Australia/Perth',
      localTime: '09:00',
    });
    await service.update('owner-a', 'm1', {
      triggerType: 'FIXED_DATE',
      scheduledFor: FUTURE,
    });
    expect(messageRecipientRelease.deleteMany).toHaveBeenCalledWith({
      where: { messageId: 'm1', releasedAt: null },
    });
    expect(messageSchedule.update.mock.calls[0][0].data).toEqual({
      triggerType: 'FIXED_DATE',
      scheduledFor: new Date(FUTURE),
      afterDeathDays: null,
      ...nulls,
    });
  });
});

import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { MessageReleaseService } from './message-release.service.js';

// Phase 16: one Recipient's yearly occurrence (BIRTHDAY / ANNIVERSARY /
// ANNUAL_AFTER_DEATH). Real concurrency is covered by the e2e suite.
const OCC = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';
const REL = '33333333-3333-4333-8333-333333333333';
const SOFIA = '44444444-4444-4444-8444-444444444444';
const DUE = new Date('2027-03-10T01:00:00Z'); // 09:00 Perth
const NOW = new Date('2027-03-10T01:00:05Z');

const birthday = {
  triggerType: 'BIRTHDAY',
  timezone: 'Australia/Perth',
  localTime: '09:00',
  annualMonth: null,
  annualDay: null,
};

const setup = ({
  status = 'SCHEDULED' as string | null,
  occ = {
    recipientId: SOFIA,
    occurrenceYear: 2027,
    dueAt: DUE,
    releasedAt: null as Date | null,
  } as object | null,
  schedule = birthday as object | null,
  deathActivation = null as object | null,
  release = null as { id: string } | null,
  assigned = { recipient: { birthday: new Date('1990-03-10') } } as
    object | null,
  email = 'sofia@example.com' as string | null,
} = {}) => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(status ? [{ status }] : []),
    messageRecipientRelease: {
      findUnique: vi
        .fn()
        .mockResolvedValueOnce(occ ? { messageId: MSG } : null)
        .mockResolvedValue(occ),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    message: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ schedule, deathActivation, release }),
      update: vi.fn(),
    },
    messageRecipient: {
      findFirst: vi.fn().mockResolvedValue(assigned),
      findMany: vi.fn().mockResolvedValue([
        {
          recipientId: SOFIA,
          recipient: { email: 'Sofia@Example.com', mobile: null },
        },
      ]),
    },
    messageRelease: { create: vi.fn().mockResolvedValue({ id: REL }) },
    recipientMessageAccessGrant: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: 'g1', recipientEmailNormalized: email }),
    },
    releaseNotification: { create: vi.fn().mockResolvedValue({}) },
  };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  return {
    tx,
    service: new MessageReleaseService({
      $transaction,
    } as unknown as PrismaService),
  };
};

const nothingWritten = (tx: ReturnType<typeof setup>['tx']) => {
  expect(tx.messageRelease.create).not.toHaveBeenCalled();
  expect(tx.recipientMessageAccessGrant.createMany).not.toHaveBeenCalled();
  expect(tx.releaseNotification.create).not.toHaveBeenCalled();
  expect(tx.messageRecipientRelease.update).not.toHaveBeenCalled();
  expect(tx.message.update).not.toHaveBeenCalled();
};

describe('MessageReleaseService.releaseOccurrence', () => {
  it('first occurrence: MessageRelease + this Recipient’s grant + email + next year; Message stays SCHEDULED', async () => {
    const { tx, service } = setup();
    expect(await service.releaseOccurrence(OCC, NOW)).toEqual({
      result: 'occurrence_released',
      triggerType: 'BIRTHDAY',
      scheduledFor: DUE,
      grants: 1,
      next: new Date('2028-03-10T01:00:00Z'),
    });
    expect(tx.messageRelease.create).toHaveBeenCalledWith({
      data: {
        messageId: MSG,
        triggerType: 'BIRTHDAY',
        scheduledFor: DUE,
        releasedAt: NOW,
      },
      select: { id: true },
    });
    // Only this Recipient is granted.
    expect(tx.messageRecipient.findMany.mock.calls[0][0].where).toEqual({
      messageId: MSG,
      recipient: { deletedAt: null },
      recipientId: SOFIA,
    });
    expect(tx.messageRecipientRelease.update).toHaveBeenCalledWith({
      where: { id: OCC },
      data: { releasedAt: NOW },
    });
    expect(tx.releaseNotification.create).toHaveBeenCalledWith({
      data: { grantId: 'g1', occurrenceId: OCC },
    });
    expect(tx.messageRecipientRelease.createMany).toHaveBeenCalledWith({
      data: [
        {
          messageId: MSG,
          recipientId: SOFIA,
          occurrenceYear: 2028,
          dueAt: new Date('2028-03-10T01:00:00Z'),
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it('later occurrence reuses the MessageRelease (grant is idempotent), new email only', async () => {
    const { tx, service } = setup({ release: { id: REL } });
    tx.recipientMessageAccessGrant.createMany.mockResolvedValue({ count: 0 });
    const out = await service.releaseOccurrence(OCC, NOW);
    expect(out).toMatchObject({ result: 'occurrence_released', grants: 0 });
    expect(tx.messageRelease.create).not.toHaveBeenCalled();
    expect(tx.releaseNotification.create).toHaveBeenCalledTimes(1);
  });

  it('a Recipient without an email gets the grant but no notification row', async () => {
    const { tx, service } = setup({ email: null });
    await service.releaseOccurrence(OCC, NOW);
    expect(tx.recipientMessageAccessGrant.createMany).toHaveBeenCalled();
    expect(tx.releaseNotification.create).not.toHaveBeenCalled();
  });

  it('already released occurrence (duplicate job) → no writes', async () => {
    const { tx, service } = setup({
      occ: {
        recipientId: SOFIA,
        occurrenceYear: 2027,
        dueAt: DUE,
        releasedAt: NOW,
      },
    });
    expect(await service.releaseOccurrence(OCC, NOW)).toEqual({
      result: 'already_released',
    });
    nothingWritten(tx);
  });

  it('early job → not_due at the stored time, no writes', async () => {
    const { tx, service } = setup();
    expect(
      await service.releaseOccurrence(OCC, new Date('2027-03-10T00:59:59Z')),
    ).toEqual({ result: 'not_due', dueAt: DUE });
    nothingWritten(tx);
  });

  it.each([
    ['missing occurrence (unscheduled)', { occ: null }],
    ['unscheduled message (DRAFT)', { status: 'DRAFT' }],
    ['deleted message', { status: null }],
    [
      'trigger changed to FIXED_DATE',
      { schedule: { ...birthday, triggerType: 'FIXED_DATE' } },
    ],
  ])('stale: %s → no writes', async (_, over) => {
    const { tx, service } = setup(over);
    expect(await service.releaseOccurrence(OCC, NOW)).toMatchObject({
      result: 'stale',
    });
    nothingWritten(tx);
  });

  it('deleted Recipient: no grant, no email, no future years (pending row dropped)', async () => {
    const { tx, service } = setup({ assigned: null });
    expect(await service.releaseOccurrence(OCC, NOW)).toEqual({
      result: 'stale',
      reason: 'recipient removed',
    });
    expect(tx.messageRecipientRelease.delete).toHaveBeenCalledWith({
      where: { id: OCC },
    });
    expect(tx.messageRecipientRelease.createMany).not.toHaveBeenCalled();
    nothingWritten(tx);
  });

  const annual = { ...birthday, triggerType: 'ANNUAL_AFTER_DEATH' };
  it.each([
    ['no activation (reported only)', null],
    [
      'case not VERIFIED',
      {
        triggerType: 'ANNUAL_AFTER_DEATH',
        deathVerificationCase: {
          status: 'SAFEGUARD_ACTIVE',
          verifiedDeathAt: null,
        },
      },
    ],
    [
      'case READY_FOR_REVIEW',
      {
        triggerType: 'ANNUAL_AFTER_DEATH',
        deathVerificationCase: {
          status: 'READY_FOR_REVIEW',
          verifiedDeathAt: null,
        },
      },
    ],
  ])(
    'ANNUAL_AFTER_DEATH never releases with %s',
    async (_, deathActivation) => {
      const { tx, service } = setup({ schedule: annual, deathActivation });
      expect(await service.releaseOccurrence(OCC, NOW)).toEqual({
        result: 'stale',
        reason: 'death not verified',
      });
      nothingWritten(tx);
    },
  );

  it('ANNUAL_AFTER_DEATH after verification: next year anchored on the death date', async () => {
    const died = new Date('2026-03-10T02:00:00Z'); // 10:00 Perth
    const { tx, service } = setup({
      schedule: annual,
      deathActivation: {
        triggerType: 'ANNUAL_AFTER_DEATH',
        deathVerificationCase: { status: 'VERIFIED', verifiedDeathAt: died },
      },
      assigned: { recipient: { birthday: null } },
    });
    expect(await service.releaseOccurrence(OCC, NOW)).toMatchObject({
      result: 'occurrence_released',
      next: new Date('2028-03-10T01:00:00Z'),
    });
    expect(tx.messageRecipientRelease.createMany).toHaveBeenCalled();
  });

  it('a concurrent unique-key win (P2002) is already_released, not an error', async () => {
    const { tx, service } = setup();
    tx.releaseNotification.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    expect(await service.releaseOccurrence(OCC, NOW)).toEqual({
      result: 'already_released',
    });
  });

  it('database errors propagate (BullMQ retries)', async () => {
    const { tx, service } = setup();
    tx.$queryRaw.mockRejectedValue(new Error('db down'));
    await expect(service.releaseOccurrence(OCC, NOW)).rejects.toThrow(
      'db down',
    );
  });
});

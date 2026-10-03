import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  createAccessGrants,
  MessageReleaseService,
} from './message-release.service.js';

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2030-12-25T01:00:00Z');
const DUE = new Date('2030-12-25T01:00:00Z'); // 09:00 +08:00, as a UTC instant
const LATER = new Date('2030-12-25T02:00:00Z');
const RELEASE_ID = '22222222-2222-4222-8222-222222222222';
const SOFIA = '33333333-3333-4333-8333-333333333333';
const JENNY = '44444444-4444-4444-8444-444444444444';

// Assigned live recipients as MessageRecipient rows (contact fields only).
const assigned = [
  {
    recipientId: SOFIA,
    recipient: { email: ' Sofia@Example.COM ', mobile: null },
  },
  {
    recipientId: JENNY,
    recipient: { email: null, mobile: ' +61 400 000 000 ' },
  },
];

const message = (over: object = {}) => ({
  schedule: { triggerType: 'FIXED_DATE', scheduledFor: DUE },
  release: null,
  _count: { recipients: 1 },
  ...over,
});

// `status` = what the FOR UPDATE row lock returns (null = no live row).
const setup = (status: string | null = 'SCHEDULED', row = message()) => {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue(status ? [{ status }] : []),
    message: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(row),
      update: vi.fn().mockResolvedValue({}),
    },
    messageRelease: { create: vi.fn().mockResolvedValue({ id: RELEASE_ID }) },
    messageRecipient: { findMany: vi.fn().mockResolvedValue(assigned) },
    recipientMessageAccessGrant: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({
        count: data.length,
      })),
      // Grants of this release that have an email snapshot.
      findMany: vi.fn().mockResolvedValue([{ id: 'grant-with-email' }]),
    },
    releaseNotification: {
      createMany: vi.fn(async ({ data }: { data: unknown[] }) => ({
        count: data.length,
      })),
    },
  };
  // Like PostgreSQL: if the callback throws, nothing it wrote is kept.
  const committed: string[] = [];
  const $transaction = vi.fn(async (fn: (t: typeof tx) => unknown) => {
    const result = await fn(tx);
    committed.push('commit');
    return result;
  });
  return {
    tx,
    committed,
    $transaction,
    service: new MessageReleaseService({
      $transaction,
    } as unknown as PrismaService),
  };
};

const noWrites = (tx: ReturnType<typeof setup>['tx']) => {
  expect(tx.messageRelease.create).not.toHaveBeenCalled();
  expect(tx.recipientMessageAccessGrant.createMany).not.toHaveBeenCalled();
  expect(tx.releaseNotification.createMany).not.toHaveBeenCalled();
  expect(tx.message.update).not.toHaveBeenCalled();
};

describe('MessageReleaseService', () => {
  it('releases a due FIXED_DATE message: RELEASED + one MessageRelease snapshot', async () => {
    const { tx, service } = setup();
    expect(await service.release(ID, NOW)).toEqual({
      result: 'released',
      triggerType: 'FIXED_DATE',
      scheduledFor: DUE,
      grants: 2,
    });
    expect(tx.messageRelease.create).toHaveBeenCalledWith({
      data: {
        messageId: ID,
        triggerType: 'FIXED_DATE',
        scheduledFor: DUE,
        releasedAt: NOW,
      },
      select: { id: true },
    });
    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { status: 'RELEASED' },
    });
  });

  it('queues one notification per grant with an email, inside the release transaction (Step 24)', async () => {
    const { tx, service } = setup();
    await service.release(ID, NOW);
    expect(tx.recipientMessageAccessGrant.findMany).toHaveBeenCalledWith({
      where: {
        messageReleaseId: RELEASE_ID,
        recipientEmailNormalized: { not: null },
      },
      select: { id: true },
    });
    expect(tx.releaseNotification.createMany).toHaveBeenCalledWith({
      data: [{ grantId: 'grant-with-email' }],
      skipDuplicates: true,
    });
  });

  it('locks the live message row before reading the schedule', async () => {
    const { tx, service } = setup();
    await service.release(ID, NOW);
    const sql = tx.$queryRaw.mock.calls[0][0].join('?');
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/"deletedAt" IS NULL/);
    expect(tx.$queryRaw.mock.calls[0][1]).toBe(ID);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.message.findUniqueOrThrow.mock.invocationCallOrder[0],
    );
  });

  it('is idempotent: already RELEASED or an existing MessageRelease → no-op', async () => {
    const released = setup('RELEASED');
    expect(await released.service.release(ID, NOW)).toEqual({
      result: 'already_released',
    });
    noWrites(released.tx);
    const withRow = setup('SCHEDULED', message({ release: { id: 'r1' } }));
    expect(await withRow.service.release(ID, NOW)).toEqual({
      result: 'already_released',
    });
    noWrites(withRow.tx);
  });

  it('a concurrent release (unique messageId) is reported as already released', async () => {
    const { tx, service } = setup();
    tx.messageRelease.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    expect(await service.release(ID, NOW)).toEqual({
      result: 'already_released',
    });
    expect(tx.message.update).not.toHaveBeenCalled();
  });

  it.each([
    ['DRAFT (unscheduled)', 'DRAFT', message()],
    ['CANCELLED', 'CANCELLED', message()],
    ['deleted or missing', null, message()],
    ['schedule deleted', 'SCHEDULED', message({ schedule: null })],
    [
      'ON_DEATH',
      'SCHEDULED',
      message({ schedule: { triggerType: 'ON_DEATH', scheduledFor: null } }),
    ],
    [
      'AFTER_DEATH',
      'SCHEDULED',
      message({ schedule: { triggerType: 'AFTER_DEATH', scheduledFor: null } }),
    ],
  ])('%s → stale no-op', async (_, status, row) => {
    const { tx, service } = setup(status, row);
    expect((await service.release(ID, NOW)).result).toBe('stale');
    noWrites(tx);
  });

  it('FIXED_DATE in the future (or moved later) → not_due with the DB time', async () => {
    const { tx, service } = setup(
      'SCHEDULED',
      message({ schedule: { triggerType: 'FIXED_DATE', scheduledFor: LATER } }),
    );
    expect(await service.release(ID, NOW)).toEqual({
      result: 'not_due',
      dueAt: LATER,
    });
    noWrites(tx);
    // One millisecond early is still early (no tolerance).
    const early = setup();
    expect(
      (await early.service.release(ID, new Date(DUE.getTime() - 1))).result,
    ).toBe('not_due');
  });

  it('no live recipient left → blocked, stays SCHEDULED', async () => {
    const { tx, service } = setup(
      'SCHEDULED',
      message({ _count: { recipients: 0 } }),
    );
    expect((await service.release(ID, NOW)).result).toBe('blocked');
    noWrites(tx);
  });

  it('database errors propagate (so BullMQ retries) and nothing is committed', async () => {
    const boom = new Error('connection lost');
    const read = setup();
    read.tx.$queryRaw.mockRejectedValue(boom);
    await expect(read.service.release(ID, NOW)).rejects.toBe(boom);

    // Status update fails after the release row: the transaction throws, so
    // PostgreSQL rolls back both (no partial release).
    const write = setup();
    write.tx.message.update.mockRejectedValue(boom);
    await expect(write.service.release(ID, NOW)).rejects.toBe(boom);
    expect(write.committed).toEqual([]);
    expect(write.$transaction).toHaveBeenCalledTimes(1);
  });

  it('all writes (release, grants, status) happen inside the one transaction', async () => {
    const { $transaction, tx, service } = setup();
    await service.release(ID, NOW);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(tx.messageRelease.create).toHaveBeenCalledTimes(1);
    expect(tx.recipientMessageAccessGrant.createMany).toHaveBeenCalledTimes(1);
    expect(tx.message.update).toHaveBeenCalledTimes(1);
  });

  it('creates one access grant per live assigned recipient, tied to this release and message', async () => {
    const { tx, service } = setup();
    await service.release(ID, NOW);
    expect(tx.messageRecipient.findMany).toHaveBeenCalledWith({
      where: { messageId: ID, recipient: { deletedAt: null } },
      select: {
        recipientId: true,
        recipient: { select: { email: true, mobile: true } },
      },
    });
    expect(tx.recipientMessageAccessGrant.createMany).toHaveBeenCalledWith({
      data: [
        {
          messageReleaseId: RELEASE_ID,
          messageId: ID,
          recipientId: SOFIA,
          // Same normalization as the API: trimmed + lowercased.
          recipientEmailNormalized: 'sofia@example.com',
          recipientMobileNormalized: null,
        },
        {
          // Mobile-only: still granted; mobile kept as stored (trimmed).
          messageReleaseId: RELEASE_ID,
          messageId: ID,
          recipientId: JENNY,
          recipientEmailNormalized: null,
          recipientMobileNormalized: '+61 400 000 000',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('grants snapshot contact details only (no notes, birthday, relationship, content)', async () => {
    const { tx, service } = setup();
    await service.release(ID, NOW);
    const read = JSON.stringify(tx.messageRecipient.findMany.mock.calls);
    const written = JSON.stringify(
      tx.recipientMessageAccessGrant.createMany.mock.calls,
    );
    for (const text of [read, written]) {
      expect(text).not.toMatch(
        /privateNote|birthday|relationship|firstName|textContent|ownerUserId/,
      );
    }
  });

  it('a grant failure rolls back the whole release (no partial state)', async () => {
    const { tx, service, committed } = setup();
    const boom = new Error('grant insert failed');
    tx.recipientMessageAccessGrant.createMany.mockRejectedValue(boom);
    await expect(service.release(ID, NOW)).rejects.toBe(boom);
    expect(tx.message.update).not.toHaveBeenCalled();
    expect(committed).toEqual([]);
  });

  it('createAccessGrants is idempotent: duplicates are skipped, not re-created', async () => {
    const { tx } = setup();
    tx.recipientMessageAccessGrant.createMany.mockResolvedValue({ count: 0 });
    const release = { id: RELEASE_ID, messageId: ID };
    expect(
      await createAccessGrants(
        tx as unknown as Prisma.TransactionClient,
        release,
      ),
    ).toBe(0);
    expect(
      (
        tx.recipientMessageAccessGrant.createMany.mock.calls[0][0] as {
          skipDuplicates?: boolean;
        }
      ).skipDuplicates,
    ).toBe(true);
  });

  it('never reads message content or recipient data', async () => {
    const { tx, service } = setup();
    await service.release(ID, NOW);
    const { select } = tx.message.findUniqueOrThrow.mock.calls[0][0];
    expect(JSON.stringify(select)).not.toMatch(
      /textContent|title|email|mobile|storageKey/,
    );
  });
});

import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service.js';
import { backfillAccessGrants } from './backfill-access-grants.js';

const releases = [
  { id: 'rel-1', messageId: 'msg-1' },
  { id: 'rel-2', messageId: 'msg-2' },
];

const setup = () => {
  const tx = {
    messageRecipient: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { recipientId: 'r1', recipient: { email: 'A@x.test', mobile: null } },
        ]),
    },
    recipientMessageAccessGrant: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    messageRelease: { findMany: vi.fn().mockResolvedValue(releases) },
    $transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const log = vi.fn();
  const logger = { log } as unknown as Logger;
  return { tx, prisma, logger, log };
};

describe('backfillAccessGrants', () => {
  it('only targets live RELEASED messages whose release has no grants', async () => {
    const { prisma, logger } = setup();
    await backfillAccessGrants(
      prisma as unknown as PrismaService,
      false,
      logger,
    );
    expect(prisma.messageRelease.findMany.mock.calls[0][0].where).toEqual({
      accessGrants: { none: {} },
      message: { status: 'RELEASED', deletedAt: null },
    });
  });

  it('dry run (default) writes nothing', async () => {
    const { prisma, tx, logger } = setup();
    expect(
      await backfillAccessGrants(
        prisma as unknown as PrismaService,
        false,
        logger,
      ),
    ).toEqual({ releases: 2, created: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.recipientMessageAccessGrant.createMany).not.toHaveBeenCalled();
  });

  it('apply: one transaction per release, idempotent inserts, ids-only logs', async () => {
    const { prisma, tx, logger, log } = setup();
    expect(
      await backfillAccessGrants(
        prisma as unknown as PrismaService,
        true,
        logger,
      ),
    ).toEqual({ releases: 2, created: 2 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(
      tx.recipientMessageAccessGrant.createMany.mock.calls[0][0],
    ).toMatchObject({
      data: [
        {
          messageReleaseId: 'rel-1',
          messageId: 'msg-1',
          recipientId: 'r1',
          recipientEmailNormalized: 'a@x.test',
        },
      ],
      skipDuplicates: true,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('@');
  });
});

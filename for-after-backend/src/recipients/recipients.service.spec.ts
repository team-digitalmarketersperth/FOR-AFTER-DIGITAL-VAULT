import { NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RecipientsService } from './recipients.service.js';

const row = {
  id: 'r1',
  firstName: 'Sofia',
  lastName: 'Smith',
  relationship: 'Daughter',
  email: 'sofia@example.com',
  mobile: '+61400000000',
  birthday: new Date('2001-03-15'),
  privateNote: 'Fictional note.',
  createdAt: new Date(),
  updatedAt: new Date(),
  photos: [] as { id: string }[],
};

const notFound = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

const setup = () => {
  const recipient = {
    create: vi.fn().mockResolvedValue(row),
    findMany: vi.fn().mockResolvedValue([row]),
    findFirst: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
    count: vi.fn().mockResolvedValue(1),
  };
  // The list reads count + page in one array transaction.
  const $transaction = (ops: Promise<unknown>[]) => Promise.all(ops);
  return {
    recipient,
    service: new RecipientsService({
      recipient,
      $transaction,
    } as unknown as PrismaService),
  };
};

const ownedBy = (ownerUserId: string, id: string) => ({
  id,
  ownerUserId,
  deletedAt: null,
});

describe('RecipientsService', () => {
  it('create takes the owner from the argument and hides ownerUserId', async () => {
    const { recipient, service } = setup();
    const res = await service.create('owner-a', {
      firstName: 'Sofia',
      birthday: '2001-03-15',
      // A smuggled field (the ValidationPipe rejects this first in HTTP).
      ...({ ownerUserId: 'owner-b' } as object),
    });
    const { data, select } = recipient.create.mock.calls[0][0];
    expect(data.ownerUserId).toBe('owner-a');
    expect(data.birthday).toEqual(new Date('2001-03-15'));
    expect(select).not.toHaveProperty('ownerUserId');
    expect(select).not.toHaveProperty('deletedAt');
    expect(res.birthday).toBe('2001-03-15');
  });

  it('lists one page of the owner’s live recipients, newest first with an id tiebreak', async () => {
    const { recipient, service } = setup();
    recipient.count.mockResolvedValue(37);
    const res = await service.findAllForOwner('owner-a', 2, 25);
    const where = { ownerUserId: 'owner-a', deletedAt: null };
    expect(recipient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: 25,
        take: 25,
      }),
    );
    // The total uses the same owner filter: no other Customer is ever counted.
    expect(recipient.count).toHaveBeenCalledWith({ where });
    expect(res.pagination).toEqual({ page: 2, limit: 25, total: 37, pages: 2 });
    expect(res.items[0]).toMatchObject({ id: 'r1', photoId: null });
    expect(res.items[0]).not.toHaveProperty('photos');
  });

  it('exposes the current photo id only, never a storage key or URL', async () => {
    const { recipient, service } = setup();
    recipient.findFirst.mockResolvedValue({ ...row, photos: [{ id: 'p1' }] });
    const res = await service.findOwnedById('owner-a', 'r1');
    expect(res.photoId).toBe('p1');
    const { select } = recipient.findFirst.mock.calls[0][0];
    expect(select.photos).toEqual({
      where: { status: 'READY', deletedAt: null },
      select: { id: true },
      take: 1,
    });
  });

  it('findOwnedById scopes the query by owner and hides deleted rows', async () => {
    const { recipient, service } = setup();
    await service.findOwnedById('owner-a', 'r1');
    expect(recipient.findFirst.mock.calls[0][0].where).toEqual(
      ownedBy('owner-a', 'r1'),
    );
  });

  it('findOwnedById gives 404 for another owner’s (or a deleted) recipient', async () => {
    const { recipient, service } = setup();
    recipient.findFirst.mockResolvedValue(null);
    await expect(service.findOwnedById('owner-b', 'r1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('update is a single owner-scoped write with only DTO fields', async () => {
    const { recipient, service } = setup();
    await service.update('owner-a', 'r1', { lastName: null, birthday: null });
    const { where, data } = recipient.update.mock.calls[0][0];
    expect(where).toEqual(ownedBy('owner-a', 'r1'));
    expect(data).toMatchObject({ lastName: null, birthday: null });
    expect(data).not.toHaveProperty('ownerUserId');
  });

  it('cross-user update and delete become 404 (P2025)', async () => {
    const { recipient, service } = setup();
    recipient.update.mockRejectedValue(notFound());
    await expect(
      service.update('owner-b', 'r1', { firstName: 'X' }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.remove('owner-b', 'r1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('remove soft-deletes by setting deletedAt on an owned, live row', async () => {
    const { recipient, service } = setup();
    await service.remove('owner-a', 'r1');
    const { where, data } = recipient.update.mock.calls[0][0];
    expect(where).toEqual(ownedBy('owner-a', 'r1'));
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it('does not swallow unexpected database errors', async () => {
    const { recipient, service } = setup();
    recipient.update.mockRejectedValue(new Error('boom'));
    await expect(service.remove('owner-a', 'r1')).rejects.toThrow('boom');
  });
});

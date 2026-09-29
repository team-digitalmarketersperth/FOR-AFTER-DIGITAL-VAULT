import { BadRequestException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CreateTrustedContactDto } from './dto/create-trusted-contact.dto.js';
import { TrustedContactsService } from './trusted-contacts.service.js';

const row = {
  id: 't1',
  firstName: 'David',
  lastName: 'Smith',
  relationship: 'Spouse',
  email: 'david@example.com',
  mobile: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

const setup = () => {
  const trustedContact = {
    create: vi.fn().mockResolvedValue(row),
    findMany: vi.fn().mockResolvedValue([row]),
    findFirst: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
    count: vi.fn().mockResolvedValue(0),
  };
  return {
    trustedContact,
    service: new TrustedContactsService({
      trustedContact,
    } as unknown as PrismaService),
  };
};

const ownedBy = (ownerUserId: string, id: string) => ({
  id,
  ownerUserId,
  deletedAt: null,
});

const errorsFor = async (body: object) =>
  (await validate(plainToInstance(CreateTrustedContactDto, body))).map(
    (e) => e.property,
  );

describe('CreateTrustedContactDto contact-method rule', () => {
  it.each([
    { firstName: 'David', email: 'david@example.com' },
    { firstName: 'David', mobile: '+61400000000' },
    { firstName: 'David', email: 'david@example.com', mobile: '+61400000000' },
  ])('accepts %o', async (body) => {
    expect(await errorsFor(body)).toEqual([]);
  });

  it.each([
    { firstName: 'David' },
    { firstName: 'David', email: null, mobile: null },
    { firstName: 'David', email: 'bad-email' },
  ])('rejects %o', async (body) => {
    expect(await errorsFor(body)).toContain('email');
  });
});

describe('TrustedContactsService', () => {
  it('create takes the owner from the argument and hides ownerUserId', async () => {
    const { trustedContact, service } = setup();
    await service.create('owner-a', {
      firstName: 'David',
      email: 'david@example.com',
      // A smuggled field (the ValidationPipe rejects this first in HTTP).
      ...({ ownerUserId: 'owner-b' } as object),
    });
    const { data, select } = trustedContact.create.mock.calls[0][0];
    expect(data.ownerUserId).toBe('owner-a');
    expect(select).not.toHaveProperty('ownerUserId');
    expect(select).not.toHaveProperty('deletedAt');
  });

  it('lists only the owner’s non-deleted contacts, newest first', async () => {
    const { trustedContact, service } = setup();
    await service.findAllForOwner('owner-a');
    expect(trustedContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ownerUserId: 'owner-a', deletedAt: null },
        orderBy: { createdAt: 'desc' },
      }),
    );
  });

  it('findOwnedById is owner-scoped; another owner gets 404', async () => {
    const { trustedContact, service } = setup();
    await service.findOwnedById('owner-a', 't1');
    expect(trustedContact.findFirst.mock.calls[0][0].where).toEqual(
      ownedBy('owner-a', 't1'),
    );
    trustedContact.findFirst.mockResolvedValue(null);
    await expect(service.findOwnedById('owner-b', 't1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('update of an owned contact is a single owner-scoped write', async () => {
    const { trustedContact, service } = setup();
    await service.update('owner-a', 't1', { relationship: 'Husband' });
    const { where, data } = trustedContact.update.mock.calls[0][0];
    expect(where).toEqual(ownedBy('owner-a', 't1'));
    expect(data).toMatchObject({ relationship: 'Husband' });
    expect(data).not.toHaveProperty('ownerUserId');
  });

  it('cross-user update and delete are 404', async () => {
    const { trustedContact, service } = setup();
    trustedContact.update.mockRejectedValue(noMatch());
    await expect(
      service.update('owner-b', 't1', { firstName: 'X' }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      service.update('owner-b', 't1', { email: null }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.remove('owner-b', 't1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('soft-deletes an owned, live row', async () => {
    const { trustedContact, service } = setup();
    await service.remove('owner-a', 't1');
    const { where, data } = trustedContact.update.mock.calls[0][0];
    expect(where).toEqual(ownedBy('owner-a', 't1'));
    expect(data.deletedAt).toBeInstanceOf(Date);
  });

  it('clearing email requires mobile to still be set, inside the UPDATE', async () => {
    const { trustedContact, service } = setup();
    await service.update('owner-a', 't1', { email: null });
    expect(trustedContact.update.mock.calls[0][0].where).toEqual({
      ...ownedBy('owner-a', 't1'),
      mobile: { not: null },
    });
  });

  it('clearing mobile requires email to still be set, inside the UPDATE', async () => {
    const { trustedContact, service } = setup();
    await service.update('owner-a', 't1', { mobile: null });
    expect(trustedContact.update.mock.calls[0][0].where).toEqual({
      ...ownedBy('owner-a', 't1'),
      email: { not: null },
    });
  });

  it('swapping one method for the other needs no extra condition', async () => {
    const { trustedContact, service } = setup();
    await service.update('owner-a', 't1', {
      email: null,
      mobile: '+61400000000',
    });
    expect(trustedContact.update.mock.calls[0][0].where).toEqual(
      ownedBy('owner-a', 't1'),
    );
  });

  it('clearing the last contact method on an owned row is 400', async () => {
    const { trustedContact, service } = setup();
    trustedContact.update.mockRejectedValue(noMatch());
    trustedContact.count.mockResolvedValue(1);
    await expect(
      service.update('owner-a', 't1', { email: null }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.update('owner-a', 't1', { mobile: null }),
    ).rejects.toThrow(BadRequestException);
  });

  it('clearing both at once is 400 without touching the database', async () => {
    const { trustedContact, service } = setup();
    await expect(
      service.update('owner-a', 't1', { email: null, mobile: null }),
    ).rejects.toThrow(BadRequestException);
    expect(trustedContact.update).not.toHaveBeenCalled();
  });

  it('does not swallow unexpected database errors', async () => {
    const { trustedContact, service } = setup();
    trustedContact.update.mockRejectedValue(new Error('boom'));
    await expect(service.remove('owner-a', 't1')).rejects.toThrow('boom');
  });
});

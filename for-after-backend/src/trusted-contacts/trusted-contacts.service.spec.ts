import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CreateTrustedContactDto } from './dto/create-trusted-contact.dto.js';
import type { TrustedContactInvitationsService } from './trusted-contact-invitations.service.js';
import type { ConfigService } from '@nestjs/config';
import { TRIAL_CONTACT_LIMIT, TRIAL_LIMIT } from '../billing/billing-access.js';
import {
  MAX_REACHED,
  MAX_TRUSTED_CONTACTS,
  TrustedContactsService,
} from './trusted-contacts.service.js';

const row = {
  id: 't1',
  firstName: 'David',
  lastName: 'Smith',
  relationship: 'Spouse',
  email: 'david@example.com',
  mobile: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  invitations: [],
};

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

// Billing on (Trial Step 3): an account created after enforcement; `user` is its billing rows.
const BILLING_ON = { BILLING_ENABLED: 'true', BILLING_ENFORCE_FROM: '2026-01-01T00:00:00.000Z' };
const account = (trialEndsAt: Date | null, subscription: object | null = null) => ({
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  trial: trialEndsAt && { startedAt: new Date(trialEndsAt.getTime() - 7 * 86_400_000), endsAt: trialEndsAt },
  billingAccount: subscription,
});
const inTrial = () => account(new Date(Date.now() + 86_400_000));

const setup = (env: Record<string, string> = {}, owner: object = inTrial()) => {
  const trustedContact = {
    create: vi.fn().mockResolvedValue(row),
    findMany: vi.fn().mockResolvedValue([row]),
    findFirst: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
    count: vi.fn().mockResolvedValue(0),
  };
  const $queryRaw = vi.fn().mockResolvedValue([]);
  const user = { findUniqueOrThrow: vi.fn().mockResolvedValue(owner) };
  // Recent changes (customer activity): recorded, not asserted here.
  const customerActivity = { create: vi.fn(async () => ({})) };
  const db = { trustedContact, $queryRaw, customerActivity, user };
  const invitations = { send: vi.fn().mockResolvedValue(true) };
  return {
    trustedContact,
    $queryRaw,
    user,
    invitations,
    service: new TrustedContactsService(
      {
        ...db,
        $transaction: (fn: (tx: typeof db) => unknown) => fn(db),
      } as unknown as PrismaService,
      invitations as unknown as TrustedContactInvitationsService,
      { get: (key: string) => env[key] } as unknown as ConfigService,
    ),
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

  it('create locks the Customer row before counting (max 2, Phase 10)', async () => {
    const { trustedContact, $queryRaw, service } = setup();
    trustedContact.count.mockResolvedValue(MAX_TRUSTED_CONTACTS - 1);
    await service.create('owner-a', {
      firstName: 'David',
      mobile: '+61400000000',
    });
    expect(String($queryRaw.mock.calls[0][0].join(''))).toMatch(/FOR UPDATE/);
    expect(trustedContact.count).toHaveBeenCalledWith({
      where: { ownerUserId: 'owner-a', deletedAt: null },
    });
    expect(trustedContact.create).toHaveBeenCalled();
  });

  it('a third active contact is 409 and nothing is written', async () => {
    const { trustedContact, invitations, service } = setup();
    trustedContact.count.mockResolvedValue(MAX_TRUSTED_CONTACTS);
    await expect(
      service.create('owner-a', { firstName: 'Third', email: 'c@example.com' }),
    ).rejects.toThrow(ConflictException);
    expect(trustedContact.create).not.toHaveBeenCalled();
    expect(invitations.send).not.toHaveBeenCalled();
  });

  describe('trial cap (Step 3): one live contact during an enforced active trial', () => {
    it('active trial, none yet: allowed; the cap is read after the User row lock', async () => {
      const { trustedContact, $queryRaw, user, service } = setup(BILLING_ON);
      await service.create('owner-a', { firstName: 'David', mobile: '+61400000000' });
      expect($queryRaw.mock.invocationCallOrder[0]).toBeLessThan(user.findUniqueOrThrow.mock.invocationCallOrder[0]);
      expect(trustedContact.create).toHaveBeenCalled();
    });

    it('active trial with one live contact (any invitation state): 409 TRIAL_LIMIT before any row or invitation', async () => {
      const { trustedContact, invitations, service } = setup(BILLING_ON);
      trustedContact.count.mockResolvedValue(1);
      const err = await service.create('owner-a', { firstName: 'Second', email: 'b@example.com' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ code: TRIAL_LIMIT, message: TRIAL_CONTACT_LIMIT });
      expect(trustedContact.create).not.toHaveBeenCalled();
      expect(invitations.send).not.toHaveBeenCalled();
    });

    it('two live contacts from before the trial: the existing two-contact refusal (no plan would help), no TRIAL_LIMIT', async () => {
      const { trustedContact, service } = setup(BILLING_ON);
      trustedContact.count.mockResolvedValue(MAX_TRUSTED_CONTACTS);
      const err = await service.create('owner-a', { firstName: 'Third', mobile: '+61400000000' }).catch((e: unknown) => e);
      expect((err as ConflictException).getResponse()).toMatchObject({ message: MAX_REACHED });
    });

    it.each([
      ['billing off', {}, inTrial()],
      ['paid (wins over active trial dates)', BILLING_ON, account(new Date(Date.now() + 86_400_000), { plan: 'monthly', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 86_400_000) })],
      ['grandfathered', BILLING_ON, { ...inTrial(), createdAt: new Date('2025-12-01T00:00:00.000Z') }],
    ])('%s: a second contact is allowed (existing max of two unchanged)', async (_, env, owner) => {
      const { trustedContact, service } = setup(env, owner);
      trustedContact.count.mockResolvedValue(1);
      await service.create('owner-a', { firstName: 'Second', mobile: '+61400000000' });
      expect(trustedContact.create).toHaveBeenCalled();
    });
  });

  it('create with an email sends the invitation; mobile-only does not (no SMS)', async () => {
    const { invitations, service } = setup();
    await service.create('owner-a', { firstName: 'D', email: 'd@example.com' });
    expect(invitations.send).toHaveBeenCalledWith('owner-a', 't1', 'EMAIL', undefined);
    invitations.send.mockClear();
    await service.create('owner-a', { firstName: 'M', mobile: '+61400000000' });
    expect(invitations.send).not.toHaveBeenCalled();
  });

  it('responses carry the invitation state, never invitation rows', async () => {
    const { service } = setup();
    const res = await service.findOwnedById('owner-a', 't1');
    expect(res).not.toHaveProperty('invitations');
    expect(res.invitation).toEqual({ status: 'NOT_SENT', sentAt: null, channel: null });
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
    // A pending invitation dies with the relationship.
    expect(data.invitations.updateMany).toMatchObject({
      where: { status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
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

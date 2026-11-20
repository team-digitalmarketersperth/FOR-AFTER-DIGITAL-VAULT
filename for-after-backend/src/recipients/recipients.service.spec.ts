import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PLAN_LIMIT, planRecipientLimitMessage, TRIAL_LIMIT, TRIAL_RECIPIENT_LIMIT } from '../billing/billing-access.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
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

// Billing on (Trial Step 3): an account created after enforcement; `user` is its billing rows.
const BILLING_ON = { BILLING_ENABLED: 'true', BILLING_ENFORCE_FROM: '2026-01-01T00:00:00.000Z' };
const account = (trialEndsAt: Date | null, subscription: object | null = null) => ({
  createdAt: new Date('2026-06-01T00:00:00.000Z'),
  trial: trialEndsAt && { startedAt: new Date(trialEndsAt.getTime() - 7 * 86_400_000), endsAt: trialEndsAt },
  billingAccount: subscription,
});
const inTrial = () => account(new Date(Date.now() + 86_400_000));

const setup = (env: Record<string, string> = {}, user: object = inTrial()) => {
  const recipient = {
    create: vi.fn().mockResolvedValue(row),
    findMany: vi.fn().mockResolvedValue([row]),
    findFirst: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
    count: vi.fn().mockResolvedValue(1),
  };
  const photo = { id: 'p1', storageKey: 'k', storageProvider: 'IMAGEKIT', providerFileId: 'f1', createdAt: new Date() };
  const recipientPhoto = {
    updateManyAndReturn: vi.fn().mockResolvedValue([photo]),
  };
  const $queryRaw = vi.fn().mockResolvedValue([]);
  const users = { findUniqueOrThrow: vi.fn().mockResolvedValue(user) };
  const customerActivity = { create: vi.fn(async () => ({})) };
  const cleanup = { purge: vi.fn().mockResolvedValue({ purged: 1, failed: 0, deferred: 0 }) };
  // The list reads count + page in one array transaction; create and remove use an
  // interactive one (the callback gets the same delegates).
  const $transaction = (ops: Promise<unknown>[] | ((tx: object) => Promise<unknown>)) =>
    typeof ops === 'function' ? ops({ recipient, recipientPhoto, $queryRaw, user: users }) : Promise.all(ops);
  return {
    recipient,
    recipientPhoto,
    $queryRaw,
    users,
    cleanup,
    photo,
    service: new RecipientsService(
      { recipient, recipientPhoto, $transaction, customerActivity } as unknown as PrismaService,
      cleanup as unknown as MediaCleanup,
      { get: (key: string) => env[key] } as unknown as ConfigService,
    ),
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

  describe('trial cap (Step 3): one live Recipient during an enforced active trial', () => {
    it('billing off: no lock, no billing read, no count; the create goes ahead', async () => {
      const { recipient, $queryRaw, users, service } = setup();
      recipient.count.mockResolvedValue(5);
      await service.create('owner-a', { firstName: 'Sofia' });
      expect($queryRaw).not.toHaveBeenCalled();
      expect(users.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(recipient.create).toHaveBeenCalled();
    });

    it('active trial, none yet: locks the User row, then reads billing and counts live rows in the same transaction', async () => {
      const { recipient, $queryRaw, users, service } = setup(BILLING_ON);
      recipient.count.mockResolvedValue(0);
      await service.create('owner-a', { firstName: 'Sofia' });
      expect(String(($queryRaw.mock.calls[0][0] as string[]).join(''))).toMatch(/FROM "User" WHERE id = .*FOR UPDATE/);
      expect($queryRaw.mock.invocationCallOrder[0]).toBeLessThan(users.findUniqueOrThrow.mock.invocationCallOrder[0]);
      expect(recipient.count).toHaveBeenCalledWith({ where: { ownerUserId: 'owner-a', deletedAt: null } });
      expect(recipient.create).toHaveBeenCalled();
    });

    it.each([1, 3])('active trial with %i live (incl. excess from before): 409 TRIAL_LIMIT, nothing created', async (live) => {
      const { recipient, service } = setup(BILLING_ON);
      recipient.count.mockResolvedValue(live);
      const err = await service.create('owner-a', { firstName: 'Second' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ statusCode: 409, code: TRIAL_LIMIT, message: TRIAL_RECIPIENT_LIMIT });
      expect(recipient.create).not.toHaveBeenCalled();
    });

    it.each([
      ['paid (wins over active trial dates)', account(new Date(Date.now() + 86_400_000), { plan: 'monthly', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 86_400_000) })],
      ['grandfathered (created before enforcement)', { ...inTrial(), createdAt: new Date('2025-12-01T00:00:00.000Z') }],
    ])('%s: no trial cap', async (_, user) => {
      const { recipient, service } = setup(BILLING_ON, user);
      recipient.count.mockResolvedValue(7);
      await service.create('owner-a', { firstName: 'Eighth' });
      expect(recipient.create).toHaveBeenCalled();
    });
  });

  describe('paid plan cap (Updated Plans Step 3): an entitled, mapped tier', () => {
    const paidUntil = new Date(Date.now() + 30 * 86_400_000);
    const paid = (tier: 'PREMIUM' | 'COMPLETE' | null, status = 'active') =>
      account(null, { plan: 'monthly', tier, subscriptionStatus: status, cancelAtPeriodEnd: false, currentPeriodEnd: paidUntil });

    it.each([
      ['PREMIUM', 10],
      ['COMPLETE', 50],
    ] as const)('%s: below %i creates; at or above it is 409 PLAN_LIMIT (not TRIAL_LIMIT), nothing created', async (tier, max) => {
      const ok = setup(BILLING_ON, paid(tier));
      ok.recipient.count.mockResolvedValue(max - 1);
      await ok.service.create('owner-a', { firstName: 'Last one' });
      expect(ok.recipient.create).toHaveBeenCalled();
      for (const live of [max, max + 3]) {
        const full = setup(BILLING_ON, paid(tier));
        full.recipient.count.mockResolvedValue(live);
        const err = await full.service.create('owner-a', { firstName: 'One more' }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ConflictException);
        expect((err as ConflictException).getResponse()).toEqual({ statusCode: 409, error: 'Conflict', code: PLAN_LIMIT, message: planRecipientLimitMessage(max) });
        expect(full.recipient.create).not.toHaveBeenCalled();
      }
    });

    it('unmapped paid (no stored tier): no cap, as before', async () => {
      const { recipient, service } = setup(BILLING_ON, paid(null));
      recipient.count.mockResolvedValue(500);
      await service.create('owner-a', { firstName: 'Many' });
      expect(recipient.create).toHaveBeenCalled();
    });

    it('a stored tier whose paid access has ended gives no plan cap (the gate decides writes, 402)', async () => {
      const { recipient, service } = setup(BILLING_ON, paid('PREMIUM', 'canceled'));
      recipient.count.mockResolvedValue(30);
      await service.create('owner-a', { firstName: 'Reached only past the gate' });
      expect(recipient.create).toHaveBeenCalled();
    });
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

  it('remove soft-deletes the Recipient and every live photo in one transaction, then purges the files', async () => {
    const { recipient, recipientPhoto, cleanup, photo, service } = setup();
    await service.remove('owner-a', 'r1');
    const deletedAt = recipient.update.mock.calls[0][0].data.deletedAt;
    expect(recipientPhoto.updateManyAndReturn).toHaveBeenCalledWith({
      where: { ownerUserId: 'owner-a', recipientId: 'r1', deletedAt: null },
      data: { deletedAt },
      select: expect.objectContaining({ storageKey: true, providerFileId: true }),
    });
    expect(cleanup.purge).toHaveBeenCalledWith('recipientPhoto', [photo]);
    expect(recipientPhoto.updateManyAndReturn.mock.invocationCallOrder[0]).toBeLessThan(
      cleanup.purge.mock.invocationCallOrder[0],
    );
  });

  it('remove: a failed transaction (someone else’s Recipient, or a photo update error) purges nothing', async () => {
    const { recipient, recipientPhoto, cleanup, service } = setup();
    recipient.update.mockRejectedValueOnce(notFound());
    await expect(service.remove('owner-b', 'r1')).rejects.toThrow(NotFoundException);
    expect(recipientPhoto.updateManyAndReturn).not.toHaveBeenCalled();
    recipientPhoto.updateManyAndReturn.mockRejectedValueOnce(new Error('photo update failed'));
    await expect(service.remove('owner-a', 'r1')).rejects.toThrow('photo update failed');
    expect(cleanup.purge).not.toHaveBeenCalled();
  });

  it('does not swallow unexpected database errors', async () => {
    const { recipient, service } = setup();
    recipient.update.mockRejectedValue(new Error('boom'));
    await expect(service.remove('owner-a', 'r1')).rejects.toThrow('boom');
  });
});

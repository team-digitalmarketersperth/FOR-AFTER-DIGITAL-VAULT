import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { StorageQuota, StorageUsage } from '../media/storage-quota.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AttentionController, AttentionService } from './attention.module.js';

const NOW = Date.now();
const invite = (status: string, expiresInMs = 86_400_000) => [
  {
    status,
    emailNormalized: 'tc@example.test',
    expiresAt: new Date(NOW + expiresInMs),
    acceptedAt: status === 'ACCEPTED' ? new Date(NOW) : null,
    createdAt: new Date(NOW - 1000),
  },
];
const contact = (id: string, firstName: string, invitations: unknown[], email: string | null = 'tc@example.test') => ({
  id,
  firstName,
  email,
  invitations,
});

const setup = ({
  drafts = 0,
  contacts = [] as ReturnType<typeof contact>[],
  birthdays = [] as { recipientId: string; recipient: { firstName: string } }[],
  level = 'NORMAL' as StorageUsage['level'],
  percentage = 10,
} = {}) => {
  const prisma = {
    message: { count: vi.fn().mockResolvedValue(drafts) },
    trustedContact: { findMany: vi.fn().mockResolvedValue(contacts) },
    messageRecipient: { findMany: vi.fn().mockResolvedValue(birthdays) },
  };
  const quota = { usage: vi.fn().mockResolvedValue({ level, percentage }) };
  const service = new AttentionService(
    prisma as unknown as PrismaService,
    quota as unknown as StorageQuota,
  );
  return { prisma, quota, service };
};

describe('AttentionService', () => {
  it('nothing to do → no items', async () => {
    expect(await setup().service.getForUser('ada')).toEqual({ items: [], total: 0 });
  });

  it('messages needing timing: one aggregated, correctly pluralised item, from the readiness definition', async () => {
    const one = await setup({ drafts: 1 }).service.getForUser('ada');
    expect(one.items).toEqual([
      {
        key: 'MESSAGES_NEED_TIMING',
        category: 'MESSAGES',
        priority: 'MEDIUM',
        title: '1 message needs timing',
        description: null,
        actionLabel: 'Review messages',
        actionHref: '/messages',
      },
    ]);
    const t = setup({ drafts: 3 });
    expect((await t.service.getForUser('ada')).items[0].title).toBe('3 messages need timing');
    // Live DRAFT messages of this owner only: RELEASED, SCHEDULED, CANCELLED and deleted are never counted.
    expect(t.prisma.message.count).toHaveBeenCalledWith({
      where: { ownerUserId: 'ada', deletedAt: null, status: 'DRAFT' },
    });
  });

  it('Trusted Contacts: pending and expired named; READY never listed; removed ones are not queried', async () => {
    const t = setup({
      contacts: [
        contact('c1', 'James', invite('PENDING')),
        contact('c2', 'Sarah', invite('ACCEPTED')),
      ],
    });
    const { items } = await t.service.getForUser('ada');
    expect(items.map((i) => i.title)).toEqual(['James hasn’t accepted the invitation yet']);
    expect(items[0]).toMatchObject({ key: 'TRUSTED_CONTACT:c1', actionHref: '/trusted-contacts' });
    expect(t.prisma.trustedContact.findMany.mock.calls[0][0].where).toEqual({ ownerUserId: 'ada', deletedAt: null });

    const expired = setup({ contacts: [contact('c1', 'James', invite('PENDING', -1000))] });
    expect((await expired.service.getForUser('ada')).items[0]).toMatchObject({
      title: 'James’s invitation has expired',
      actionLabel: 'Send a new invitation',
    });
  });

  it('Trusted Contacts: the same state twice is one item; other states are per contact', async () => {
    const pending = setup({
      contacts: [contact('c1', 'James', invite('PENDING')), contact('c2', 'Sarah', invite('PENDING'))],
    });
    expect((await pending.service.getForUser('ada')).items).toEqual([
      expect.objectContaining({ key: 'TRUSTED_CONTACTS:INVITATION_PENDING', title: '2 Trusted Contact invitations are pending' }),
    ]);
    const mixed = setup({
      contacts: [contact('c1', 'James', [], null), contact('c2', 'Sarah', invite('DECLINED'))],
    });
    expect((await mixed.service.getForUser('ada')).items).toEqual([
      // Mobile-only: invitable by SMS now, so simply not invited yet.
      expect.objectContaining({ title: 'James hasn’t been invited yet', actionHref: '/trusted-contacts' }),
      expect.objectContaining({ title: 'Sarah declined the invitation', actionHref: '/trusted-contacts' }),
    ]);
    const notSent = setup({ contacts: [contact('c1', 'James', [])] });
    expect((await notSent.service.getForUser('ada')).items[0].title).toBe('James hasn’t been invited yet');
  });

  it('missing birthday: only for scheduled BIRTHDAY messages, one item per person', async () => {
    const t = setup({
      birthdays: [
        { recipientId: 'r1', recipient: { firstName: 'Sarah' } },
        { recipientId: 'r1', recipient: { firstName: 'Sarah' } },
        { recipientId: 'r2', recipient: { firstName: 'Mum' } },
      ],
    });
    const { items } = await t.service.getForUser('ada');
    expect(items).toEqual([
      {
        key: 'RECIPIENT_BIRTHDAY_MISSING:r1',
        category: 'PEOPLE',
        priority: 'MEDIUM',
        title: 'Sarah is missing a birthday',
        description: 'Needed for 2 scheduled birthday messages.',
        actionLabel: 'Add birthday',
        actionHref: '/people/r1/edit',
      },
      expect.objectContaining({ title: 'Mum is missing a birthday', description: 'Needed for 1 scheduled birthday message.' }),
    ]);
    // The scheduling rule itself (live Recipient, no birthday) on this owner's live scheduled BIRTHDAY messages.
    expect(t.prisma.messageRecipient.findMany.mock.calls[0][0].where).toEqual({
      message: { ownerUserId: 'ada', deletedAt: null, status: 'SCHEDULED', schedule: { triggerType: 'BIRTHDAY' } },
      recipient: { ownerUserId: 'ada', deletedAt: null, birthday: null },
    });
  });

  it.each([
    ['NORMAL', 79, null],
    ['WARNING', 84, { priority: 'LOW', title: 'Storage is 84% full' }],
    ['HIGH', 93, { priority: 'HIGH', title: 'Storage is 93% full' }],
    ['FULL', 100, { priority: 'HIGH', title: 'Storage is full' }],
  ] as const)('storage %s (%i%%), from the quota’s own level', async (level, percentage, expected) => {
    const t = setup({ level, percentage });
    const { items } = await t.service.getForUser('ada');
    expect(t.quota.usage).toHaveBeenCalledWith('ada');
    if (!expected) return expect(items).toEqual([]);
    expect(items).toEqual([
      {
        key: 'STORAGE',
        category: 'STORAGE',
        ...expected,
        description: 'Free up space to keep adding photos, recordings and videos.',
        actionLabel: 'Manage storage',
        actionHref: '/settings/storage',
      },
    ]);
  });

  it('sorted HIGH → MEDIUM → LOW, then contacts, messages, people, storage; every item returned', async () => {
    const order = async (level: StorageUsage['level']) =>
      (
        await setup({
          drafts: 2,
          contacts: [contact('c1', 'James', invite('PENDING')), contact('c2', 'Sarah', [], null)],
          birthdays: [{ recipientId: 'r1', recipient: { firstName: 'Mum' } }],
          level,
          percentage: level === 'HIGH' ? 95 : 85,
        }).service.getForUser('ada')
      ).items.map((i) => i.key);
    expect(await order('HIGH')).toEqual([
      'STORAGE',
      'TRUSTED_CONTACT:c1',
      'TRUSTED_CONTACT:c2',
      'MESSAGES_NEED_TIMING',
      'RECIPIENT_BIRTHDAY_MISSING:r1',
    ]);
    const low = await order('WARNING');
    expect(low.at(-1)).toBe('STORAGE');
    expect(low).toHaveLength(5);
  });

  it('safe fields only: no content, emails, tokens, notes or verification state', async () => {
    const body = JSON.stringify(
      await setup({
        drafts: 1,
        contacts: [contact('c1', 'James', invite('PENDING'))],
        birthdays: [{ recipientId: 'r1', recipient: { firstName: 'Mum' } }],
        level: 'HIGH',
        percentage: 91,
      }).service.getForUser('ada'),
    );
    expect(body).not.toMatch(/@|token|otp|note|death|verif|report|evidence/i);
  });

  it('requires a session and the CUSTOMER role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AttentionController)).toEqual([SessionAuthGuard, CustomerGuard]);
  });
});

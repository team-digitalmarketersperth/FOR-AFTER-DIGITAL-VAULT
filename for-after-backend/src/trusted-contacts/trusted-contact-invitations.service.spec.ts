import {
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import type { EmailProvider } from '../email/email-provider.js';
import type { EmailConfig } from '../email/email.module.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  invitationState,
  TrustedContactInvitationsService,
} from './trusted-contact-invitations.service.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const HOUR = 3_600_000;

const setup = (
  contact: object | null = {
    email: 'david@example.com',
    invitations: [],
    owner: { firstName: 'Lisa', lastName: 'Test' },
  },
) => {
  const trustedContactInvitation = {
    count: vi.fn().mockResolvedValue(0),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    create: vi.fn().mockResolvedValue({ id: 'inv-1' }),
  };
  const db = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    trustedContact: { findFirst: vi.fn().mockResolvedValue(contact) },
    trustedContactInvitation,
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'a' }) },
  };
  const email = { send: vi.fn().mockResolvedValue({ providerMessageId: 'x' }) };
  const service = new TrustedContactInvitationsService(
    {
      ...db,
      $transaction: (fn: (tx: typeof db) => unknown) => fn(db),
    } as unknown as PrismaService,
    email as unknown as EmailProvider,
    { settings: { appBaseUrl: 'https://app.test' } } as EmailConfig,
    { get: () => undefined } as unknown as ConfigService,
  );
  return { db, email, service };
};

describe('invitationState', () => {
  const now = new Date('2026-10-06T00:00:00Z');
  const row = (over: object = {}) => ({
    status: 'PENDING' as const,
    emailNormalized: 'd@example.com',
    expiresAt: new Date(now.getTime() + HOUR),
    createdAt: now,
    ...over,
  });

  it.each([
    ['no email → UNAVAILABLE (SMS deferred)', null, row(), 'UNAVAILABLE'],
    ['never sent', 'd@example.com', undefined, 'NOT_SENT'],
    ['pending', 'd@example.com', row(), 'PENDING'],
    [
      'pending past expiry',
      'd@example.com',
      row({ expiresAt: now }),
      'EXPIRED',
    ],
    ['accepted', 'd@example.com', row({ status: 'ACCEPTED' }), 'ACCEPTED'],
    ['declined', 'd@example.com', row({ status: 'DECLINED' }), 'DECLINED'],
    [
      'cancelled (send failed)',
      'd@example.com',
      row({ status: 'CANCELLED' }),
      'NOT_SENT',
    ],
    [
      'email changed since',
      'new@example.com',
      row({ status: 'ACCEPTED' }),
      'NOT_SENT',
    ],
  ] as const)('%s', (_, email, latest, expected) => {
    expect(invitationState(email, latest, now).status).toBe(expected);
  });
});

describe('TrustedContactInvitationsService.send', () => {
  it('stores only the SHA-256 of a fresh token, 7-day expiry, sends via EmailProvider', async () => {
    const { db, email, service } = setup();
    expect(await service.send('owner-a', 'tc-1')).toBe(true);

    const { data } = db.trustedContactInvitation.create.mock.calls[0][0];
    const sent = email.send.mock.calls[0][0];
    const token = /token=([A-Za-z0-9_-]{43})/.exec(sent.text)![1];
    expect(data.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(data)).not.toContain(token);
    expect(data.emailNormalized).toBe('david@example.com');
    expect(data.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      7 * 24 * HOUR - 60_000,
    );

    expect(sent).toMatchObject({
      kind: 'trusted-contact-invitation',
      to: 'david@example.com',
    });
    expect(sent.text).toContain(
      'https://app.test/trusted-contact/invitation?token=',
    );
    expect(sent.text).toContain('Lisa Test');
    // The audit row never carries the token.
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain(token);
  });

  it('locks the Customer row and cancels any pending invitation first (resend)', async () => {
    const { db, service } = setup();
    await service.send('owner-a', 'tc-1');
    expect(db.$queryRaw.mock.calls[0][0].join('')).toMatch(/FOR UPDATE/);
    expect(db.trustedContactInvitation.updateMany).toHaveBeenCalledWith({
      where: { trustedContactId: 'tc-1', status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
    });
  });

  it('foreign / removed contact → 404, nothing sent', async () => {
    const { email, service } = setup(null);
    await expect(service.send('owner-b', 'tc-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(email.send).not.toHaveBeenCalled();
  });

  it('mobile-only contact → 409; no SMS or any other send is attempted', async () => {
    const { email, service } = setup({
      email: null,
      invitations: [],
      owner: {},
    });
    await expect(service.send('owner-a', 'tc-1')).rejects.toThrow(
      ConflictException,
    );
    expect(email.send).not.toHaveBeenCalled();
  });

  it('already accepted → 409', async () => {
    const { service } = setup({
      email: 'd@example.com',
      owner: {},
      invitations: [
        {
          status: 'ACCEPTED',
          emailNormalized: 'd@example.com',
          expiresAt: new Date(),
          createdAt: new Date(),
        },
      ],
    });
    await expect(service.send('owner-a', 'tc-1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('3 sends in the last hour → 429', async () => {
    const { db, service } = setup();
    db.trustedContactInvitation.count.mockResolvedValue(3);
    await expect(service.send('owner-a', 'tc-1')).rejects.toThrow(
      HttpException,
    );
    expect(db.trustedContactInvitation.create).not.toHaveBeenCalled();
  });

  it('a failed send cancels the new link and reports false', async () => {
    const { db, email, service } = setup();
    email.send.mockRejectedValue(new Error('provider down'));
    expect(await service.send('owner-a', 'tc-1')).toBe(false);
    expect(db.trustedContactInvitation.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'inv-1', status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
    });
  });
});

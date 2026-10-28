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
import { SmsSendError, type SmsSender } from '../sms/sms-sender.js';
import {
  invitationState,
  SMS_SENDS_PER_CUSTOMER_PER_DAY,
  trustedContactReadiness,
  TrustedContactInvitationsService,
} from './trusted-contact-invitations.service.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const HOUR = 3_600_000;

const setup = (
  contact: object | null = {
    firstName: 'David',
    email: 'david@example.com',
    mobile: '+61400000123',
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
  const sms = { send: vi.fn().mockResolvedValue(undefined) };
  const service = new TrustedContactInvitationsService(
    {
      ...db,
      $transaction: (fn: (tx: typeof db) => unknown) => fn(db),
    } as unknown as PrismaService,
    email as unknown as EmailProvider,
    sms as unknown as SmsSender,
    { settings: { appBaseUrl: 'https://app.test' } } as EmailConfig,
    { get: () => undefined } as unknown as ConfigService,
  );
  return { db, email, sms, service };
};

describe('invitationState', () => {
  const now = new Date('2026-10-06T00:00:00Z');
  const row = (over: object = {}) => ({
    status: 'PENDING' as const,
    emailNormalized: 'd@example.com' as string | null,
    mobile: null as string | null,
    expiresAt: new Date(now.getTime() + HOUR),
    createdAt: now,
    ...over,
  });
  const sms = (over: object = {}) =>
    row({ emailNormalized: null, mobile: '+61400000001', ...over });

  it.each([
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
    expect(
      invitationState({ email, mobile: null }, latest, now).status,
    ).toBe(expected);
  });

  it.each([
    ['SMS pending (mobile-only)', null, '+61400000001', sms(), 'PENDING'],
    ['SMS accepted, email added later', 'n@example.com', '+61400000001', sms({ status: 'ACCEPTED' }), 'ACCEPTED'],
    ['SMS sent, mobile changed since', null, '+61400000002', sms({ status: 'ACCEPTED' }), 'NOT_SENT'],
    ['SMS sent, mobile removed', 'd@example.com', null, sms(), 'NOT_SENT'],
    ['email sent, mobile changed: email link unaffected', 'd@example.com', '+61400000009', row(), 'PENDING'],
  ] as const)('%s', (_, email, mobile, latest, expected) => {
    const state = invitationState({ email, mobile }, latest, now);
    expect(state.status).toBe(expected);
    expect(state.channel).toBe(
      expected === 'NOT_SENT' ? null : latest.mobile ? 'SMS' : 'EMAIL',
    );
  });
});

// Setup health (2026-10-14): one derived definition, never stored.
describe('trustedContactReadiness', () => {
  const now = new Date('2026-10-06T00:00:00Z');
  const accepted = new Date('2026-10-05T00:00:00Z');
  const row = (over: object = {}) => ({
    status: 'PENDING' as const,
    emailNormalized: 'd@example.com',
    mobile: null,
    expiresAt: new Date(now.getTime() + HOUR),
    acceptedAt: null,
    createdAt: now,
    ...over,
  });

  it.each([
    ['accepted → READY', 'd@example.com', row({ status: 'ACCEPTED', acceptedAt: accepted }), 'READY', null],
    ['pending', 'd@example.com', row(), 'INVITATION_PENDING', null],
    ['expired', 'd@example.com', row({ expiresAt: now }), 'INVITATION_EXPIRED', null],
    ['declined', 'd@example.com', row({ status: 'DECLINED' }), 'ACTION_NEEDED', 'DECLINED'],
    ['never sent', 'd@example.com', undefined, 'ACTION_NEEDED', 'NOT_SENT'],
    ['send failed (cancelled)', 'd@example.com', row({ status: 'CANCELLED' }), 'ACTION_NEEDED', 'NOT_SENT'],
    ['accepted, then the email changed', 'new@example.com', row({ status: 'ACCEPTED', acceptedAt: accepted }), 'ACTION_NEEDED', 'NOT_SENT'],
    ['mobile-only, never invited', null, undefined, 'ACTION_NEEDED', 'NOT_SENT'],
    [
      'mobile-only, accepted an SMS invitation → READY',
      null,
      row({ status: 'ACCEPTED', acceptedAt: accepted, emailNormalized: null, mobile: '+61400000001' }),
      'READY',
      null,
    ],
  ] as const)('%s', (_, email, latest, status, reason) => {
    const r = trustedContactReadiness({ email, mobile: '+61400000001' }, latest, now);
    expect([r.status, r.reason]).toEqual([status, reason]);
    expect(r.invitationAcceptedAt).toEqual(status === 'READY' ? accepted : null);
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
    expect(sent.text).toContain('Dear David,');
    expect(sent.text).toContain('https://forafter.com.au/about/');
    expect(sent.subject).toBe(
      "You've been invited to be a Trusted Contact for Lisa Test",
    );
    // The audit row never carries the token.
    expect(JSON.stringify(db.auditLog.create.mock.calls)).not.toContain(token);
  });

  it('locks the Customer row and cancels any pending invitation first (resend)', async () => {
    const { db, email, service } = setup();
    await service.send('owner-a', 'tc-1');
    await service.send('owner-a', 'tc-1');
    // The resend uses the same full template, with a fresh link.
    const [first, second] = email.send.mock.calls.map((c) => c[0]);
    expect(second.text).toContain('What does being a Trusted Contact involve?');
    expect(second.html).toContain('Learn more about For After');
    expect(second.text).not.toBe(first.text);
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

  it('EMAIL without an email → 409; never falls back to SMS', async () => {
    const { db, email, sms, service } = setup({
      email: null,
      mobile: '+61400000123',
      invitations: [],
      owner: {},
    });
    await expect(service.send('owner-a', 'tc-1', 'EMAIL')).rejects.toThrow(
      'no email address',
    );
    expect(email.send).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(db.trustedContactInvitation.create).not.toHaveBeenCalled();
  });

  it('SMS without a mobile → 409; never falls back to email', async () => {
    const { db, email, sms, service } = setup({
      email: 'd@example.com',
      mobile: null,
      invitations: [],
      owner: {},
    });
    const err = await service
      .send('owner-a', 'tc-1', 'SMS')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/no mobile number/);
    expect(email.send).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
    expect(db.trustedContactInvitation.create).not.toHaveBeenCalled();
  });

  it('SMS: same token scheme, stored mobile as destination, short neutral text with the same link', async () => {
    const { db, email, sms, service } = setup();
    expect(await service.send('owner-a', 'tc-1', 'SMS')).toBe(true);
    expect(email.send).not.toHaveBeenCalled();
    const { to, body } = sms.send.mock.calls[0][0];
    expect(to).toBe('+61400000123');
    const token = /token=([A-Za-z0-9_-]{43})/.exec(body)![1];
    const { data } = db.trustedContactInvitation.create.mock.calls[0][0];
    expect(data).toMatchObject({
      tokenHash: sha256(token),
      mobile: '+61400000123',
      emailNormalized: null,
    });
    expect(JSON.stringify(data)).not.toContain(token);
    expect(body).toBe(
      `For After: You've been nominated as a trusted contact. Review your invitation here: https://app.test/trusted-contact/invitation?token=${token} This link expires in 7 days.`,
    );
    // GSM-7 only (no curly quotes), at most two segments; no names or addresses.
    expect(body).toMatch(/^[\x20-\x7E]+$/);
    expect(body.length).toBeLessThanOrEqual(306);
    for (const leak of ['Lisa', 'david@example.com', '+61400000123']) {
      expect(body).not.toContain(leak);
    }
  });

  it('SMS: capped per Customer per day across contacts (removed ones too) → 429', async () => {
    const { db, sms, service } = setup();
    db.trustedContactInvitation.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(SMS_SENDS_PER_CUSTOMER_PER_DAY);
    await expect(service.send('owner-a', 'tc-1', 'SMS')).rejects.toThrow(
      HttpException,
    );
    expect(db.trustedContactInvitation.count).toHaveBeenLastCalledWith({
      where: {
        mobile: { not: null },
        createdAt: { gt: expect.any(Date) },
        trustedContact: { ownerUserId: 'owner-a' },
      },
    });
    expect(db.trustedContactInvitation.create).not.toHaveBeenCalled();
    expect(sms.send).not.toHaveBeenCalled();
  });

  it('SMS provider failure: link cancelled, false, only the safe code logged', async () => {
    const { db, sms, service } = setup();
    const logged = vi
      .spyOn(service['logger'], 'error')
      .mockImplementation(() => undefined);
    sms.send.mockRejectedValue(new SmsSendError('twilio_21610'));
    expect(await service.send('owner-a', 'tc-1', 'SMS')).toBe(false);
    expect(db.trustedContactInvitation.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'inv-1', status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date) },
    });
    const line = String(logged.mock.calls[0][0]);
    expect(line).toContain('channel SMS (code: twilio_21610)');
    expect(line).not.toContain('+61400000123');
  });

  it('already accepted → 409', async () => {
    const { service } = setup({
      email: 'd@example.com',
      mobile: null,
      owner: {},
      invitations: [
        {
          status: 'ACCEPTED',
          emailNormalized: 'd@example.com',
          mobile: null,
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

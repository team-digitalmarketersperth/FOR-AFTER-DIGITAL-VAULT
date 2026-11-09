import { ConfigService } from '@nestjs/config';
import { readUnsubscribe, signUnsubscribe, suppress } from '../communications/communications.service.js';
import { announcement, UNSUBSCRIBE_NOTICE } from '../email/email-templates.js';
import type { Prisma } from '../generated/prisma/client.js';
import { broadcastSettings } from './announcement-broadcast-queue.service.js';
import { emailHash, skipReason } from './announcement-broadcast.processor.js';
import { readReview, signReview, unsubscribePlaceholder } from './announcement-broadcast.service.js';

const SECRET = 'unit-test-secret-not-real-0123456789abcdef';
const claims = { a: 'ann', v: 2, u: 'admin', n: 10, p: 'policy-1', s: 'PILOT' as const, m: 'members', exp: Date.now() + 60_000 };
const config = (env: Record<string, string>) => new ConfigService({ REDIS_URL: 'redis://127.0.0.1:6390', ...env });

describe('broadcast review token', () => {
  it('round-trips; any change (count, audience, pilot members), another key, expiry or junk is refused', () => {
    const token = signReview(claims, SECRET);
    expect(readReview(token, SECRET)).toEqual(claims);
    const [body, sig] = token.split('.');
    for (const change of [{ n: 1_000_000 }, { s: 'ALL_ELIGIBLE' }, { m: 'other-members' }]) {
      const altered = Buffer.from(JSON.stringify({ ...claims, ...change })).toString('base64url');
      expect(readReview(`${altered}.${sig}`, SECRET)).toBeNull();
    }
    expect(readReview(token, `${SECRET}x`)).toBeNull();
    expect(readReview(signReview({ ...claims, exp: Date.now() - 1 }, SECRET), SECRET)).toBeNull();
    for (const junk of ['', 'a', 'a.b', `${body}.${sig}.x`, `${body}.`]) expect(readReview(junk, SECRET)).toBeNull();
  });
});

describe('send-time recheck', () => {
  const ok = {
    role: 'CUSTOMER',
    status: 'ACTIVE',
    deletedAt: null,
    email: 'Cara@Example.test',
    emailVerifiedAt: new Date(),
    marketingConsentAt: new Date(),
  } as const;
  const hash = emailHash('cara@example.test');
  const clear = { openDeathReport: false, suppressed: false };

  it('sends only to the same verified, consenting, unsuppressed address of an active Customer, in the review order', () => {
    expect(skipReason(ok, hash, clear)).toBeNull();
    expect(skipReason(null, hash, clear)).toBe('account_unavailable');
    expect(skipReason({ ...ok, role: 'ADMIN' }, hash, clear)).toBe('account_unavailable');
    expect(skipReason({ ...ok, status: 'SUSPENDED' }, hash, clear)).toBe('account_unavailable');
    expect(skipReason({ ...ok, status: 'PASSED' }, hash, clear)).toBe('account_unavailable');
    expect(skipReason({ ...ok, deletedAt: new Date() }, hash, clear)).toBe('account_unavailable');
    expect(skipReason({ ...ok, email: 'not-an-address' }, hash, clear)).toBe('email_invalid');
    expect(skipReason({ ...ok, emailVerifiedAt: null }, hash, clear)).toBe('email_not_verified');
    expect(skipReason({ ...ok, email: 'new@example.test' }, hash, clear)).toBe('email_changed');
    expect(skipReason(ok, hash, { ...clear, openDeathReport: true })).toBe('open_death_report');
    expect(skipReason(ok, hash, { ...clear, suppressed: true })).toBe('suppressed');
    expect(skipReason({ ...ok, marketingConsentAt: null }, hash, clear)).toBe('no_consent');
    // Order: a death report outranks suppression, which outranks missing consent.
    expect(skipReason({ ...ok, marketingConsentAt: null }, hash, { openDeathReport: true, suppressed: true })).toBe('open_death_report');
  });
});

describe('broadcast settings', () => {
  it('gate: off unless "pilot" or exactly "true"; 10/min and 2000/day by default; mailbox limits enforced', () => {
    const s = broadcastSettings(config({}));
    expect(s.mode()).toBe('off');
    for (const v of ['TRUE', 'yes', '1', 'Pilot']) expect(broadcastSettings(config({ ANNOUNCEMENT_BROADCAST_ENABLED: v })).mode()).toBe('off');
    expect(broadcastSettings(config({ ANNOUNCEMENT_BROADCAST_ENABLED: 'pilot' })).mode()).toBe('pilot');
    expect(broadcastSettings(config({ ANNOUNCEMENT_BROADCAST_ENABLED: 'true' })).mode()).toBe('all');
    expect([s.ratePerMinute, s.dailyLimit, s.queueName]).toEqual([10, 2000, 'announcement-broadcast']);
    expect(() => broadcastSettings(config({ ANNOUNCEMENT_BROADCAST_RATE_PER_MINUTE: '31' }))).toThrow(/at most 30/);
    expect(() => broadcastSettings(config({ ANNOUNCEMENT_BROADCAST_DAILY_LIMIT: '10001' }))).toThrow(/at most 10000/);
    expect(() => broadcastSettings(config({ ANNOUNCEMENT_BROADCAST_RATE_PER_MINUTE: '0' }))).toThrow();
  });
});

describe('unsubscribe link', () => {
  it('a signed, per-recipient token: account + address hash; altered, re-keyed or malformed tokens are refused', () => {
    const hash = emailHash('cara@example.test');
    const token = signUnsubscribe('user-1', hash, SECRET);
    expect(readUnsubscribe(token, SECRET)).toEqual({ u: 'user-1', h: hash });
    const [, sig] = token.split('.');
    const other = Buffer.from(JSON.stringify({ u: 'user-2', h: hash })).toString('base64url');
    expect(readUnsubscribe(`${other}.${sig}`, SECRET)).toBeNull();
    expect(readUnsubscribe(token, `${SECRET}x`)).toBeNull();
    const badHash = signUnsubscribe('user-1', 'not-a-hash', SECRET);
    expect(readUnsubscribe(badHash, SECRET)).toBeNull();
    for (const junk of ['', 'a', 'a.b', `${token}.x`]) expect(readUnsubscribe(junk, SECRET)).toBeNull();
  });

  it('every announcement email carries the notice and the link; a run placeholder survives escaping and is unguessable per run', () => {
    const placeholder = unsubscribePlaceholder('0f8fad5b-d9cb-469f-a165-70867728950e');
    const e = announcement({ subject: 'Hi', body: 'Body with {{UNSUBSCRIBE}} & <b>', cta: null }, 'https://app.example.test', false, placeholder);
    expect(e.html).toContain(`href="${placeholder}"`);
    expect(e.text).toContain(`Unsubscribe: ${placeholder}`);
    expect(e.html).toContain('receiving this because you chose to hear news from For After.');
    expect(e.html).not.toContain('<b>'); // the body stays escaped
    expect(e.text).toContain(UNSUBSCRIBE_NOTICE);
    expect(placeholder).toMatch(/^__FA_UNSUBSCRIBE_[0-9a-f]{32}__$/);
    // Preview/test emails show an inert sample link.
    expect(announcement({ subject: 'Hi', body: 'B', cta: null }, 'https://app.example.test').html).toContain('href="https://app.example.test/unsubscribe"');
  });
});

describe('suppression list', () => {
  const db = (existing: { id: string; reason: 'UNSUBSCRIBED' | 'HARD_BOUNCE' | 'COMPLAINT' } | null) => {
    const calls: string[] = [];
    const tx = {
      emailSuppression: {
        findUnique: vi.fn(async () => existing),
        create: vi.fn(async () => (calls.push('create'), { id: 's1' })),
        update: vi.fn(async () => (calls.push('update'), { id: existing!.id })),
      },
      auditLog: { create: vi.fn(async () => (calls.push('audit'), {})) },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, calls };
  };

  it('adds once, only strengthens (unsubscribe < hard bounce < complaint), and audits without the address or hash', async () => {
    let t = db(null);
    expect(await suppress(t.tx, { emailHash: 'h', reason: 'UNSUBSCRIBED', userId: 'u1' })).toBe(true);
    expect(t.calls).toEqual(['create', 'audit']);
    t = db({ id: 's1', reason: 'HARD_BOUNCE' });
    expect(await suppress(t.tx, { emailHash: 'h', reason: 'UNSUBSCRIBED', userId: 'u1' })).toBe(false);
    expect(t.calls).toEqual([]);
    t = db({ id: 's1', reason: 'UNSUBSCRIBED' });
    expect(await suppress(t.tx, { emailHash: 'h', reason: 'COMPLAINT', userId: null })).toBe(true);
    expect(t.calls).toEqual(['update', 'audit']);
    const audit = JSON.stringify((t.tx as unknown as { auditLog: { create: ReturnType<typeof vi.fn> } }).auditLog.create.mock.calls);
    expect(audit).not.toContain('"h"');
  });
});

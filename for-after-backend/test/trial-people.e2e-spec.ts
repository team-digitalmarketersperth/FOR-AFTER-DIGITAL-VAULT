import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { TRIAL_CONTACT_LIMIT, TRIAL_DAYS, TRIAL_LIMIT, TRIAL_RECIPIENT_LIMIT } from '../src/billing/billing-access.js';
import { BILLING_REQUIRED } from '../src/billing/billing-access.interceptor.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { SmsSender } from '../src/sms/sms-sender.js';
import { SmsVerification } from '../src/sms/sms-verification.js';
import { MAX_REACHED } from '../src/trusted-contacts/trusted-contacts.service.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';
import { FakeEmailProvider } from './fake-email.js';

// Trial restrictions Step 3: one Recipient and one Trusted Contact during an enforced active trial. Real PostgreSQL
// (row locks); fake email inbox and SMS (nothing is ever sent); Stripe unconfigured (never called).
describe('Trial people caps (e2e, PostgreSQL)', () => {
  const DAY = 86_400_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const names = ['tia', 'con', 'paid', 'old', 'eve'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `trialpeople.${n}.${run}@example.test`])) as Record<Name, string>;
  const password = 'StrongPassword123!';
  const inbox = new FakeEmailProvider();
  const texts: unknown[] = [];
  const phone = { name: 'fake', send: (m: unknown) => (texts.push(m), Promise.resolve()) } satisfies SmsSender;
  const verify = { name: 'fake', send: vi.fn(), check: vi.fn() } satisfies SmsVerification;
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<Name, Agent>;
  const ids = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    THROTTLE_KEY_PREFIX: `for_after:test_trial_people_throttle:${run}:`,
  };

  const addPerson = (n: Name, firstName = 'Fictional') => agents[n].post(api('/recipients')).send({ firstName });
  const addContact = (n: Name, body: object) => agents[n].post(api('/trusted-contacts')).send({ firstName: 'Fictional', ...body });
  const mobile = (i: number) => ({ mobile: `+6140000${String(1000 + i)}` });
  const live = (n: Name) => ({
    recipients: prisma.recipient.count({ where: { ownerUserId: ids[n], deletedAt: null } }),
    contacts: prisma.trustedContact.count({ where: { ownerUserId: ids[n], deletedAt: null } }),
  });
  const trialRow = (n: Name, endsAt: Date) => prisma.customerTrial.create({ data: { userId: ids[n], startedAt: new Date(endsAt.getTime() - TRIAL_DAYS * DAY), endsAt } });
  const expectTrialLimit = (res: request.Response, message: string) => {
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ statusCode: 409, code: TRIAL_LIMIT, message });
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, RecipientsModule, TrustedContactsModule],
    })
      .overrideProvider(EmailProvider)
      .useValue(inbox)
      .overrideProvider(SmsSender)
      .useValue(phone)
      .overrideProvider(SmsVerification)
      .useValue(verify)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    // Synthetic verified Customers, seeded directly (the register route's per-IP limit is shared with other suites).
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    for (const n of names) {
      ids[n] = (
        await prisma.user.create({
          data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() },
          select: { id: true },
        })
      ).id;
    }
    // An account from before billing enforcement (rollout rule).
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - DAY) } });
    for (const n of names) {
      const agent = request.agent(app.getHttpServer());
      await agent.post(api('/auth/login')).send({ email: emails[n], password }).expect(200);
      agents[n] = agent;
    }
  });

  afterAll(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  it('before a trial starts (trial_available): creation stays refused by the gate (402), not the trial cap', async () => {
    const res = await addPerson('tia').expect(402);
    expect(res.body.message).toBe(BILLING_REQUIRED);
    await addContact('tia', mobile(1)).expect(402);
    const status = (await agents.tia.post(api('/billing/trial')).send({}).expect(200)).body;
    expect(status.state).toBe('trial_active');
    expect(status.trialCaps).toEqual({ recipients: 1, trustedContacts: 1, questions: 4, memories: 1 });
  });

  it('Recipients: first succeeds, second is TRIAL_LIMIT; editing works; delete frees the slot; recreate respects the cap', async () => {
    const first = (await addPerson('tia', 'Sofia').expect(201)).body;
    expectTrialLimit(await addPerson('tia', 'Second'), TRIAL_RECIPIENT_LIMIT);
    expect((await live('tia').recipients)).toBe(1);
    await agents.tia.patch(api(`/recipients/${first.id}`)).send({ relationship: 'Daughter' }).expect(200);
    expect(await live('tia').recipients).toBe(1);
    await agents.tia.delete(api(`/recipients/${first.id}`)).expect(204);
    const again = (await addPerson('tia', 'Mia').expect(201)).body;
    expectTrialLimit(await addPerson('tia', 'Third'), TRIAL_RECIPIENT_LIMIT);
    expect(again.id).not.toBe(first.id);
    expect(await live('tia').recipients).toBe(1);
  });

  it('Trusted Contacts: a pending invitation uses the slot; resend and edit add nothing; the refusal sends nothing; delete frees it', async () => {
    const sentBefore = inbox.sent.length;
    const first = (await addContact('tia', { email: `tc.first.${run}@example.test` }).expect(201)).body;
    expect(first.invitation.status).toBe('PENDING');
    expect(inbox.sent.length).toBe(sentBefore + 1);
    expectTrialLimit(await addContact('tia', { email: `tc.second.${run}@example.test` }), TRIAL_CONTACT_LIMIT);
    expect(inbox.sent.length).toBe(sentBefore + 1); // no invitation for a refused contact
    // Resend through the existing route (its own per-contact limit applies): no new contact.
    await agents.tia.post(api(`/trusted-contacts/${first.id}/invitation`)).send({ channel: 'EMAIL' }).expect(200);
    await agents.tia.patch(api(`/trusted-contacts/${first.id}`)).send({ relationship: 'Brother' }).expect(200);
    expect(await live('tia').contacts).toBe(1);
    await agents.tia.delete(api(`/trusted-contacts/${first.id}`)).expect(204);
    await addContact('tia', mobile(2)).expect(201);
    expectTrialLimit(await addContact('tia', mobile(3)), TRIAL_CONTACT_LIMIT);
    expect(await live('tia').contacts).toBe(1);
  });

  it('Updated Plans Step 7: GET /billing people reports the trial caps and live counts', async () => {
    const people = (await agents.tia.get(api('/billing')).expect(200)).body.people;
    expect(people.recipients).toMatchObject({ used: await prisma.recipient.count({ where: { ownerUserId: ids.tia, deletedAt: null } }), limit: 1, limitSource: 'trial' });
    expect(people.trustedContacts).toMatchObject({ used: await prisma.trustedContact.count({ where: { ownerUserId: ids.tia, deletedAt: null } }), limit: 1, limitSource: 'trial' });
  });

  it('a declined contact still counts toward the trial slot', async () => {
    const [contact] = await prisma.trustedContact.findMany({ where: { ownerUserId: ids.tia, deletedAt: null }, select: { id: true } });
    await prisma.trustedContactInvitation.create({
      data: { trustedContactId: contact.id, tokenHash: `declined-${run}`, mobile: '+61400001002', status: 'DECLINED', expiresAt: new Date(Date.now() + DAY), declinedAt: new Date() },
    });
    expectTrialLimit(await addContact('tia', mobile(4)), TRIAL_CONTACT_LIMIT);
  });

  it('concurrent creates from zero: exactly one of each succeeds', async () => {
    await agents.con.post(api('/billing/trial')).send({}).expect(200);
    const people = await Promise.all(Array.from({ length: 5 }, (_, i) => addPerson('con', `P${i}`)));
    expect(people.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409, 409, 409, 409]);
    expect(people.filter((r) => r.status === 409).every((r) => r.body.code === TRIAL_LIMIT)).toBe(true);
    const contacts = await Promise.all(Array.from({ length: 5 }, (_, i) => addContact('con', mobile(10 + i))));
    expect(contacts.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 409, 409, 409, 409]);
    expect(await live('con').recipients).toBe(1);
    expect(await live('con').contacts).toBe(1);
  });

  it('ownership: another Customer cannot edit or delete these records, and their attempts change no count', async () => {
    const [mine] = (await agents.tia.get(api('/recipients')).expect(200)).body.items;
    const [contact] = (await agents.tia.get(api('/trusted-contacts')).expect(200)).body;
    await agents.con.patch(api(`/recipients/${mine.id}`)).send({ firstName: 'Taken' }).expect(404);
    await agents.con.delete(api(`/recipients/${mine.id}`)).expect(404);
    await agents.con.delete(api(`/trusted-contacts/${contact.id}`)).expect(404);
    expect(await live('tia').recipients).toBe(1);
    expect(await live('tia').contacts).toBe(1);
    expect(await live('con').recipients).toBe(1);
  });

  it('existing excess records stay listed and editable; only new creation is refused', async () => {
    // Con (active trial) now has one of each; two more people and a second contact from before the trial cap
    // (e.g. created while billing was off) put the account over the trial allowance.
    await prisma.recipient.createMany({ data: ['A', 'B'].map((firstName) => ({ ownerUserId: ids.con, firstName })) });
    await prisma.trustedContact.create({ data: { ownerUserId: ids.con, firstName: 'TC2', ...mobile(21) } });
    const people = (await agents.con.get(api('/recipients')).expect(200)).body;
    expect(people.pagination.total).toBe(3);
    expect((await agents.con.get(api('/trusted-contacts')).expect(200)).body).toHaveLength(2);
    await agents.con.patch(api(`/recipients/${people.items[0].id}`)).send({ relationship: 'Friend' }).expect(200);
    expectTrialLimit(await addPerson('con'), TRIAL_RECIPIENT_LIMIT);
    // Two contacts is the product maximum for everyone: the existing refusal, without the plan offer.
    const tc = await addContact('con', mobile(30)).expect(409);
    expect(tc.body.message).toBe(MAX_REACHED);
    expect(tc.body.code).toBeUndefined();
    // Removing one excess person still leaves the trial's one slot used.
    await agents.con.delete(api(`/recipients/${people.items[0].id}`)).expect(204);
    expectTrialLimit(await addPerson('con'), TRIAL_RECIPIENT_LIMIT);
    expect(await live('con').recipients).toBe(2);
    expect(await live('con').contacts).toBe(2);
  });

  it('paid access (over active trial dates) and grandfathered accounts keep the existing limits', async () => {
    await trialRow('paid', new Date(Date.now() + DAY));
    await prisma.billingAccount.create({
      data: { userId: ids.paid, stripeCustomerId: `cus_fictional_people_${run}`, livemode: false, plan: 'monthly', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
    });
    for (const n of ['paid', 'old'] as const) {
      expect((await agents[n].get(api('/billing')).expect(200)).body.trialCaps).toEqual({ recipients: null, trustedContacts: null, questions: null, memories: null });
      await addPerson(n, 'One').expect(201);
      await addPerson(n, 'Two').expect(201);
      await addPerson(n, 'Three').expect(201);
      await addContact(n, mobile(40)).expect(201);
      await addContact(n, mobile(41)).expect(201);
      expect((await addContact(n, mobile(42)).expect(409)).body.message).toBe(MAX_REACHED);
    }
  });

  it('an expired trial stays refused by the gate (402), with its records intact', async () => {
    await prisma.recipient.create({ data: { ownerUserId: ids.eve, firstName: 'Kept' } });
    await trialRow('eve', new Date(Date.now() - 1000));
    expect((await agents.eve.get(api('/billing')).expect(200)).body.trialCaps).toEqual({ recipients: null, trustedContacts: null, questions: null, memories: null });
    expect((await addPerson('eve').expect(402)).body.message).toBe(BILLING_REQUIRED);
    await addContact('eve', mobile(50)).expect(402);
    expect((await agents.eve.get(api('/recipients')).expect(200)).body.pagination.total).toBe(1);
    expect(texts).toEqual([]); // no SMS was ever sent by this suite
  });
});

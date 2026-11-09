import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import session from 'express-session';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { FakeEmailProvider } from './fake-email.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
// MessagesModule only for the 401 check with a Trusted Contact session.
import { MessagesModule } from '../src/messages/messages.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { SmsSendError, SmsSender } from '../src/sms/sms-sender.js';
import { SmsVerification } from '../src/sms/sms-verification.js';
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactPortalModule } from '../src/trusted-contact-portal/trusted-contact-portal.module.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Phase 10 end to end: the two-contact maximum (incl. concurrent creates) and
// email invitations through the real API, PostgreSQL and Redis. Emails land in
// a fake inbox (EmailProvider), so the token is read exactly as an invitee
// would: from the email. Only fictional data; users are deleted afterwards.
describe('Trusted Contact maximum + email invitations (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const inbox = new FakeEmailProvider();
  // FakeSmsSender: records texts; never reaches Twilio. `failNext` simulates an outage.
  const texts: { to: string; body: string }[] = [];
  let smsFailNext = false;
  const phone = {
    name: 'fake',
    send(message: { to: string; body: string }) {
      if (smsFailNext) {
        smsFailNext = false;
        return Promise.reject(new SmsSendError('twilio_30003'));
      }
      texts.push(message);
      return Promise.resolve();
    },
  } satisfies SmsSender;
  // Twilio Verify (sign-in codes) must never be touched by an invitation.
  const verify = { name: 'fake', send: vi.fn(), check: vi.fn() } satisfies SmsVerification;
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const LISA = at('inv.lisa');
  const JOHN = at('inv.john');
  const NORA = at('inv.nora');
  const RITA = at('inv.rita');
  const password = 'StrongPassword123!';
  const api = (path: string) => `/api/v1${path}`;
  const http = () => request(app.getHttpServer());
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  type Agent = ReturnType<typeof request.agent>;
  let lisa: Agent;
  let john: Agent;
  let nora: Agent;

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent.post(api('/auth/login')).send({ email, password }).expect(200);
    return agent;
  };
  const add = (agent: Agent, body: object) =>
    agent.post(api('/trusted-contacts')).send(body);
  /** The token from the newest invitation SMS to `mobile`. */
  const smsTokenFor = (mobile: string) => {
    const text = texts.filter((t) => t.to === mobile).at(-1);
    return /token=([A-Za-z0-9_-]{43})/.exec(text!.body)![1];
  };
  /** The token from the newest invitation email to `email`. */
  const tokenFor = (email: string) => {
    const mail = inbox.to(email, 'trusted-contact-invitation').at(-1);
    return /token=([A-Za-z0-9_-]{43})/.exec(mail!.text)![1];
  };
  const invitation = (action: 'view' | 'accept' | 'decline', token: string) =>
    http()
      .post(api(`/trusted-contact/invitation/${action}`))
      .send({ token });
  const contact = async (agent: Agent, id: string) =>
    (await agent.get(api(`/trusted-contacts/${id}`)).expect(200)).body;
  const activeCount = (ownerEmail: string) =>
    prisma.trustedContact.count({
      where: { owner: { email: ownerEmail }, deletedAt: null },
    });

  beforeAll(async () => {
    process.env.RELEASE_RECONCILE_INTERVAL_SECONDS = '3600';
    process.env.TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT = '10000';
    process.env.TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT = '10000';
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        TrustedContactsModule,
        MessagesModule,
        TrustedContactAuthModule,
        TrustedContactPortalModule,
      ],
    })
      // The invitation routes' per-IP limit is not under test here.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
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
    for (const email of [LISA, JOHN, NORA, RITA]) {
      await http()
        .post(api('/auth/register'))
        .send({
          email,
          password,
          firstName: email.split('.')[1],
          lastName: 'Test',
        })
        .expect(201);
    }
    [lisa, john, nora] = await Promise.all([LISA, JOHN, NORA].map(signIn));
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({
      where: { email: { in: [LISA, JOHN, NORA, RITA] } },
    });
    await app?.close();
  });

  describe('maximum two active Trusted Contacts', () => {
    const ids: string[] = [];

    it('0 → 1 → 2 succeed; a third is 409 and nothing is written', async () => {
      ids.push(
        (
          await add(john, { firstName: 'A', mobile: '+61400000001' }).expect(
            201,
          )
        ).body.id,
      );
      ids.push(
        (
          await add(john, { firstName: 'B', mobile: '+61400000002' }).expect(
            201,
          )
        ).body.id,
      );
      const third = await add(john, { firstName: 'C', email: at('c') }).expect(
        409,
      );
      expect(third.body.message).toMatch(/up to 2 trusted contacts/i);
      expect(await activeCount(JOHN)).toBe(2);
      // No invitation goes out for a refused contact.
      expect(inbox.to(at('c'))).toHaveLength(0);
    });

    it('another Customer’s count is irrelevant', async () => {
      await add(nora, { firstName: 'N', mobile: '+61400000009' }).expect(201);
      expect(await activeCount(NORA)).toBe(1);
    });

    it('removing one (soft delete) frees a place; edits stay possible at the limit', async () => {
      await john
        .patch(api(`/trusted-contacts/${ids[0]}`))
        .send({ relationship: 'Friend' })
        .expect(200);
      await john.delete(api(`/trusted-contacts/${ids[0]}`)).expect(204);
      await add(john, { firstName: 'D', mobile: '+61400000004' }).expect(201);
      expect(await activeCount(JOHN)).toBe(2);
      // The removed row still exists (history), it just does not count.
      expect(
        await prisma.trustedContact.count({
          where: { owner: { email: JOHN } },
        }),
      ).toBe(3);
    });

    it('concurrent creates can never produce a third active contact', async () => {
      // Nora has one; five requests race for the one remaining place.
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) =>
          add(nora, { firstName: `Race ${n}`, mobile: `+6140000010${n}` }),
        ),
      );
      const statuses = results.map((r) => r.status).sort((x, y) => x - y);
      expect(statuses).toEqual([201, 409, 409, 409, 409]);
      expect(await activeCount(NORA)).toBe(2);
    });
  });

  describe('email invitations', () => {
    let davidId: string;
    let davidToken: string;
    const DAVID = at('inv.david');
    const SARAH = at('inv.sarah');

    it('adding a contact with an email sends the invitation; only the token hash is stored', async () => {
      // Private content that must never reach an invitation or the portal.
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: LISA },
      });
      await prisma.message.create({
        data: {
          ownerUserId: owner.id,
          title: 'Secret title 4417',
          textContent: 'Secret body 4417',
        },
      });
      const res = await add(lisa, { firstName: 'David', email: DAVID }).expect(
        201,
      );
      davidId = res.body.id;
      expect(res.body.invitation).toEqual({
        status: 'PENDING',
        sentAt: expect.any(String),
        channel: 'EMAIL',
      });

      const mails = inbox.to(DAVID, 'trusted-contact-invitation');
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe(
        "You've been invited to be a Trusted Contact for lisa Test",
      );
      for (const part of [mails[0].text, mails[0].html]) {
        expect(part).not.toContain('Secret');
        expect(part).not.toContain(LISA);
        expect(part).toContain('Dear David,');
        expect(part).toContain('lisa Test has invited you');
        expect(part).toContain('What does being a Trusted Contact involve?');
        expect(part).toContain('https://forafter.com.au/about/');
        expect(part).toContain('expires in 7 days');
      }
      davidToken = tokenFor(DAVID);

      const rows = await prisma.trustedContactInvitation.findMany({
        where: { trustedContactId: davidId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'PENDING',
        tokenHash: sha256(davidToken),
      });
      expect(JSON.stringify(rows)).not.toContain(davidToken);
      // Technical default TTL: 7 days.
      const ttl = rows[0].expiresAt.getTime() - rows[0].createdAt.getTime();
      expect(Math.round(ttl / 86_400_000)).toBe(7);
      // The response never carries the token or the invitation rows.
      expect(JSON.stringify(res.body)).not.toContain(davidToken);
      expect(res.body).not.toHaveProperty('invitations');
    });

    it('the invitation page shows the account holder only; bad tokens are 400/404', async () => {
      const view = await invitation('view', davidToken).expect(200);
      expect(view.body).toEqual({
        status: 'PENDING',
        accountHolder: { displayName: 'lisa Test' },
      });
      await invitation('view', 'x'.repeat(43)).expect(404);
      await invitation('view', 'short').expect(400);
      await http()
        .post(api('/trusted-contact/invitation/view'))
        .send({})
        .expect(400);
    });

    it('accept → ACCEPTED, audited; no session is created by accepting', async () => {
      const res = await invitation('accept', davidToken).expect(200);
      expect(res.body.status).toBe('ACCEPTED');
      expect(res.headers['set-cookie']).toBeUndefined();
      expect((await contact(lisa, davidId)).invitation.status).toBe('ACCEPTED');
      // Accepting again is harmless; declining an accepted invitation does nothing.
      expect(
        (await invitation('accept', davidToken).expect(200)).body.status,
      ).toBe('ACCEPTED');
      expect(
        (await invitation('decline', davidToken).expect(200)).body.status,
      ).toBe('ACCEPTED');
      // Resending an accepted invitation is refused.
      await lisa
        .post(api(`/trusted-contacts/${davidId}/invitation`))
        .expect(409);

      const audit = await prisma.auditLog.findMany({
        where: { subjectType: 'TrustedContact', subjectId: davidId },
        orderBy: { createdAt: 'asc' },
      });
      expect(audit.map((a) => [a.eventType, a.actorType])).toEqual([
        ['TRUSTED_CONTACT_INVITATION_SENT', 'CUSTOMER'],
        ['TRUSTED_CONTACT_INVITATION_ACCEPTED', 'TRUSTED_CONTACT'],
      ]);
      expect(JSON.stringify(audit)).not.toContain(davidToken);
      expect(JSON.stringify(audit)).not.toContain(DAVID);
    });

    it('portal access still needs email OTP, and shows no preserved content', async () => {
      await http().get(api('/trusted-contact/accounts')).expect(401);
      const { challengeId } = (
        await http()
          .post(api('/trusted-contact-auth/request-otp'))
          .send({ email: DAVID })
          .expect(202)
      ).body;
      const david = request.agent(app.getHttpServer());
      await david
        .post(api('/trusted-contact-auth/verify-otp'))
        .send({ challengeId, code: inbox.code(DAVID) })
        .expect(200);
      const accounts = (
        await david.get(api('/trusted-contact/accounts')).expect(200)
      ).body;
      expect(accounts).toEqual([
        {
          trustedContactId: davidId,
          accountHolder: { displayName: 'lisa Test' },
          relationship: null,
          hasPreservedContent: true,
          deathVerificationStatus: null,
        },
      ]);
      expect(JSON.stringify(accounts)).not.toContain('Secret');
      await david.get(api('/messages')).expect(401);
    });

    it('resend supersedes the old link; decline; resend after decline works', async () => {
      const sarahId = (
        await add(lisa, { firstName: 'Sarah', email: SARAH }).expect(201)
      ).body.id;
      const first = tokenFor(SARAH);
      const resent = await lisa
        .post(api(`/trusted-contacts/${sarahId}/invitation`))
        .expect(200);
      expect(resent.body.invitation.status).toBe('PENDING');
      const second = tokenFor(SARAH);
      expect(second).not.toBe(first);

      // The superseded link is dead and cannot be accepted.
      expect((await invitation('view', first).expect(200)).body).toEqual({
        status: 'CANCELLED',
        accountHolder: null,
      });
      expect((await invitation('accept', first).expect(200)).body.status).toBe(
        'CANCELLED',
      );
      expect(
        await prisma.trustedContactInvitation.count({
          where: { trustedContactId: sarahId, status: 'PENDING' },
        }),
      ).toBe(1);

      expect(
        (await invitation('decline', second).expect(200)).body.status,
      ).toBe('DECLINED');
      expect((await invitation('accept', second).expect(200)).body.status).toBe(
        'DECLINED',
      );
      expect((await contact(lisa, sarahId)).invitation.status).toBe('DECLINED');

      // Capped at 3 per contact per hour (create + resend + this one = 3).
      await lisa
        .post(api(`/trusted-contacts/${sarahId}/invitation`))
        .expect(200);
      expect((await contact(lisa, sarahId)).invitation.status).toBe('PENDING');
      await lisa
        .post(api(`/trusted-contacts/${sarahId}/invitation`))
        .expect(429);
      expect(inbox.to(SARAH, 'trusted-contact-invitation')).toHaveLength(3);
    });

    it('an expired link shows EXPIRED and cannot be accepted', async () => {
      const sarah = await prisma.trustedContact.findFirstOrThrow({
        where: { email: SARAH },
      });
      await prisma.trustedContactInvitation.updateMany({
        where: { trustedContactId: sarah.id, status: 'PENDING' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const token = tokenFor(SARAH);
      expect((await invitation('view', token).expect(200)).body).toEqual({
        status: 'EXPIRED',
        accountHolder: null,
      });
      expect((await invitation('accept', token).expect(200)).body.status).toBe(
        'EXPIRED',
      );
      expect((await contact(lisa, sarah.id)).invitation.status).toBe('EXPIRED');
    });

    it('removing the contact kills a pending link', async () => {
      await lisa.delete(api(`/trusted-contacts/${davidId}`)).expect(204);
      const EVE = at('inv.eve');
      const eveId = (
        await add(lisa, { firstName: 'Eve', email: EVE }).expect(201)
      ).body.id;
      const token = tokenFor(EVE);
      await lisa.delete(api(`/trusted-contacts/${eveId}`)).expect(204);
      expect((await invitation('accept', token).expect(200)).body).toEqual({
        status: 'CANCELLED',
        accountHolder: null,
      });
      const row = await prisma.trustedContactInvitation.findFirstOrThrow({
        where: { trustedContactId: eveId },
      });
      expect(row.status).toBe('CANCELLED');
      expect(row.acceptedAt).toBeNull();
    });

    it('changing the email kills the old link and resets the state to NOT_SENT', async () => {
      const FRED = at('inv.fred');
      const fredId = (
        await add(lisa, { firstName: 'Fred', email: FRED }).expect(201)
      ).body.id;
      const token = tokenFor(FRED);
      const res = await lisa
        .patch(api(`/trusted-contacts/${fredId}`))
        .send({ email: at('inv.fred2') })
        .expect(200);
      expect(res.body.invitation).toEqual({
        status: 'NOT_SENT',
        sentAt: null,
        channel: null,
      });
      expect((await invitation('accept', token).expect(200)).body.status).toBe(
        'CANCELLED',
      );
      await lisa.delete(api(`/trusted-contacts/${fredId}`)).expect(204);
    });

    it('only the owner can send: another Customer gets 404; no session gets 401', async () => {
      const sarah = await prisma.trustedContact.findFirstOrThrow({
        where: { email: SARAH },
      });
      await john
        .post(api(`/trusted-contacts/${sarah.id}/invitation`))
        .expect(404);
      await http()
        .post(api(`/trusted-contacts/${sarah.id}/invitation`))
        .expect(401);
      await lisa
        .post(
          api(
            '/trusted-contacts/00000000-0000-4000-8000-000000000000/invitation',
          ),
        )
        .expect(404);
    });

    it('a failed send is reported (503) and never shows as Pending', async () => {
      const sarah = await prisma.trustedContact.findFirstOrThrow({
        where: { email: SARAH },
      });
      await prisma.trustedContactInvitation.updateMany({
        where: { trustedContactId: sarah.id },
        data: { createdAt: new Date(Date.now() - 2 * 3_600_000) },
      });
      inbox.failNextFor(SARAH, 1, 'network_error');
      await lisa
        .post(api(`/trusted-contacts/${sarah.id}/invitation`))
        .expect(503);
      expect((await contact(lisa, sarah.id)).invitation.status).toBe(
        'NOT_SENT',
      );
    });

    it('mobile-only: adding sends nothing automatically; EMAIL is 409 (no SMS fallback)', async () => {
      const before = { mails: inbox.sent.length, texts: texts.length };
      const res = await add(lisa, {
        firstName: 'Mo',
        mobile: '+61400000077',
      }).expect(201);
      expect(res.body.invitation).toEqual({
        status: 'NOT_SENT',
        sentAt: null,
        channel: null,
      });
      const refused = await lisa
        .post(api(`/trusted-contacts/${res.body.id}/invitation`))
        .send({ channel: 'EMAIL' })
        .expect(409);
      expect(refused.body.message).toMatch(/no email address/);
      // Omitting the channel means EMAIL, as before.
      await lisa
        .post(api(`/trusted-contacts/${res.body.id}/invitation`))
        .expect(409);
      expect(inbox.sent.length).toBe(before.mails);
      expect(texts.length).toBe(before.texts);
      expect(
        await prisma.trustedContactInvitation.count({
          where: { trustedContactId: res.body.id },
        }),
      ).toBe(0);
      await lisa.delete(api(`/trusted-contacts/${res.body.id}`)).expect(204);
    });
  });

  // 2026-10-17: SMS invitations (Twilio Programmable Messaging, faked here).
  // The same model, token scheme, acceptance endpoints and page as email.
  describe('SMS invitations', () => {
    const OWEN = at('inv.owen');
    const PAT = at('inv.pat');
    const MO = '+61400000301';
    let owen: Agent;
    let moId: string;
    const sendBy = (agent: Agent, id: string, channel?: unknown) =>
      agent
        .post(api(`/trusted-contacts/${id}/invitation`))
        .send(channel === undefined ? {} : { channel });

    beforeAll(async () => {
      for (const email of [OWEN, PAT]) {
        await http()
          .post(api('/auth/register'))
          .send({ email, password, firstName: 'owen', lastName: 'Test' })
          .expect(201);
      }
      owen = await signIn(OWEN);
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { email: { in: [OWEN, PAT] } } });
    });

    it('mobile-only: SMS invitation → same page → accept → READY; no session, no Verify call', async () => {
      moId = (await add(owen, { firstName: 'Mo', mobile: MO }).expect(201)).body.id;
      expect(texts.filter((t) => t.to === MO)).toHaveLength(0);

      const res = await sendBy(owen, moId, 'SMS').expect(200);
      expect(res.body.invitation).toEqual({
        status: 'PENDING',
        sentAt: expect.any(String),
        channel: 'SMS',
      });
      expect(res.body.readiness.status).toBe('INVITATION_PENDING');
      const [text] = texts.filter((t) => t.to === MO);
      expect(text.to).toMatch(/^\+[1-9]\d{7,14}$/);
      expect(text.body).toMatch(
        /^For After: You've been nominated as a trusted contact\. Review your invitation here: \S+\/trusted-contact\/invitation\?token=[A-Za-z0-9_-]{43} This link expires in 7 days\.$/,
      );
      expect(text.body).not.toMatch(/owen|@/i);

      const token = smsTokenFor(MO);
      const rows = await prisma.trustedContactInvitation.findMany({
        where: { trustedContactId: moId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'PENDING',
        mobile: MO,
        emailNormalized: null,
        tokenHash: sha256(token),
      });
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(JSON.stringify(res.body)).not.toContain(token);

      expect((await invitation('view', token).expect(200)).body).toEqual({
        status: 'PENDING',
        accountHolder: { displayName: 'owen Test' },
      });
      const accepted = await invitation('accept', token).expect(200);
      expect(accepted.body.status).toBe('ACCEPTED');
      expect(accepted.headers['set-cookie']).toBeUndefined();
      expect((await contact(owen, moId)).readiness.status).toBe('READY');
      // Ready grants nothing: the portal still needs a sign-in.
      await http().get(api('/trusted-contact/accounts')).expect(401);
      expect(verify.send).not.toHaveBeenCalled();
      expect(verify.check).not.toHaveBeenCalled();
      // Accepted → no re-invite on either channel.
      await sendBy(owen, moId, 'SMS').expect(409);
    });

    it('changing the mobile kills the SMS link and resets readiness; email unaffected', async () => {
      const both = (
        await add(owen, {
          firstName: 'Bo',
          email: at('inv.bo'),
          mobile: '+61400000302',
        }).expect(201)
      ).body;
      // Both channels: the email goes out on create (as before), never an SMS too.
      expect(both.invitation.channel).toBe('EMAIL');
      expect(texts.filter((t) => t.to === '+61400000302')).toHaveLength(0);
      const emailToken = tokenFor(at('inv.bo'));

      // Customer resends by SMS instead: supersedes the email link.
      const sms = await sendBy(owen, both.id, 'SMS').expect(200);
      expect(sms.body.invitation.channel).toBe('SMS');
      expect((await invitation('accept', emailToken).expect(200)).body.status).toBe('CANCELLED');
      const smsToken = smsTokenFor('+61400000302');

      const changed = await owen
        .patch(api(`/trusted-contacts/${both.id}`))
        .send({ mobile: '+61400000303' })
        .expect(200);
      expect(changed.body.invitation).toEqual({ status: 'NOT_SENT', sentAt: null, channel: null });
      expect((await invitation('view', smsToken).expect(200)).body.status).toBe('CANCELLED');
      expect((await invitation('accept', smsToken).expect(200)).body.status).toBe('CANCELLED');

      // Changing the email does not disturb a live SMS link.
      await sendBy(owen, both.id, 'SMS').expect(200);
      const fresh = smsTokenFor('+61400000303');
      await owen.patch(api(`/trusted-contacts/${both.id}`)).send({ email: at('inv.bo2') }).expect(200);
      expect((await invitation('accept', fresh).expect(200)).body.status).toBe('ACCEPTED');
      expect((await contact(owen, both.id)).readiness.status).toBe('READY');
      await owen.delete(api(`/trusted-contacts/${both.id}`)).expect(204);
    });

    it('SMS resend supersedes the previous SMS token', async () => {
      const id = (await add(owen, { firstName: 'Re', mobile: '+61400000304' }).expect(201)).body.id;
      await sendBy(owen, id, 'SMS').expect(200);
      const first = smsTokenFor('+61400000304');
      await sendBy(owen, id, 'SMS').expect(200);
      const second = smsTokenFor('+61400000304');
      expect(second).not.toBe(first);
      expect((await invitation('accept', first).expect(200)).body.status).toBe('CANCELLED');
      expect(
        await prisma.trustedContactInvitation.count({ where: { trustedContactId: id, status: 'PENDING' } }),
      ).toBe(1);
      expect((await invitation('view', second).expect(200)).body.status).toBe('PENDING');
      await owen.delete(api(`/trusted-contacts/${id}`)).expect(204);
    });

    it('SMS without a mobile → 409; bad channel → 400; no address can be supplied', async () => {
      const id = (await add(owen, { firstName: 'Em', email: at('inv.em') }).expect(201)).body.id;
      const before = texts.length;
      const res = await sendBy(owen, id, 'SMS').expect(409);
      expect(res.body.message).toMatch(/no mobile number/);
      await sendBy(owen, id, 'WHATSAPP').expect(400);
      // No relay: a destination or body in the request is rejected outright.
      await owen
        .post(api(`/trusted-contacts/${id}/invitation`))
        .send({ channel: 'SMS', to: '+61400000999', body: 'hi' })
        .expect(400);
      expect(texts.length).toBe(before);
      await owen.delete(api(`/trusted-contacts/${id}`)).expect(204);
    });

    it('owner isolation and removed contacts: 404, nothing sent', async () => {
      const pat = await signIn(PAT);
      const before = texts.length;
      await sendBy(pat, moId, 'SMS').expect(404);
      await http().post(api(`/trusted-contacts/${moId}/invitation`)).send({ channel: 'SMS' }).expect(401);
      const gone = (await add(owen, { firstName: 'Go', mobile: '+61400000305' }).expect(201)).body.id;
      await owen.delete(api(`/trusted-contacts/${gone}`)).expect(204);
      await sendBy(owen, gone, 'SMS').expect(404);
      expect(texts.length).toBe(before);
    });

    it('provider failure: 503 with a safe message, link cancelled, never Pending', async () => {
      const id = (await add(owen, { firstName: 'Fa', mobile: '+61400000306' }).expect(201)).body.id;
      smsFailNext = true;
      const res = await sendBy(owen, id, 'SMS').expect(503);
      expect(res.body.message).toBe("We couldn't send the invitation just now. Please try again.");
      expect(JSON.stringify(res.body)).not.toMatch(/twilio|30003/i);
      expect((await contact(owen, id)).invitation.status).toBe('NOT_SENT');
      const row = await prisma.trustedContactInvitation.findFirstOrThrow({ where: { trustedContactId: id } });
      expect(row.status).toBe('CANCELLED');
      await owen.delete(api(`/trusted-contacts/${id}`)).expect(204);
    });

    it('rate limits: 3 per contact per hour; 6 SMS per Customer per day, removed contacts included', async () => {
      // Owen has sent 6 SMS invitations so far today (incl. the failed one, and
      // to contacts since removed): the daily Customer cap is reached.
      const smsToday = await prisma.trustedContactInvitation.count({
        where: { mobile: { not: null }, trustedContact: { owner: { email: OWEN } } },
      });
      expect(smsToday).toBe(6);
      const id = (await add(owen, { firstName: 'Cap', mobile: '+61400000307' }).expect(201)).body.id;
      const before = texts.length;
      const capped = await sendBy(owen, id, 'SMS').expect(429);
      expect(capped.body.message).toMatch(/Too many invitations/);
      expect(texts.length).toBe(before);
      await owen.delete(api(`/trusted-contacts/${id}`)).expect(204);

      // Per contact (existing rule, now across both channels): Pat's contact.
      const pat = await signIn(PAT);
      const pc = (await add(pat, { firstName: 'Pc', email: at('inv.pc'), mobile: '+61400000308' }).expect(201)).body.id;
      await sendBy(pat, pc, 'SMS').expect(200);
      await sendBy(pat, pc, 'EMAIL').expect(200);
      await sendBy(pat, pc, 'SMS').expect(429);
    });
  });

  // Trusted Contact readiness (setup health, 2026-10-14): derived from the
  // newest invitation on every read; never death-verification state.
  describe('readiness', () => {
    let rita: Agent;
    const list = async () => (await rita.get(api('/trusted-contacts')).expect(200)).body as {
      id: string;
      readiness: { status: string; reason: string | null; invitationSentAt: string | null; invitationAcceptedAt: string | null };
    }[];
    const readinessOf = async (id: string) => (await contact(rita, id)).readiness;
    let firstId: string;
    let secondId: string;

    beforeAll(async () => {
      rita = await signIn(RITA);
    });

    it('zero contacts: an empty list', async () => {
      expect(await list()).toEqual([]);
    });

    it('invitation sent → INVITATION_PENDING with the sent date; accepted → READY with the accepted date', async () => {
      const email = at('inv.rita.tc1');
      const created = await add(rita, { firstName: 'Tess', email }).expect(201);
      firstId = created.body.id;
      expect(created.body.readiness).toEqual({
        status: 'INVITATION_PENDING',
        reason: null,
        invitationSentAt: expect.any(String),
        invitationAcceptedAt: null,
      });
      await invitation('accept', tokenFor(email)).expect(200);
      const ready = await readinessOf(firstId);
      expect(ready).toMatchObject({ status: 'READY', reason: null, invitationAcceptedAt: expect.any(String) });
    });

    it('a second contact shows its own state; the list carries both in one response', async () => {
      secondId = (await add(rita, { firstName: 'Uma', email: at('inv.rita.tc2') }).expect(201)).body.id;
      const rows = await list();
      // Newest first (the list's existing order).
      expect(rows.map((r) => [r.id, r.readiness.status])).toEqual([
        [secondId, 'INVITATION_PENDING'],
        [firstId, 'READY'],
      ]);
      // Still at most two: readiness adds no slot.
      await add(rita, { firstName: 'Vic', email: at('inv.rita.tc3') }).expect(409);
    });

    it('expired → INVITATION_EXPIRED; a resend makes it pending again (new link only)', async () => {
      await prisma.trustedContactInvitation.updateMany({
        where: { trustedContactId: secondId, status: 'PENDING' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await readinessOf(secondId)).status).toBe('INVITATION_EXPIRED');
      const old = tokenFor(at('inv.rita.tc2'));
      await rita.post(api(`/trusted-contacts/${secondId}/invitation`)).expect(200);
      expect((await readinessOf(secondId)).status).toBe('INVITATION_PENDING');
      expect((await invitation('accept', old).expect(200)).body.status).not.toBe('ACCEPTED');
    });

    it('a READY contact cannot be re-invited (409)', async () => {
      await rita.post(api(`/trusted-contacts/${firstId}/invitation`)).expect(409);
      expect((await readinessOf(firstId)).status).toBe('READY');
    });

    it('declined → ACTION_NEEDED (DECLINED)', async () => {
      await invitation('decline', tokenFor(at('inv.rita.tc2'))).expect(200);
      expect(await readinessOf(secondId)).toMatchObject({ status: 'ACTION_NEEDED', reason: 'DECLINED' });
    });

    it('changing a READY contact’s email resets readiness (never stale)', async () => {
      const res = await rita.patch(api(`/trusted-contacts/${firstId}`)).send({ email: at('inv.rita.tc1b') }).expect(200);
      expect(res.body.readiness).toMatchObject({ status: 'ACTION_NEEDED', reason: 'NOT_SENT', invitationAcceptedAt: null });
      // Back to the old address: the earlier acceptance was for that address, so it counts again.
      const back = await rita.patch(api(`/trusted-contacts/${firstId}`)).send({ email: at('inv.rita.tc1') }).expect(200);
      expect(back.body.readiness.status).toBe('READY');
    });

    it('mobile-only, not yet invited → ACTION_NEEDED (NOT_SENT); a removed contact leaves the list', async () => {
      await rita.delete(api(`/trusted-contacts/${secondId}`)).expect(204);
      const mobileOnly = (await add(rita, { firstName: 'Wes', mobile: '+61400000088' }).expect(201)).body;
      expect(mobileOnly.readiness).toMatchObject({ status: 'ACTION_NEEDED', reason: 'NOT_SENT' });
      expect((await list()).map((r) => r.id)).toEqual([mobileOnly.id, firstId]);
    });

    it("another Customer can't read Rita's contacts or their readiness", async () => {
      await john.get(api(`/trusted-contacts/${firstId}`)).expect(404);
      const johns = (await john.get(api('/trusted-contacts')).expect(200)).body as { id: string }[];
      expect(johns.map((c) => c.id)).not.toContain(firstId);
    });

    it('never returns tokens, OTP, sessions, death reports, evidence or admin data', async () => {
      // Rita's ready contact files a death report through the portal (code from the fake inbox).
      const tcEmail = at('inv.rita.tc1');
      const { challengeId } = (
        await http().post(api('/trusted-contact-auth/request-otp')).send({ email: tcEmail }).expect(202)
      ).body;
      const tc = request.agent(app.getHttpServer());
      await tc.post(api('/trusted-contact-auth/verify-otp')).send({ challengeId, code: inbox.code(tcEmail) }).expect(200);
      await tc
        .post(api(`/trusted-contact/accounts/${firstId}/death-reports`))
        .send({ reportedDateOfDeath: '2026-09-28', note: 'Fictional test report.', confirmReport: true })
        .expect(201);
      // Exactly these fields: nothing about the report, its case, evidence, OTP, tokens or sessions.
      for (const row of await list()) {
        expect(Object.keys(row).sort()).toEqual(
          ['createdAt', 'email', 'firstName', 'id', 'invitation', 'lastName', 'mobile', 'readiness', 'relationship', 'updatedAt'],
        );
        expect(Object.keys(row.readiness).sort()).toEqual(['invitationAcceptedAt', 'invitationSentAt', 'reason', 'status']);
      }
      // Reporting doesn't change setup readiness.
      expect((await readinessOf(firstId)).status).toBe('READY');
    });
  });
});

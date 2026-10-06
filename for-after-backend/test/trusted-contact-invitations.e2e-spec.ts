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
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const LISA = at('inv.lisa');
  const JOHN = at('inv.john');
  const NORA = at('inv.nora');
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
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    for (const email of [LISA, JOHN, NORA]) {
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
      where: { email: { in: [LISA, JOHN, NORA] } },
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
      });

      const mails = inbox.to(DAVID, 'trusted-contact-invitation');
      expect(mails).toHaveLength(1);
      expect(mails[0].subject).toBe(
        "You've been invited to be a Trusted Contact for lisa Test",
      );
      for (const part of [mails[0].text, mails[0].html]) {
        expect(part).not.toContain('Secret');
        expect(part).not.toContain(LISA);
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
      expect(res.body.invitation).toEqual({ status: 'NOT_SENT', sentAt: null });
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

    it('mobile-only: invitation UNAVAILABLE, nothing sent, no SMS fallback', async () => {
      const before = inbox.sent.length;
      const res = await add(lisa, {
        firstName: 'Mo',
        mobile: '+61400000077',
      }).expect(201);
      expect(res.body.invitation).toEqual({
        status: 'UNAVAILABLE',
        sentAt: null,
      });
      await lisa
        .post(api(`/trusted-contacts/${res.body.id}/invitation`))
        .expect(409);
      expect(inbox.sent.length).toBe(before);
      expect(
        await prisma.trustedContactInvitation.count({
          where: { trustedContactId: res.body.id },
        }),
      ).toBe(0);
    });
  });
});

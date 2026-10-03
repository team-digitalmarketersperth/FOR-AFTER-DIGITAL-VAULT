import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import type { OtpDeliveryInput } from '../src/otp-auth/otp-auth.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientAuthModule } from '../src/recipient-auth/recipient-auth.module.js';
import { RecipientOtpDelivery } from '../src/recipient-auth/recipient-otp-delivery.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { TrustedContactAuthModule } from '../src/trusted-contact-auth/trusted-contact-auth.module.js';
import { TrustedContactOtpDelivery } from '../src/trusted-contact-auth/trusted-contact-auth.service.js';
import { TrustedContactsModule } from '../src/trusted-contacts/trusted-contacts.module.js';

// Step 22 end to end: profile update (PATCH /users/me) and password change
// (POST /auth/change-password) over real HTTP, guards, sessions and
// PostgreSQL. OTPs go through a fake. Fictional data only; test users are
// deleted afterwards (audit rows are append-only and stay).
describe('Customer account settings (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const at = (name: string) => `${name}.${run}@example.test`;
  const LISA = at('acct.lisa');
  const OMAR = at('acct.omar');
  const ADMIN = at('acct.admin');
  const SOFIA = at('acct.sofia');
  const DAVID = at('acct.david');
  const password = 'StrongPassword123!';
  const newPassword = 'A brand new long passphrase';

  const otps: OtpDeliveryInput[] = [];
  const otpDelivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      otps.push(input);
    }),
  };

  type Agent = ReturnType<typeof request.agent>;
  const api = (path: string) => `/api/v1${path}`;
  const http = () => request(app.getHttpServer());
  const login = (email: string, pw = password) =>
    http().post(api('/auth/login')).send({ email, password: pw });
  const signIn = async (email: string, pw = password) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api('/auth/login'))
      .send({ email, password: pw })
      .expect(200);
    return agent;
  };
  const otpSignIn = async (
    base: 'trusted-contact-auth' | 'recipient-auth',
    email: string,
  ) => {
    const { challengeId } = (
      await http()
        .post(api(`/${base}/request-otp`))
        .send({ email })
        .expect(202)
    ).body;
    const agent = request.agent(app.getHttpServer());
    await agent
      .post(api(`/${base}/verify-otp`))
      .send({
        challengeId,
        code: otps.findLast((o) => o.email === email)!.code,
      })
      .expect(200);
    return agent;
  };
  const userRow = (email: string) =>
    prisma.user.findUniqueOrThrow({ where: { email } });

  let lisa: Agent;
  let omar: Agent;
  let admin: Agent;
  let recipient: Agent;
  let trustedContact: Agent;

  beforeAll(async () => {
    Object.assign(process.env, {
      TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT: '10000',
      TRUSTED_CONTACT_OTP_VERIFY_IP_LIMIT: '10000',
      RECIPIENT_OTP_IP_REQUEST_LIMIT: '10000',
      RECIPIENT_OTP_VERIFY_IP_LIMIT: '10000',
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        RedisModule,
        AuthModule,
        RecipientsModule,
        TrustedContactsModule,
        MessagesModule,
        RecipientAuthModule,
        TrustedContactAuthModule,
      ],
    })
      // Many sign-ins exceed the 5/min login limit; the change-password limit
      // is covered in auth.controller.spec.ts.
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(TrustedContactOtpDelivery)
      .useValue(otpDelivery)
      .overrideProvider(RecipientOtpDelivery)
      .useValue(otpDelivery)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);

    for (const [email, firstName] of [
      [LISA, 'Lisa'],
      [OMAR, 'Omar'],
      [ADMIN, 'Ada'],
    ]) {
      await http()
        .post(api('/auth/register'))
        .send({ email, password, firstName, lastName: 'Test' })
        .expect(201);
    }
    lisa = await signIn(LISA);
    omar = await signIn(OMAR);
    await prisma.user.update({
      where: { email: ADMIN },
      data: { role: 'ADMIN' },
    });
    admin = (await adminSignIn(app, ADMIN, password)).agent;

    // Lisa's Trusted Contact David, and Recipient Sofia with one released
    // message (seeded as the release worker would leave it).
    await lisa
      .post(api('/trusted-contacts'))
      .send({ firstName: 'David', email: DAVID })
      .expect(201);
    const recipientId = (
      await lisa
        .post(api('/recipients'))
        .send({ firstName: 'Sofia', email: SOFIA })
        .expect(201)
    ).body.id as string;
    const messageId = (
      await lisa
        .post(api('/messages'))
        .send({
          title: 'Fictional',
          textContent: 'Fictional text.',
          recipientIds: [recipientId],
        })
        .expect(201)
    ).body.id as string;
    await prisma.message.update({
      where: { id: messageId },
      data: {
        status: 'RELEASED',
        release: {
          create: {
            triggerType: 'FIXED_DATE',
            releasedAt: new Date(),
            accessGrants: {
              create: {
                recipientId,
                messageId,
                recipientEmailNormalized: SOFIA,
              },
            },
          },
        },
      },
    });
    recipient = await otpSignIn('recipient-auth', SOFIA);
    trustedContact = await otpSignIn('trusted-contact-auth', DAVID);
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({
      where: { email: { in: [LISA, OMAR, ADMIN] } },
    });
    await app?.close();
  });

  describe('authorization', () => {
    it('no session → 401 on every account route', async () => {
      await http().get(api('/auth/me')).expect(401);
      await http().patch(api('/users/me')).send({ firstName: 'X' }).expect(401);
      await http()
        .post(api('/auth/change-password'))
        .send({ currentPassword: password, newPassword })
        .expect(401);
    });

    it('Recipient and Trusted Contact sessions → 401 (they are not Users)', async () => {
      for (const agent of [recipient, trustedContact]) {
        await agent.get(api('/auth/me')).expect(401);
        await agent
          .patch(api('/users/me'))
          .send({ firstName: 'X' })
          .expect(401);
        await agent
          .post(api('/auth/change-password'))
          .send({ currentPassword: password, newPassword })
          .expect(401);
      }
    });

    it('an admin session → 403 (Customer-only routes)', async () => {
      await admin.patch(api('/users/me')).send({ firstName: 'X' }).expect(403);
      await admin
        .post(api('/auth/change-password'))
        .send({ currentPassword: password, newPassword })
        .expect(403);
      expect((await userRow(ADMIN)).firstName).toBe('Ada');
    });

    it('a suspended Customer is locked out of both routes (401)', async () => {
      await prisma.user.update({
        where: { email: OMAR },
        data: { status: 'SUSPENDED' },
      });
      await omar.patch(api('/users/me')).send({ firstName: 'X' }).expect(401);
      await omar
        .post(api('/auth/change-password'))
        .send({ currentPassword: password, newPassword })
        .expect(401);
      expect((await userRow(OMAR)).firstName).toBe('Omar');
    });
  });

  describe('PATCH /users/me', () => {
    it('updates the name (trimmed, Unicode) and returns only safe fields', async () => {
      const res = await lisa
        .patch(api('/users/me'))
        .send({ firstName: '  Zoë ', lastName: 'Ó Briain-Łukasz' })
        .expect(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'createdAt',
          'email',
          'emailVerifiedAt',
          'firstName',
          'id',
          'lastName',
          'role',
          'status',
          'twoFactorEnabled',
        ].sort(),
      );
      expect(res.body).toMatchObject({
        firstName: 'Zoë',
        lastName: 'Ó Briain-Łukasz',
        email: LISA,
      });
      expect(await userRow(LISA)).toMatchObject({
        firstName: 'Zoë',
        lastName: 'Ó Briain-Łukasz',
      });
      expect((await lisa.get(api('/auth/me')).expect(200)).body.firstName).toBe(
        'Zoë',
      );
    });

    it('a single field leaves the other unchanged', async () => {
      await lisa
        .patch(api('/users/me'))
        .send({ lastName: 'Smith' })
        .expect(200);
      expect(await userRow(LISA)).toMatchObject({
        firstName: 'Zoë',
        lastName: 'Smith',
      });
    });

    it.each([
      ['empty first name', { firstName: '' }],
      ['whitespace only', { lastName: '   ' }],
      ['null (cannot clear)', { firstName: null }],
      ['not a string', { firstName: 42 }],
      ['over 100 characters', { lastName: 'a'.repeat(101) }],
      ['email (read-only)', { email: at('acct.new') }],
      ['role', { role: 'ADMIN' }],
      ['status', { status: 'PASSED' }],
      ['id (cannot target another user)', { id: crypto.randomUUID() }],
      ['passwordHash', { passwordHash: 'x' }],
    ])('rejects %s with 400 and changes nothing', async (_, body) => {
      const before = await userRow(LISA);
      await lisa.patch(api('/users/me')).send(body).expect(400);
      const after = await userRow(LISA);
      expect(after).toEqual(before);
    });

    it('there is no route to another user’s profile', async () => {
      const omarId = (await userRow(OMAR)).id;
      await lisa
        .patch(api(`/users/${omarId}`))
        .send({ firstName: 'X' })
        .expect(404);
      expect((await userRow(OMAR)).firstName).toBe('Omar');
    });
  });

  describe('POST /auth/change-password', () => {
    it('validates with the registration policy (12–128) and needs both fields', async () => {
      const hash = (await userRow(LISA)).passwordHash;
      for (const body of [
        { currentPassword: password, newPassword: 'short-11ch!' },
        { currentPassword: password, newPassword: 'a'.repeat(129) },
        { newPassword },
        { currentPassword: password },
        { currentPassword: password, newPassword, email: at('x') },
      ]) {
        await lisa.post(api('/auth/change-password')).send(body).expect(400);
      }
      expect((await userRow(LISA)).passwordHash).toBe(hash);
    });

    it('a wrong current password → 400, password and session unchanged', async () => {
      const hash = (await userRow(LISA)).passwordHash;
      const res = await lisa
        .post(api('/auth/change-password'))
        .send({ currentPassword: 'not-my-password!', newPassword })
        .expect(400);
      expect(res.body.message).toBe('Your current password is incorrect.');
      expect((await userRow(LISA)).passwordHash).toBe(hash);
      await lisa.get(api('/auth/me')).expect(200);
    });

    it('the same password again → 400', async () => {
      await lisa
        .post(api('/auth/change-password'))
        .send({ currentPassword: password, newPassword: password })
        .expect(400);
    });

    it('success: this session stays, other Customer sessions end, portals unaffected', async () => {
      const otherDevice = await signIn(LISA);
      const res = await lisa
        .post(api('/auth/change-password'))
        .send({ currentPassword: password, newPassword })
        .expect(200);
      expect(res.body).toEqual({ success: true });
      expect(JSON.stringify(res.body)).not.toContain(newPassword);
      // A new session id is issued to this browser.
      expect(String(res.headers['set-cookie'])).toContain('for_after_session=');

      await lisa.get(api('/auth/me')).expect(200);
      await otherDevice.get(api('/auth/me')).expect(401);
      // Destroyed, not just refused once.
      await otherDevice.get(api('/auth/me')).expect(401);

      await recipient.get(api('/recipient-auth/me')).expect(200);
      await trustedContact.get(api('/trusted-contact-auth/me')).expect(200);
    });

    it('the old password no longer signs in; the new one does', async () => {
      await login(LISA).expect(401);
      const fresh = await signIn(LISA, newPassword);
      await fresh.get(api('/auth/me')).expect(200);
    });

    it('stores an Argon2id hash and audits PASSWORD_CHANGED without secrets', async () => {
      const row = await userRow(LISA);
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.passwordChangedAt).toBeInstanceOf(Date);
      const [event] = await prisma.auditLog.findMany({
        where: { eventType: 'PASSWORD_CHANGED', actorUserId: row.id },
      });
      expect(event).toMatchObject({
        actorType: 'CUSTOMER',
        subjectType: 'User',
        subjectId: row.id,
        metadata: null,
      });
      const stored = JSON.stringify(event);
      expect(stored).not.toContain(newPassword);
      expect(stored).not.toContain(password);
      expect(stored).not.toContain(row.passwordHash);
    });
  });
});

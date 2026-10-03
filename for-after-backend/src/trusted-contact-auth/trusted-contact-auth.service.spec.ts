import { HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailProvider } from '../email/email-provider.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { readFileSync } from 'node:fs';
import { fakeRedis } from '../../test/fake-redis.js';
import { SESSION_COOKIE } from '../config/app.setup.js';
import {
  INVALID_CODE,
  type OtpDeliveryInput,
} from '../otp-auth/otp-auth.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RequestRecipientOtpDto } from '../recipient-auth/dto/recipient-otp.dto.js';
import {
  RECIPIENT_SESSION_COOKIE,
  RecipientAuthService,
} from '../recipient-auth/recipient-auth.service.js';
import type { RedisService } from '../redis/redis.service.js';
import {
  activeRelationship,
  TRUSTED_CONTACT_OTP_REQUESTED,
  TRUSTED_CONTACT_SESSION_COOKIE,
  TrustedContactAuthService,
  trustedContactOtpDeliveryFactory,
} from './trusted-contact-auth.service.js';
import {
  readTrustedContactSessionId,
  TrustedContactSessionAuthGuard,
} from './trusted-contact-session.guard.js';

const PEPPER = 'tc-test-pepper-not-a-secret-00000000000';
const DAVID = 'david@example.com';

const setup = (
  env: Record<string, string | undefined> = {},
  { contacts = 1, redis = fakeRedis() } = {},
) => {
  const sent: OtpDeliveryInput[] = [];
  const delivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      sent.push(input);
    }),
  };
  const count = vi.fn().mockResolvedValue(contacts);
  const service = new TrustedContactAuthService(
    { trustedContact: { count } } as unknown as PrismaService,
    { client: redis.client } as unknown as RedisService,
    delivery,
    new ConfigService({
      TRUSTED_CONTACT_OTP_PEPPER: PEPPER,
      NODE_ENV: 'test',
      ...env,
    }),
  );
  const request = async (email = DAVID, ip = '1.1.1.1') => {
    const res = await service.requestOtp(email, ip);
    await new Promise((r) => setImmediate(r));
    return { ...res, code: sent.at(-1)?.code };
  };
  return { service, redis, sent, count, request };
};
const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

describe('TrustedContactAuthService: request OTP', () => {
  it('known, unknown and deleted-contact emails get the same generic 202 body', async () => {
    const known = await setup().request();
    const unknown = await setup({}, { contacts: 0 }).request(
      'unknown@example.com',
    );
    expect(known.message).toBe(TRUSTED_CONTACT_OTP_REQUESTED);
    expect(unknown.message).toBe(known.message);
    expect(Object.keys(unknown)).toEqual(Object.keys(known));
    expect(known.code).toMatch(/^\d{6}$/);
    // Ineligible (unknown or only deleted rows): nothing is sent.
    expect(unknown.code).toBeUndefined();
  });

  it('eligibility = active TrustedContact row of an active Customer (deleted rows excluded)', async () => {
    const { count, request } = setup();
    await request();
    expect(count).toHaveBeenCalledWith({
      where: {
        email: DAVID,
        deletedAt: null,
        owner: { deletedAt: null },
      },
      take: 1,
    });
    expect(activeRelationship(DAVID)).toMatchObject({ deletedAt: null });
  });

  it('normalizes email (trim + lowercase) with the shared DTO', async () => {
    const dto = plainToInstance(RequestRecipientOtpDto, {
      email: '  David@Example.COM ',
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.email).toBe(DAVID);
    expect(
      await validate(plainToInstance(RequestRecipientOtpDto, { email: 'x' })),
    ).not.toHaveLength(0);
  });

  it('codes and ids come from node:crypto, never Math.random', () => {
    const source = readFileSync(
      new URL('../otp-auth/otp-auth.service.ts', import.meta.url),
      'utf8',
    );
    expect(source).toMatch(/randomInt\(0, 1_000_000\)/);
    expect(source).toMatch(/randomBytes\(32\)/);
    expect(source).not.toMatch(/Math\.random/);
  });

  it('stores only an HMAC(pepper, challengeId:code) in its own Redis namespace with a TTL', async () => {
    const { redis, request } = setup();
    const { challengeId, code } = await request();
    const key = `for_after:trusted_contact_otp:${challengeId}`;
    const stored = redis.store.get(key) as Record<string, string>;
    expect(stored.email).toBe(DAVID);
    expect(stored.otpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([...redis.store])).not.toContain(`"${code}"`);
    expect(redis.ttl.get(key)).toBe(600_000);
  });

  it('challenge ids are opaque, random and unique', async () => {
    const { request } = setup();
    const a = await request();
    const b = await request();
    expect(a.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challengeId).not.toBe(b.challengeId);
  });

  it('rate-limits per email (429)', async () => {
    const { request } = setup({ TRUSTED_CONTACT_OTP_REQUEST_LIMIT: '2' });
    await request(DAVID, '1.1.1.1');
    await request(DAVID, '2.2.2.2');
    const err = await request(DAVID, '3.3.3.3').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
  });

  it('rate-limits per IP across emails', async () => {
    const { request } = setup({ TRUSTED_CONTACT_OTP_IP_REQUEST_LIMIT: '1' });
    await request('a@example.com');
    await expect(request('b@example.com')).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});

describe('TrustedContactAuthService: verify OTP', () => {
  it('a correct code creates a session and consumes the challenge (no reuse)', async () => {
    const { service, request } = setup();
    const { challengeId, code } = await request();
    const { sessionId, principal } = await service.verifyOtp(
      challengeId,
      code!,
    );
    expect(principal).toEqual({ emailNormalized: DAVID });
    expect(await service.getSession(sessionId)).toEqual(principal);
    await expect(service.verifyOtp(challengeId, code!)).rejects.toThrow(
      INVALID_CODE,
    );
  });

  it('wrong code → 401 generic message', async () => {
    const { service, request } = setup();
    const { challengeId, code } = await request();
    await expect(
      service.verifyOtp(challengeId, wrongCode(code!)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('expired challenge → 401', async () => {
    const { service, redis, request } = setup();
    const { challengeId, code } = await request();
    redis.advance(600_001);
    await expect(service.verifyOtp(challengeId, code!)).rejects.toThrow(
      INVALID_CODE,
    );
  });

  it('after max attempts even the right code fails', async () => {
    const { service, request } = setup({
      TRUSTED_CONTACT_OTP_MAX_ATTEMPTS: '2',
    });
    const { challengeId, code } = await request();
    for (let i = 0; i < 2; i++) {
      await service.verifyOtp(challengeId, wrongCode(code!)).catch(() => null);
    }
    await expect(service.verifyOtp(challengeId, code!)).rejects.toThrow(
      INVALID_CODE,
    );
  });

  it('eligibility is re-checked at verify (contact removed meanwhile → 401)', async () => {
    const { service, count, request } = setup();
    const { challengeId, code } = await request();
    count.mockResolvedValue(0);
    await expect(service.verifyOtp(challengeId, code!)).rejects.toThrow(
      INVALID_CODE,
    );
  });

  it('Recipient and Trusted Contact challenges are not interchangeable (shared Redis)', async () => {
    const redis = fakeRedis();
    const tc = setup({}, { redis });
    const recipientSent: OtpDeliveryInput[] = [];
    const recipient = new RecipientAuthService(
      {
        recipientMessageAccessGrant: { count: vi.fn().mockResolvedValue(1) },
      } as unknown as PrismaService,
      { client: redis.client } as unknown as RedisService,
      { sendOtp: async (i: OtpDeliveryInput) => void recipientSent.push(i) },
      new ConfigService({ RECIPIENT_OTP_PEPPER: PEPPER, NODE_ENV: 'test' }),
    );
    const r = await recipient.requestOtp(DAVID);
    await new Promise((res) => setImmediate(res));
    await expect(
      tc.service.verifyOtp(r.challengeId, recipientSent[0].code),
    ).rejects.toThrow(INVALID_CODE);

    const t = await tc.request();
    await expect(recipient.verifyOtp(t.challengeId, t.code!)).rejects.toThrow(
      INVALID_CODE,
    );
  });
});

describe('TrustedContactAuthService: sessions, cookie and config', () => {
  it('sessions: Redis, hashed key in own namespace, configured TTL, destroyable', async () => {
    const { service, redis } = setup({
      TRUSTED_CONTACT_SESSION_TTL_SECONDS: '100',
    });
    const id = await service.createSession({ emailNormalized: DAVID });
    const [key] = [...redis.store.keys()];
    expect(key).toMatch(/^for_after:trusted_contact_sess:[0-9a-f]{64}$/);
    expect(key).not.toContain(id);
    expect(JSON.parse(redis.store.get(key) as string)).toMatchObject({
      emailNormalized: DAVID,
      authenticatedAt: expect.any(String),
    });
    expect(redis.ttl.get(key)).toBe(100_000);
    redis.advance(100_001);
    expect(await service.getSession(id)).toBeNull();

    const other = await service.createSession({ emailNormalized: DAVID });
    await service.destroySession(other);
    expect(await service.getSession(other)).toBeNull();
  });

  it('cookie: own name, HttpOnly, Lax; Secure + domain in production', () => {
    expect(
      new Set([
        SESSION_COOKIE,
        RECIPIENT_SESSION_COOKIE,
        TRUSTED_CONTACT_SESSION_COOKIE,
      ]).size,
    ).toBe(3);
    expect(TRUSTED_CONTACT_SESSION_COOKIE).toBe(
      'for_after_trusted_contact_session',
    );
    expect(setup().service.cookieOptions()).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      domain: undefined,
      maxAge: 604800_000,
    });
    expect(
      setup({
        NODE_ENV: 'production',
        TRUSTED_CONTACT_COOKIE_DOMAIN: '.x.test',
      }).service.cookieOptions(),
    ).toMatchObject({ secure: true, domain: '.x.test' });
  });

  it('refuses to start without a long enough TRUSTED_CONTACT_OTP_PEPPER', () => {
    for (const pepper of [undefined, 'short']) {
      expect(() => setup({ TRUSTED_CONTACT_OTP_PEPPER: pepper })).toThrow(
        /TRUSTED_CONTACT_OTP_PEPPER/,
      );
    }
  });

  it('delivery: one trusted contact sign-in email per code (Step 24)', async () => {
    const sent: { kind: string; to: string; text: string }[] = [];
    const email = {
      name: 'fake',
      send: (m: { kind: string; to: string; text: string }) => (
        sent.push(m),
        Promise.resolve({ providerMessageId: null })
      ),
    } as unknown as EmailProvider;
    await trustedContactOtpDeliveryFactory(email).sendOtp({
      email: DAVID,
      code: '654321',
      expiresInSeconds: 600,
    });
    expect(sent).toEqual([
      expect.objectContaining({ kind: 'trusted-contact-otp', to: DAVID }),
    ]);
    expect(sent[0].text).toContain('Your sign-in code is 654321');
    expect(sent[0].text).toContain('trusted contact sign-in page');
  });

  it('normal logs never contain the code, challenge id, session id, pepper or full email', async () => {
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    const { service, request } = setup();
    const { challengeId, code } = await request();
    await service.verifyOtp(challengeId, wrongCode(code!)).catch(() => null);
    const { sessionId } = await service.verifyOtp(challengeId, code!);
    await service.destroySession(sessionId);
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    for (const category of [
      'trusted_contact_otp_requested',
      'trusted_contact_otp_invalid',
      'trusted_contact_otp_verified',
      'trusted_contact_session_created',
      'trusted_contact_session_logout',
    ]) {
      expect(logged).toContain(category);
    }
    for (const secret of [code!, challengeId, sessionId, PEPPER, DAVID]) {
      expect(logged).not.toContain(secret);
    }
    spies.forEach((s) => s.mockRestore());
  });
});

describe('TrustedContactSessionAuthGuard', () => {
  const ctx = (req: Partial<Request>) =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as never;

  it('reads only the Trusted Contact cookie', () => {
    const req = {
      headers: {
        cookie: `${SESSION_COOKIE}=s%3Ac; ${RECIPIENT_SESSION_COOKIE}=r; ${TRUSTED_CONTACT_SESSION_COOKIE}=t`,
      },
    } as Request;
    expect(readTrustedContactSessionId(req)).toBe('t');
  });

  it('valid session → req.trustedContact only (never req.user / req.recipient)', async () => {
    const { service } = setup();
    const id = await service.createSession({ emailNormalized: DAVID });
    const req = {
      headers: { cookie: `${TRUSTED_CONTACT_SESSION_COOKIE}=${id}` },
    } as Request;
    expect(
      await new TrustedContactSessionAuthGuard(service).canActivate(ctx(req)),
    ).toBe(true);
    expect(req.trustedContact).toEqual({ emailNormalized: DAVID });
    expect(req.user).toBeUndefined();
    expect(req.recipient).toBeUndefined();
  });

  it('missing, unknown, Customer-only or Recipient-only (even a valid Recipient session) → 401', async () => {
    const redis = fakeRedis();
    const { service } = setup({}, { redis });
    const recipient = new RecipientAuthService(
      {} as PrismaService,
      { client: redis.client } as unknown as RedisService,
      { sendOtp: async () => undefined },
      new ConfigService({ RECIPIENT_OTP_PEPPER: PEPPER, NODE_ENV: 'test' }),
    );
    const recipientSession = await recipient.createSession({
      emailNormalized: DAVID,
    });
    const guard = new TrustedContactSessionAuthGuard(service);
    for (const cookie of [
      undefined,
      `${TRUSTED_CONTACT_SESSION_COOKIE}=nope`,
      `${SESSION_COOKIE}=s%3Acustomer`,
      `${RECIPIENT_SESSION_COOKIE}=${recipientSession}`,
      // A Recipient session id presented in the Trusted Contact cookie.
      `${TRUSTED_CONTACT_SESSION_COOKIE}=${recipientSession}`,
    ]) {
      await expect(
        guard.canActivate(ctx({ headers: { cookie } } as Request)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });
});

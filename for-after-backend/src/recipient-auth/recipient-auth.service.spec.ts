import { HttpException, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request } from 'express';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RedisService } from '../redis/redis.service.js';
import {
  INVALID_CODE,
  OTP_REQUESTED,
  RECIPIENT_SESSION_COOKIE,
  RecipientAuthService,
} from './recipient-auth.service.js';
import {
  ConsoleOtpDelivery,
  DisabledOtpDelivery,
  otpDeliveryFactory,
  type OtpDeliveryInput,
} from './recipient-otp-delivery.js';
import {
  readRecipientSessionId,
  RecipientSessionAuthGuard,
} from './recipient-session.guard.js';
import { SESSION_COOKIE } from '../config/app.setup.js';
import { fakeRedis } from '../../test/fake-redis.js';

const PEPPER = 'test-pepper-not-a-secret-000000000000';
const SOFIA = 'sofia@example.com';

const configOf = (env: Record<string, string | undefined>) =>
  new ConfigService({
    RECIPIENT_OTP_PEPPER: PEPPER,
    NODE_ENV: 'test',
    ...env,
  });

const setup = (
  env: Record<string, string | undefined> = {},
  { grants = 1 } = {},
) => {
  const redis = fakeRedis();
  const sent: OtpDeliveryInput[] = [];
  const delivery = {
    sendOtp: vi.fn(async (input: OtpDeliveryInput) => {
      sent.push(input);
    }),
  };
  const count = vi.fn().mockResolvedValue(grants);
  const prisma = { recipientMessageAccessGrant: { count } };
  const service = new RecipientAuthService(
    prisma as unknown as PrismaService,
    { client: redis.client } as unknown as RedisService,
    delivery,
    configOf(env),
  );
  const flush = () => new Promise((r) => setImmediate(r));
  // Request a code and return what the fake delivery captured.
  const request = async (email = SOFIA, ip = '1.1.1.1') => {
    const res = await service.requestOtp(email, ip);
    await flush();
    return { ...res, code: sent.at(-1)?.code };
  };
  return { service, redis, sent, delivery, count, request };
};

const wrongCode = (code: string) =>
  String((Number(code) + 1) % 1_000_000).padStart(6, '0');

describe('RecipientAuthService: request OTP', () => {
  it('returns the same generic body for known, unknown and grant-less emails', async () => {
    const known = setup();
    const unknown = setup({}, { grants: 0 });
    const a = await known.request();
    const b = await unknown.request('nobody@example.com');
    expect(a.message).toBe(OTP_REQUESTED);
    expect(Object.keys(a).sort()).toEqual(['challengeId', 'code', 'message']);
    expect(b.message).toBe(OTP_REQUESTED);
    expect(b.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the eligible email is actually sent a code.
    expect(known.sent).toHaveLength(1);
    expect(unknown.sent).toHaveLength(0);
  });

  it('checks eligibility against release grants for the given (normalized) email', async () => {
    const { count, request } = setup();
    await request(SOFIA);
    expect(count).toHaveBeenCalledWith({
      where: {
        recipientEmailNormalized: SOFIA,
        message: { status: 'RELEASED', deletedAt: null },
      },
      take: 1,
    });
  });

  it('sends a 6-digit code with the configured TTL', async () => {
    const { sent, request } = setup({ RECIPIENT_OTP_TTL_SECONDS: '120' });
    await request();
    expect(sent[0]).toEqual({
      email: SOFIA,
      code: expect.stringMatching(/^\d{6}$/),
      expiresInSeconds: 120,
    });
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

  it('stores only an HMAC of the code, with a Redis TTL', async () => {
    const { redis, request } = setup({ RECIPIENT_OTP_TTL_SECONDS: '120' });
    const { challengeId, code } = await request();
    const key = `for_after:recipient_otp:${challengeId}`;
    const stored = redis.store.get(key) as Record<string, string>;
    expect(JSON.stringify([...redis.store])).not.toContain(`"${code}"`);
    expect(stored.otpHash).toBe(
      crypto
        .createHmac('sha256', PEPPER)
        .update(`${challengeId}:${code}`)
        .digest('hex'),
    );
    expect(redis.ttl.get(key)).toBe(120_000);
  });

  it('challenge ids are random and unique', async () => {
    const { request } = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add((await request()).challengeId);
    expect(ids.size).toBe(5);
  });

  it('rate-limits per email (429) without revealing anything else', async () => {
    const { request } = setup({ RECIPIENT_OTP_REQUEST_LIMIT: '2' });
    await request(SOFIA, '1.1.1.1');
    await request(SOFIA, '2.2.2.2');
    const err = await request(SOFIA, '3.3.3.3').catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
    // A different email is unaffected.
    await expect(request('other@example.com', '4.4.4.4')).resolves.toBeTruthy();
  });

  it('rate-limits per IP across emails', async () => {
    const { request } = setup({ RECIPIENT_OTP_IP_REQUEST_LIMIT: '2' });
    await request('a@example.com');
    await request('b@example.com');
    await expect(request('c@example.com')).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('rate-limit keys hold no email address', async () => {
    const { redis, request } = setup();
    await request();
    const rateKeys = [...redis.store.keys()].filter((k) =>
      k.includes('recipient_rl'),
    );
    expect(rateKeys).toHaveLength(2);
    expect(rateKeys.join()).not.toMatch(/@|1\.1\.1\.1/);
  });

  it('a delivery failure does not fail or change the response', async () => {
    const { service, delivery } = setup();
    delivery.sendOtp.mockRejectedValue(new Error('provider down'));
    await expect(service.requestOtp(SOFIA, 'ip')).resolves.toMatchObject({
      message: OTP_REQUESTED,
    });
  });
});

describe('RecipientAuthService: verify OTP', () => {
  it('a correct code creates a session and consumes the challenge', async () => {
    const { service, redis, request } = setup();
    const { challengeId, code } = await request();
    const { sessionId, principal } = await service.verifyOtp(
      challengeId,
      code!,
    );
    expect(principal).toEqual({ emailNormalized: SOFIA });
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(redis.store.has(`for_after:recipient_otp:${challengeId}`)).toBe(
      false,
    );
    // Reuse is rejected.
    await expect(service.verifyOtp(challengeId, code!)).rejects.toThrow(
      INVALID_CODE,
    );
  });

  it('a wrong code is rejected with the generic message', async () => {
    const { service, request } = setup();
    const { challengeId, code } = await request();
    await expect(
      service.verifyOtp(challengeId, wrongCode(code!)),
    ).rejects.toThrow(new UnauthorizedException(INVALID_CODE));
    // Still usable after one miss.
    await expect(service.verifyOtp(challengeId, code!)).resolves.toBeTruthy();
  });

  it('an expired challenge is rejected and leaves no stray key', async () => {
    const { service, redis, request } = setup({
      RECIPIENT_OTP_TTL_SECONDS: '60',
    });
    const { challengeId, code } = await request();
    redis.advance(60_001);
    await expect(service.verifyOtp(challengeId, code!)).rejects.toThrow(
      INVALID_CODE,
    );
    expect(redis.store.has(`for_after:recipient_otp:${challengeId}`)).toBe(
      false,
    );
  });

  it('unknown challenge ids are rejected the same way', async () => {
    const { service } = setup();
    await expect(service.verifyOtp('x'.repeat(43), '123456')).rejects.toThrow(
      INVALID_CODE,
    );
  });

  it('after max attempts the challenge is unusable, even with the right code', async () => {
    const { service, request } = setup({ RECIPIENT_OTP_MAX_ATTEMPTS: '3' });
    const { challengeId, code } = await request();
    for (let i = 0; i < 3; i++) {
      await expect(
        service.verifyOtp(challengeId, wrongCode(code!)),
      ).rejects.toThrow(INVALID_CODE);
    }
    await expect(service.verifyOtp(challengeId, code!)).rejects.toThrow(
      INVALID_CODE,
    );
  });

  it('access is re-checked at verify time (no grants → no session)', async () => {
    const { service, count, request } = setup();
    const { challengeId, code } = await request();
    count.mockResolvedValue(0);
    await expect(service.verifyOtp(challengeId, code!)).rejects.toThrow(
      INVALID_CODE,
    );
  });

  it('a code for one challenge does not work on another', async () => {
    const { service, request } = setup();
    const first = await request();
    const second = await request();
    if (first.code === second.code) return; // 1 in a million
    await expect(
      service.verifyOtp(second.challengeId, first.code!),
    ).rejects.toThrow(INVALID_CODE);
  });

  it('verification is rate-limited per IP', async () => {
    const { service } = setup({ RECIPIENT_OTP_VERIFY_IP_LIMIT: '2' });
    const id = 'x'.repeat(43);
    for (let i = 0; i < 2; i++) {
      await expect(service.verifyOtp(id, '000000', 'ip')).rejects.toThrow(
        INVALID_CODE,
      );
    }
    const err = await service
      .verifyOtp(id, '000000', 'ip')
      .catch((e: unknown) => e);
    expect((err as HttpException).getStatus()).toBe(429);
  });
});

describe('RecipientAuthService: sessions and config', () => {
  it('sessions live in Redis under a hashed key, with the configured TTL', async () => {
    const { service, redis } = setup({ RECIPIENT_SESSION_TTL_SECONDS: '300' });
    const id = await service.createSession({ emailNormalized: SOFIA });
    const keys = [...redis.store.keys()];
    expect(keys.join()).not.toContain(id);
    expect(redis.client.set.mock.calls[0][2]).toEqual({
      expiration: { type: 'EX', value: 300 },
    });
    const stored = JSON.parse(redis.store.get(keys[0]) as string);
    expect(Object.keys(stored).sort()).toEqual([
      'authenticatedAt',
      'emailNormalized',
    ]);
    expect(await service.getSession(id)).toEqual({ emailNormalized: SOFIA });
    redis.advance(300_001);
    expect(await service.getSession(id)).toBeNull();
  });

  it('destroySession removes the session', async () => {
    const { service } = setup();
    const id = await service.createSession({ emailNormalized: SOFIA });
    await service.destroySession(id);
    expect(await service.getSession(id)).toBeNull();
  });

  it('cookie: separate name, HttpOnly, Lax; Secure only in production', () => {
    expect(RECIPIENT_SESSION_COOKIE).not.toBe(SESSION_COOKIE);
    expect(setup().service.cookieOptions()).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      domain: undefined,
      maxAge: 604800_000,
    });
    expect(
      setup({
        NODE_ENV: 'production',
        RECIPIENT_COOKIE_DOMAIN: '.x.test',
      }).service.cookieOptions(),
    ).toMatchObject({ secure: true, domain: '.x.test' });
  });

  it('refuses to start without a long enough RECIPIENT_OTP_PEPPER', () => {
    expect(() => setup({ RECIPIENT_OTP_PEPPER: undefined })).toThrow(
      /RECIPIENT_OTP_PEPPER/,
    );
    expect(() => setup({ RECIPIENT_OTP_PEPPER: 'short' })).toThrow(
      /RECIPIENT_OTP_PEPPER/,
    );
  });

  it('normal logs never contain the code, its hash, the pepper or session ids', async () => {
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    const { service, redis, request } = setup();
    const { challengeId, code } = await request();
    await service.verifyOtp(challengeId, wrongCode(code!)).catch(() => null);
    const { sessionId } = await service.verifyOtp(challengeId, code!);
    await service.destroySession(sessionId);
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    expect(logged).toContain('recipient_otp_requested');
    expect(logged).toContain('recipient_otp_invalid');
    expect(logged).toContain('recipient_otp_verified');
    expect(logged).toContain('recipient_session_created');
    expect(logged).toContain('recipient_session_logout');
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(challengeId);
    expect(logged).not.toContain(sessionId);
    expect(logged).not.toContain(PEPPER);
    expect(logged).not.toContain(SOFIA);
    expect(redis).toBeTruthy();
    spies.forEach((s) => s.mockRestore());
  });
});

describe('OTP delivery factory', () => {
  const factory = (env: Record<string, string>) =>
    otpDeliveryFactory(new ConfigService(env));

  it('console mode only in development', () => {
    expect(
      factory({
        NODE_ENV: 'development',
        RECIPIENT_OTP_DELIVERY_MODE: 'console',
      }),
    ).toBeInstanceOf(ConsoleOtpDelivery);
    for (const NODE_ENV of ['production', 'test', '']) {
      expect(() =>
        factory({ NODE_ENV, RECIPIENT_OTP_DELIVERY_MODE: 'console' }),
      ).toThrow(/only allowed with NODE_ENV=development/);
    }
  });

  it('defaults to disabled; unknown modes stop startup', () => {
    expect(factory({ NODE_ENV: 'production' })).toBeInstanceOf(
      DisabledOtpDelivery,
    );
    expect(() =>
      factory({ NODE_ENV: 'production', RECIPIENT_OTP_DELIVERY_MODE: 'smtp' }),
    ).toThrow(/RECIPIENT_OTP_DELIVERY_MODE/);
  });

  it('console delivery logs a DEV ONLY line with a masked email', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    await new ConsoleOtpDelivery('Recipient').sendOtp({
      email: SOFIA,
      code: '123456',
      expiresInSeconds: 600,
    });
    expect(warn).toHaveBeenCalledWith(
      '[DEV ONLY] Recipient OTP for s***@example.com: 123456',
    );
    warn.mockRestore();
  });
});

describe('RecipientSessionAuthGuard', () => {
  const ctx = (req: Partial<Request>) =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as never;

  it('reads only the Recipient cookie', () => {
    const req = {
      headers: {
        cookie: `${SESSION_COOKIE}=s%3Acustomer; ${RECIPIENT_SESSION_COOKIE}=abc`,
      },
    } as Request;
    expect(readRecipientSessionId(req)).toBe('abc');
    expect(
      readRecipientSessionId({
        headers: { cookie: `${SESSION_COOKIE}=s%3Acustomer` },
      } as Request),
    ).toBeUndefined();
  });

  it('valid session → principal on req.recipient (never req.user)', async () => {
    const { service } = setup();
    const id = await service.createSession({ emailNormalized: SOFIA });
    const req = {
      headers: { cookie: `${RECIPIENT_SESSION_COOKIE}=${id}` },
    } as Request;
    expect(
      await new RecipientSessionAuthGuard(service).canActivate(ctx(req)),
    ).toBe(true);
    expect(req.recipient).toEqual({ emailNormalized: SOFIA });
    expect(req.user).toBeUndefined();
  });

  it('missing, unknown or expired session → 401', async () => {
    const { service, redis } = setup({ RECIPIENT_SESSION_TTL_SECONDS: '10' });
    const guard = new RecipientSessionAuthGuard(service);
    const id = await service.createSession({ emailNormalized: SOFIA });
    redis.advance(10_001);
    for (const cookie of [
      undefined,
      `${RECIPIENT_SESSION_COOKIE}=nope`,
      `${RECIPIENT_SESSION_COOKIE}=${id}`,
      `${SESSION_COOKIE}=s%3Acustomer`,
    ]) {
      await expect(
        guard.canActivate(ctx({ headers: { cookie } } as Request)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });
});

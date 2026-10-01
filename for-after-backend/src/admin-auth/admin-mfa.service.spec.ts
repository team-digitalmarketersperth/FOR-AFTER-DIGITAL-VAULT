import { Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomBytes } from 'node:crypto';
import { generate } from 'otplib';
import { fakeRedis } from '../../test/fake-redis.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RedisService } from '../redis/redis.service.js';
import type { UsersService } from '../users/users.service.js';
import {
  decryptSecret,
  hashRecoveryCode,
  KEY_ERROR,
  parseTotpKey,
} from './admin-mfa-crypto.js';
import { AdminMfaService, INVALID_MFA } from './admin-mfa.service.js';
import { AdminRecoveryCodeDto, AdminTotpCodeDto } from './dto/admin-mfa.dto.js';

const KEY = randomBytes(32).toString('base64');

type Row = Record<string, unknown>;

// Just enough of Prisma for AdminMfaService, with conditional updateMany
// semantics (the replay / single-use guards depend on them).
const fakePrisma = () => {
  const users = new Map<string, Row>();
  const credentials = new Map<string, Row>();
  const codes: Row[] = [];
  const audit: Row[] = [];
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, cond]) => {
      if (k === 'OR') return (cond as Row[]).some((c) => matches(row, c));
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        const c = cond as { not?: unknown; lt?: bigint };
        if ('not' in c) return row[k] !== c.not && row[k] !== undefined;
        if ('lt' in c) return row[k] != null && (row[k] as bigint) < c.lt!;
      }
      return (row[k] ?? null) === cond;
    });
  const db = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const u = users.get(where.id);
        if (!u) return null;
        const c = credentials.get(where.id);
        return {
          ...u,
          adminMfaCredential: c
            ? {
                totpSecretEncrypted: c.totpSecretEncrypted,
                enabledAt: c.enabledAt ?? null,
              }
            : null,
        };
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) =>
        Object.assign(users.get(where.id)!, data),
    },
    adminMfaCredential: {
      findUnique: async ({ where }: { where: { userId: string } }) =>
        credentials.get(where.userId) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { userId: string };
        create: Row;
        update: Row;
      }) => {
        const found = credentials.get(where.userId);
        if (found) return Object.assign(found, update);
        credentials.set(where.userId, { enabledAt: null, ...create });
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = [...credentials.values()].filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    adminMfaRecoveryCode: {
      deleteMany: async ({ where }: { where: Row }) => {
        for (let i = codes.length - 1; i >= 0; i--) {
          if (matches(codes[i], where)) codes.splice(i, 1);
        }
      },
      createMany: async ({ data }: { data: Row[] }) => {
        codes.push(...data.map((d) => ({ ...d, usedAt: null })));
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = codes.filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      count: async ({ where }: { where: Row }) =>
        codes.filter((r) => matches(r, where)).length,
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        audit.push(data);
        return { id: String(audit.length) };
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(db),
  };
  return { db, users, credentials, codes, audit };
};

describe('AdminMfaService', () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let redis: ReturnType<typeof fakeRedis>;
  let service: AdminMfaService;
  let logs: string[];
  const ctx = { ip: '203.0.113.7', userAgent: 'vitest' };
  const admin = {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'ada@example.test',
    firstName: 'Ada',
    lastName: 'Admin',
    role: 'ADMIN',
    status: 'ACTIVE',
    emailVerifiedAt: null,
    twoFactorEnabled: false,
    createdAt: new Date(),
  };
  const events = () => prisma.audit.map((a) => a.eventType);

  const build = (env: Record<string, string> = {}) =>
    new AdminMfaService(
      prisma.db as unknown as PrismaService,
      redis as unknown as RedisService,
      new ConfigService({ ADMIN_TOTP_ENCRYPTION_KEY: KEY, ...env }),
    );

  beforeEach(() => {
    prisma = fakePrisma();
    redis = fakeRedis();
    prisma.users.set(admin.id, { ...admin });
    service = build();
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((msg: unknown) => {
        logs.push(String(msg));
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  const challenge = async () =>
    (await service.startChallenge(admin as never, ctx)).challengeId;
  const enroll = async () => {
    const id = await challenge();
    const { secret } = await service.setup(id);
    const { recoveryCodes } = await service.confirm(
      id,
      await generate({ secret }),
      ctx,
    );
    return { secret, recoveryCodes };
  };
  // A code from the next 30 s step: accepted (±30 s window) and newer than
  // the enrollment's step, so replay protection does not refuse it.
  const nextCode = (secret: string) =>
    generate({ secret, epoch: Math.floor(Date.now() / 1000) + 30 });

  describe('challenge', () => {
    it('first-time admin: challenge says setup required; Redis holds ids only', async () => {
      const res = await service.startChallenge(admin as never, ctx);
      expect(res).toMatchObject({ mfaRequired: true, mfaSetupRequired: true });
      expect(res.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const stored = redis.store.get(
        `for_after:admin_auth:challenge:${res.challengeId}`,
      ) as Row;
      expect(Object.keys(stored).sort()).toEqual([
        'attempts',
        'createdAt',
        'purpose',
        'userId',
      ]);
      expect(events()).toEqual(['ADMIN_PASSWORD_AUTH_SUCCEEDED']);
    });

    it('enrolled admin: setup not required', async () => {
      await enroll();
      const res = await service.startChallenge(admin as never, ctx);
      expect(res.mfaSetupRequired).toBe(false);
    });

    it('expired challenge is rejected', async () => {
      const id = await challenge();
      redis.advance(301_000);
      await expect(service.setup(id)).rejects.toThrow(INVALID_MFA);
      await expect(service.verifyTotp(id, '123456', ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('an unknown challenge (e.g. from a Customer, Recipient or Trusted Contact) is 401', async () => {
      const bogus = randomBytes(32).toString('base64url');
      await expect(service.setup(bogus)).rejects.toThrow(INVALID_MFA);
      await expect(service.confirm(bogus, '123456', ctx)).rejects.toThrow(
        INVALID_MFA,
      );
    });

    it('a challenge whose user is no longer an ACTIVE admin is refused and consumed', async () => {
      const id = await challenge();
      prisma.users.get(admin.id)!.role = 'CUSTOMER';
      await expect(service.setup(id)).rejects.toThrow(INVALID_MFA);
      prisma.users.get(admin.id)!.role = 'ADMIN';
      await expect(service.setup(id)).rejects.toThrow(INVALID_MFA);
    });
  });

  describe('enrollment', () => {
    it('generates a strong secret and stores it only encrypted', async () => {
      const id = await challenge();
      const a = await service.setup(id);
      // 20 random bytes = 160 bits, base32.
      expect(a.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(a.otpauthUri).toMatch(/^otpauth:\/\/totp\/For%20After:/);
      const stored = prisma.credentials.get(admin.id)!;
      expect(stored.enabledAt).toBeNull();
      expect(stored.totpSecretEncrypted).toMatch(/^v1\./);
      expect(stored.totpSecretEncrypted).not.toContain(a.secret);
      expect(
        decryptSecret(parseTotpKey(KEY), stored.totpSecretEncrypted as string),
      ).toBe(a.secret);
      // Calling setup again before confirm replaces the secret.
      const b = await service.setup(id);
      expect(b.secret).not.toBe(a.secret);
    });

    it('a correct code enables MFA, issues 10 hashed recovery codes and consumes the challenge', async () => {
      const id = await challenge();
      const { secret } = await service.setup(id);
      const code = await generate({ secret });
      const res = await service.confirm(id, code, ctx);
      expect(prisma.credentials.get(admin.id)!.enabledAt).toBeInstanceOf(Date);
      expect(prisma.users.get(admin.id)!.twoFactorEnabled).toBe(true);
      expect(res.recoveryCodes).toHaveLength(10);
      expect(new Set(res.recoveryCodes).size).toBe(10);
      res.recoveryCodes.forEach((c) =>
        expect(c).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      );
      // Hashes only.
      const stored = JSON.stringify(prisma.codes);
      res.recoveryCodes.forEach((c) => {
        expect(stored).not.toContain(c);
        expect(stored).not.toContain(c.replace(/-/g, ''));
      });
      expect(prisma.codes.map((c) => c.codeHash)).toEqual(
        res.recoveryCodes.map(hashRecoveryCode),
      );
      expect(events()).toContain('ADMIN_MFA_SETUP_COMPLETED');
      // Single use.
      await expect(service.confirm(id, code, ctx)).rejects.toThrow(INVALID_MFA);
    });

    it('a wrong code does not enable MFA', async () => {
      const id = await challenge();
      const { secret } = await service.setup(id);
      const wrong = String(
        (Number(await generate({ secret })) + 1) % 1e6,
      ).padStart(6, '0');
      await expect(service.confirm(id, wrong, ctx)).rejects.toThrow(
        INVALID_MFA,
      );
      expect(prisma.credentials.get(admin.id)!.enabledAt).toBeNull();
      expect(prisma.audit.at(-1)).toMatchObject({
        eventType: 'ADMIN_MFA_FAILED',
        metadata: { method: 'totp', reason: 'wrong_code' },
      });
    });

    it('setup and confirm are refused once MFA is enabled', async () => {
      await enroll();
      const id = await challenge();
      await expect(service.setup(id)).rejects.toThrow(/already set up/);
    });
  });

  describe('verification', () => {
    it('a correct code verifies; the challenge is single use', async () => {
      const { secret } = await enroll();
      const id = await challenge();
      const code = await nextCode(secret);
      const user = await service.verifyTotp(id, code, ctx);
      expect(user).toMatchObject({ id: admin.id, email: admin.email });
      expect(user).not.toHaveProperty('credential');
      expect(events()).toContain('ADMIN_MFA_VERIFIED');
      await expect(service.verifyTotp(id, code, ctx)).rejects.toThrow(
        INVALID_MFA,
      );
    });

    it('the same time step cannot be used twice, even with a new challenge', async () => {
      const { secret } = await enroll();
      const code = await nextCode(secret);
      await service.verifyTotp(await challenge(), code, ctx);
      await expect(
        service.verifyTotp(await challenge(), code, ctx),
      ).rejects.toThrow(INVALID_MFA);
      expect(prisma.audit.at(-1)).toMatchObject({
        eventType: 'ADMIN_MFA_FAILED',
        metadata: { reason: 'replay' },
      });
    });

    it('the enrollment code itself cannot be replayed to sign in', async () => {
      const id = await challenge();
      const { secret } = await service.setup(id);
      const code = await generate({ secret });
      await service.confirm(id, code, ctx);
      await expect(
        service.verifyTotp(await challenge(), code, ctx),
      ).rejects.toThrow(INVALID_MFA);
    });

    it('5 wrong codes invalidate the challenge; the password is needed again', async () => {
      const { secret } = await enroll();
      const id = await challenge();
      for (let i = 0; i < 5; i++) {
        await expect(service.verifyTotp(id, '000000', ctx)).rejects.toThrow(
          INVALID_MFA,
        );
      }
      await expect(
        service.verifyTotp(id, await nextCode(secret), ctx),
      ).rejects.toThrow(INVALID_MFA);
      expect(
        prisma.audit.filter((a) => a.eventType === 'ADMIN_MFA_FAILED'),
      ).toHaveLength(5);
    });

    it('rate limits verification per IP (429)', async () => {
      service = build({ ADMIN_TOTP_VERIFY_IP_LIMIT: '2' });
      await enroll(); // attempt 1 (confirm)
      const id = await challenge();
      await expect(service.verifyTotp(id, '000000', ctx)).rejects.toThrow(
        INVALID_MFA,
      ); // attempt 2
      await expect(service.verifyTotp(id, '000000', ctx)).rejects.toThrow(
        /Too many/,
      );
    });

    it('verify before enrollment is refused (setup required)', async () => {
      await expect(
        service.verifyTotp(await challenge(), '123456', ctx),
      ).rejects.toThrow(/setup is required/);
    });
  });

  describe('recovery codes', () => {
    it('a valid code signs in once, is audited, and cannot be reused', async () => {
      const { recoveryCodes } = await enroll();
      const code = recoveryCodes[3].toLowerCase(); // case/hyphens do not matter
      const res = await service.verifyRecoveryCode(
        await challenge(),
        code,
        ctx,
      );
      expect(res.user.id).toBe(admin.id);
      expect(res.remainingRecoveryCodes).toBe(9);
      expect(prisma.audit.at(-1)).toMatchObject({
        eventType: 'ADMIN_RECOVERY_CODE_USED',
        metadata: { remaining: 9 },
      });
      await expect(
        service.verifyRecoveryCode(await challenge(), code, ctx),
      ).rejects.toThrow(INVALID_MFA);
    });

    it('a wrong recovery code is rejected and audited', async () => {
      await enroll();
      await expect(
        service.verifyRecoveryCode(
          await challenge(),
          'AAAA-BBBB-CCCC-DDDD',
          ctx,
        ),
      ).rejects.toThrow(INVALID_MFA);
      expect(prisma.audit.at(-1)).toMatchObject({
        eventType: 'ADMIN_MFA_FAILED',
        metadata: { method: 'recovery' },
      });
    });
  });

  it('never logs or audits the TOTP secret, codes, recovery codes, challenge id or key', async () => {
    const id = await challenge();
    const { secret } = await service.setup(id);
    const code = await generate({ secret });
    const { recoveryCodes } = await service.confirm(id, code, ctx);
    await service
      .verifyRecoveryCode(await challenge(), recoveryCodes[0], ctx)
      .catch(() => undefined);
    const everything = JSON.stringify([
      logs,
      prisma.audit,
      [...redis.store.values()],
    ]);
    for (const value of [secret, code, KEY, id, ...recoveryCodes]) {
      expect(everything).not.toContain(value);
    }
    // Audit rows store a network prefix, not the raw IP.
    expect(everything).not.toContain(ctx.ip);
    expect(prisma.audit[0]).toMatchObject({ ipPrefix: '203.0.113.0/24' });
  });
});

describe('ADMIN_TOTP_ENCRYPTION_KEY', () => {
  it('requires 32 random base64 bytes and never echoes the value', () => {
    expect(parseTotpKey(KEY)).toHaveLength(32);
    for (const bad of [
      undefined,
      '',
      'too-short',
      Buffer.alloc(32).toString('base64'), // all zero: a placeholder
      randomBytes(16).toString('base64'),
      'x'.repeat(44),
    ]) {
      expect(() => parseTotpKey(bad)).toThrow(KEY_ERROR);
      try {
        parseTotpKey(bad);
      } catch (err) {
        if (bad) expect((err as Error).message).not.toContain(bad);
      }
    }
  });

  it('a tampered ciphertext fails to decrypt (authenticated encryption)', async () => {
    const { encryptSecret } = await import('./admin-mfa-crypto.js');
    const key = parseTotpKey(KEY);
    const stored = encryptSecret(key, 'JBSWY3DPEHPK3PXP');
    const parts = stored.split('.');
    parts[3] = Buffer.from('JBSWY3DPEHPK3PXQ').toString('base64url');
    expect(() => decryptSecret(key, parts.join('.'))).toThrow();
    expect(() =>
      decryptSecret(parseTotpKey(randomBytes(32).toString('base64')), stored),
    ).toThrow();
  });

  it('startup fails without a valid key', () => {
    expect(
      () =>
        new AdminMfaService(
          {} as PrismaService,
          {} as RedisService,
          new ConfigService({}),
        ),
    ).toThrow(KEY_ERROR);
  });
});

describe('Admin MFA DTOs', () => {
  const check = async (cls: new () => object, body: object) =>
    (await validate(plainToInstance(cls, body))).map((e) => e.property);
  const challengeId = 'a'.repeat(43);

  it('rejects malformed codes and challenge ids', async () => {
    expect(
      await check(AdminTotpCodeDto, { challengeId, code: '123456' }),
    ).toEqual([]);
    for (const code of ['12345', '1234567', 'abcdef', ' 123456', 123456]) {
      expect(await check(AdminTotpCodeDto, { challengeId, code })).toEqual([
        'code',
      ]);
    }
    expect(
      await check(AdminTotpCodeDto, { challengeId: 'short', code: '123456' }),
    ).toEqual(['challengeId']);
    expect(
      await check(AdminRecoveryCodeDto, {
        challengeId,
        recoveryCode: 'ABCD-EFGH-JKMN-PQRS',
      }),
    ).toEqual([]);
    expect(
      await check(AdminRecoveryCodeDto, {
        challengeId,
        recoveryCode: '123456',
      }),
    ).toEqual(['recoveryCode']);
  });
});

describe('SessionAuthGuard admin idle timeout', () => {
  const guardFor = (role: string) =>
    new SessionAuthGuard(
      {
        findById: async () => ({ id: 'u1', role, status: 'ACTIVE' }),
      } as unknown as UsersService,
      new ConfigService({ ADMIN_SESSION_IDLE_TIMEOUT_SECONDS: '1800' }),
    );
  const run = async (role: string, session: Row) => {
    const destroy = vi.fn((cb: () => void) => cb());
    const req = { session: { userId: 'u1', ...session, destroy } } as Row;
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) };
    const result = await guardFor(role)
      .canActivate(ctx as never)
      .catch((e: unknown) => e);
    return { result, destroy, req };
  };

  it('active admin session passes and refreshes lastActivityAt', async () => {
    const before = Date.now() - 60_000;
    const { result, req } = await run('ADMIN', {
      adminMfaVerifiedAt: before,
      lastActivityAt: before,
    });
    expect(result).toBe(true);
    expect((req.session as Row).lastActivityAt).toBeGreaterThan(before);
  });

  it('an idle admin session is destroyed (401)', async () => {
    const old = Date.now() - 1_801_000;
    const { result, destroy } = await run('SUPER_ADMIN', {
      adminMfaVerifiedAt: old,
      lastActivityAt: old,
    });
    expect(result).toBeInstanceOf(UnauthorizedException);
    expect(destroy).toHaveBeenCalled();
  });

  it('an admin session without MFA is destroyed (401)', async () => {
    const { result, destroy } = await run('ADMIN', {});
    expect(result).toBeInstanceOf(UnauthorizedException);
    expect(destroy).toHaveBeenCalled();
  });

  it('Customer sessions have no idle timeout (unchanged)', async () => {
    const { result, destroy } = await run('CUSTOMER', {});
    expect(result).toBe(true);
    expect(destroy).not.toHaveBeenCalled();
  });
});

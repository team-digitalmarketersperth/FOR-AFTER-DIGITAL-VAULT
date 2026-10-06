import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import argon2 from 'argon2';
import { UserRole, UserStatus } from '../generated/prisma/client.js';
import type { SafeUser, UsersService } from '../users/users.service.js';
import { AuthTokensService } from './auth-tokens.service.js';
import { AuthService, INVALID_LINK } from './auth.service.js';

// Argon2id is deliberately slow; with the whole suite running in parallel a
// test here can exceed the 5 s default, so this file gets more headroom.
vi.setConfig({ testTimeout: 20_000 });

const PASSWORD = 'StrongPassword123!';

const storedUser = async (status: UserStatus = UserStatus.ACTIVE) => ({
  id: 'u1',
  email: 'lisa@example.com',
  firstName: 'Lisa',
  lastName: 'Smith',
  role: UserRole.CUSTOMER,
  status,
  emailVerifiedAt: null,
  twoFactorEnabled: false,
  createdAt: new Date(),
  passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }),
});

// Phase 04 token side: covered by auth-tokens.service.spec and the e2e suite.
const tokens = {
  sendVerification: vi.fn().mockResolvedValue(undefined),
  sendPasswordReset: vi.fn().mockResolvedValue(undefined),
  verifyEmail: vi.fn(),
  resetPassword: vi.fn(),
};

const serviceWith = (found: Awaited<ReturnType<typeof storedUser>> | null) => {
  const users = {
    findByEmail: vi.fn().mockResolvedValue(found),
    createUser: vi.fn((input: { passwordHash: string }) =>
      Promise.resolve({ id: 'new', ...input } as unknown as SafeUser),
    ),
  };
  return {
    users,
    auth: new AuthService(
      users as unknown as UsersService,
      tokens as unknown as AuthTokensService,
    ),
  };
};

describe('AuthService', () => {
  const registerDto = {
    email: 'lisa@example.com',
    password: PASSWORD,
    firstName: 'Lisa',
    lastName: 'Smith',
  };

  it('hashes the password with Argon2id on registration', async () => {
    const { users, auth } = serviceWith(null);
    await auth.register(registerDto);
    const { passwordHash } = users.createUser.mock.calls[0][0];
    expect(passwordHash).toMatch(/^\$argon2id\$/);
    expect(passwordHash).not.toContain(PASSWORD);
    expect(await argon2.verify(passwordHash, PASSWORD)).toBe(true);
  });

  it('rejects a duplicate email with 409', async () => {
    const { users, auth } = serviceWith(await storedUser());
    await expect(auth.register(registerDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(users.createUser).not.toHaveBeenCalled();
  });

  it('logs in with the correct password and strips passwordHash', async () => {
    const { auth } = serviceWith(await storedUser());
    const user = await auth.validateLogin({
      email: 'lisa@example.com',
      password: PASSWORD,
    });
    expect(user.id).toBe('u1');
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const wrong = await serviceWith(await storedUser())
      .auth.validateLogin({
        email: 'lisa@example.com',
        password: 'nope-nope-nope',
      })
      .catch((e: unknown) => e);
    const unknown = await serviceWith(null)
      .auth.validateLogin({ email: 'who@example.com', password: PASSWORD })
      .catch((e: unknown) => e);

    expect(wrong).toBeInstanceOf(UnauthorizedException);
    expect(unknown).toBeInstanceOf(UnauthorizedException);
    expect((wrong as Error).message).toBe((unknown as Error).message);
  });

  it.each([UserStatus.SUSPENDED, UserStatus.DELETED, UserStatus.PASSED])(
    'denies a %s account even with the right password',
    async (status) => {
      const { auth } = serviceWith(await storedUser(status));
      await expect(
        auth.validateLogin({ email: 'lisa@example.com', password: PASSWORD }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('does not reveal a non-active status to a wrong password', async () => {
    const { auth } = serviceWith(await storedUser(UserStatus.SUSPENDED));
    await expect(
      auth.validateLogin({
        email: 'lisa@example.com',
        password: 'wrong-password!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('changePassword (Step 22)', () => {
    const actor = { type: 'CUSTOMER' as const, userId: 'u1' };
    const setup = async () => {
      const users = {
        findPasswordHash: vi
          .fn()
          .mockResolvedValue((await storedUser()).passwordHash),
        updatePassword: vi.fn().mockResolvedValue(undefined),
      };
      return {
        users,
        auth: new AuthService(
          users as unknown as UsersService,
          tokens as unknown as AuthTokensService,
        ),
      };
    };

    it('stores a new Argon2id hash after the current password is verified', async () => {
      const { users, auth } = await setup();
      await auth.changePassword(
        'u1',
        { currentPassword: PASSWORD, newPassword: 'A new long passphrase' },
        actor,
      );
      const [id, hash, audited] = users.updatePassword.mock.calls[0];
      expect(id).toBe('u1');
      expect(audited).toBe(actor);
      expect(hash).toMatch(/^\$argon2id\$/);
      expect(await argon2.verify(hash, 'A new long passphrase')).toBe(true);
    });

    it('a wrong current password is 400 (not 401) and changes nothing', async () => {
      const { users, auth } = await setup();
      await expect(
        auth.changePassword(
          'u1',
          {
            currentPassword: 'wrong-password!',
            newPassword: 'A new long one!',
          },
          actor,
        ),
      ).rejects.toThrow(
        new BadRequestException('Your current password is incorrect.'),
      );
      expect(users.updatePassword).not.toHaveBeenCalled();
    });

    it('refuses reusing the current password', async () => {
      const { users, auth } = await setup();
      await expect(
        auth.changePassword(
          'u1',
          { currentPassword: PASSWORD, newPassword: PASSWORD },
          actor,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(users.updatePassword).not.toHaveBeenCalled();
    });
  });
});

describe('AuthService: verification and reset (Phase 04)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('registration emails a verification link (in the background)', async () => {
    const { auth } = serviceWith(null);
    const user = await auth.register({
      email: 'new@example.com',
      password: PASSWORD,
      firstName: 'New',
      lastName: 'Person',
    });
    expect(tokens.sendVerification).toHaveBeenCalledWith(user);
  });

  it.each([
    ['unknown email', null, false],
    ['unverified ACTIVE', { status: 'ACTIVE', emailVerifiedAt: null }, true],
    [
      'already verified',
      { status: 'ACTIVE', emailVerifiedAt: new Date() },
      false,
    ],
    ['suspended', { status: 'SUSPENDED', emailVerifiedAt: null }, false],
  ])('resend verification: %s', async (_, found, sends) => {
    const { auth } = serviceWith(
      found as Awaited<ReturnType<typeof storedUser>> | null,
    );
    await auth.resendVerification('x@example.com');
    expect(tokens.sendVerification).toHaveBeenCalledTimes(sends ? 1 : 0);
  });

  it.each([
    ['unknown email', null, false],
    ['ACTIVE Customer', { status: 'ACTIVE', role: 'CUSTOMER' }, true],
    ['admin', { status: 'ACTIVE', role: 'ADMIN' }, false],
    ['passed', { status: 'PASSED', role: 'CUSTOMER' }, false],
  ])('forgot password: %s', async (_, found, sends) => {
    const { auth } = serviceWith(
      found as Awaited<ReturnType<typeof storedUser>> | null,
    );
    await auth.requestPasswordReset('x@example.com');
    expect(tokens.sendPasswordReset).toHaveBeenCalledTimes(sends ? 1 : 0);
  });

  it('a bad verify or reset link is one generic 400', async () => {
    const { auth } = serviceWith(null);
    tokens.verifyEmail.mockResolvedValue(false);
    tokens.resetPassword.mockResolvedValue(false);
    await expect(auth.verifyEmail('t', {})).rejects.toThrow(INVALID_LINK);
    await expect(auth.resetPassword('t', PASSWORD, {})).rejects.toThrow(
      INVALID_LINK,
    );
  });

  it('reset stores an Argon2id hash of the new password, never the password', async () => {
    const { auth } = serviceWith(null);
    tokens.resetPassword.mockResolvedValue(true);
    await auth.resetPassword('t', PASSWORD, {});
    const hash = tokens.resetPassword.mock.calls[0][1] as string;
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(hash, PASSWORD)).toBe(true);
  });
});

describe('AuthService: change email (Phase 08)', () => {
  const lisa = {
    id: 'u-lisa',
    email: 'lisa@example.com',
    firstName: 'Lisa',
  } as unknown as SafeUser;
  const setup = async (taken: string | null = null) => {
    vi.clearAllMocks();
    const users = {
      findPasswordHash: vi
        .fn()
        .mockResolvedValue((await storedUser()).passwordHash),
      findByEmail: vi.fn(async (email: string) =>
        email === taken ? { id: 'someone-else' } : null,
      ),
    };
    const changeTokens = {
      requestEmailChange: vi.fn().mockResolvedValue('raw-token'),
      pendingEmailChange: vi.fn().mockResolvedValue(null),
      sendEmailChange: vi.fn().mockResolvedValue(undefined),
      cancelEmailChange: vi.fn().mockResolvedValue(undefined),
      confirmEmailChange: vi.fn(),
      sendEmailChangedNotice: vi.fn().mockResolvedValue(undefined),
    };
    const auth = new AuthService(
      users as unknown as UsersService,
      changeTokens as unknown as AuthTokensService,
    );
    return { auth, users, changeTokens };
  };
  const meta = { ip: '203.0.113.9' };

  it('re-authenticates, then issues a link for the new address only (masked answer)', async () => {
    const { auth, changeTokens } = await setup();
    await expect(
      auth.requestEmailChange(
        lisa,
        { newEmail: 'new@example.com', currentPassword: PASSWORD },
        meta,
      ),
    ).resolves.toEqual({ pendingEmail: 'n***@example.com' });
    expect(changeTokens.requestEmailChange).toHaveBeenCalledWith(
      'u-lisa',
      'new@example.com',
      meta,
    );
    expect(changeTokens.sendEmailChange).toHaveBeenCalledWith(
      lisa,
      'new@example.com',
      'raw-token',
    );
  });

  it.each([
    [
      'a wrong current password',
      'new@example.com',
      'wrong-password-123',
      'Your current password is incorrect.',
    ],
    [
      'the current address',
      'lisa@example.com',
      PASSWORD,
      'This is already your email address.',
    ],
    [
      'an address another account uses',
      'taken@example.com',
      PASSWORD,
      'An account with this email already exists.',
    ],
  ])(
    'refuses %s; nothing is issued or sent',
    async (_, newEmail, currentPassword, message) => {
      const { auth, changeTokens } = await setup('taken@example.com');
      await expect(
        auth.requestEmailChange(lisa, { newEmail, currentPassword }, meta),
      ).rejects.toThrow(message);
      expect(changeTokens.requestEmailChange).not.toHaveBeenCalled();
      expect(changeTokens.sendEmailChange).not.toHaveBeenCalled();
    },
  );

  it('the per-account cap is a 429', async () => {
    const { auth, changeTokens } = await setup();
    changeTokens.requestEmailChange.mockResolvedValue(null);
    const err = await auth
      .requestEmailChange(
        lisa,
        { newEmail: 'new@example.com', currentPassword: PASSWORD },
        meta,
      )
      .catch((e: unknown) => e);
    expect((err as { getStatus: () => number }).getStatus()).toBe(429);
    expect(changeTokens.sendEmailChange).not.toHaveBeenCalled();
  });

  it('resend needs a pending request and re-sends to that address', async () => {
    const { auth, changeTokens } = await setup();
    await expect(auth.resendEmailChange(lisa, meta)).rejects.toThrow(
      'There is no email change waiting to be verified.',
    );
    changeTokens.pendingEmailChange.mockResolvedValue('new@example.com');
    await auth.resendEmailChange(lisa, meta);
    expect(changeTokens.sendEmailChange).toHaveBeenCalledWith(
      lisa,
      'new@example.com',
      'raw-token',
    );
  });

  it('confirm: bad link 400, address taken 409, success tells the OLD address', async () => {
    const { auth, changeTokens } = await setup();
    changeTokens.confirmEmailChange.mockResolvedValueOnce({
      result: 'invalid',
    });
    await expect(auth.confirmEmailChange('t', meta)).rejects.toThrow(
      INVALID_LINK,
    );
    changeTokens.confirmEmailChange.mockResolvedValueOnce({ result: 'taken' });
    await expect(auth.confirmEmailChange('t', meta)).rejects.toThrow(
      'An account with this email already exists.',
    );
    expect(changeTokens.sendEmailChangedNotice).not.toHaveBeenCalled();
    changeTokens.confirmEmailChange.mockResolvedValueOnce({
      result: 'changed',
      userId: 'u-lisa',
      oldEmail: 'lisa@example.com',
      firstName: 'Lisa',
    });
    await auth.confirmEmailChange('t', meta);
    expect(changeTokens.sendEmailChangedNotice).toHaveBeenCalledWith(
      'u-lisa',
      'lisa@example.com',
      'Lisa',
    );
  });
});

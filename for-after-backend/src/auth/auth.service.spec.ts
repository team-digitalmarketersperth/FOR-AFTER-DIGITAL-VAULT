import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import argon2 from 'argon2';
import { UserRole, UserStatus } from '../generated/prisma/client.js';
import type { SafeUser, UsersService } from '../users/users.service.js';
import { AuthService } from './auth.service.js';

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

const serviceWith = (found: Awaited<ReturnType<typeof storedUser>> | null) => {
  const users = {
    findByEmail: vi.fn().mockResolvedValue(found),
    createUser: vi.fn((input: { passwordHash: string }) =>
      Promise.resolve({ id: 'new', ...input } as unknown as SafeUser),
    ),
  };
  return { users, auth: new AuthService(users as unknown as UsersService) };
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
      return { users, auth: new AuthService(users as unknown as UsersService) };
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

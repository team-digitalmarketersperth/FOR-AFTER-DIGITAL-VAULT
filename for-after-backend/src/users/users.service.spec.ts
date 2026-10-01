import { ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

const setup = () => {
  const user = { findUnique: vi.fn(), create: vi.fn() };
  return {
    user,
    service: new UsersService({ user } as unknown as PrismaService),
  };
};

describe('UsersService', () => {
  it('findByEmail selects passwordHash for credential checks', async () => {
    const { user, service } = setup();
    user.findUnique.mockResolvedValue(null);
    await service.findByEmail('lisa@example.com');
    expect(user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'lisa@example.com' },
        select: expect.objectContaining({ passwordHash: true }),
      }),
    );
  });

  it('findById never selects passwordHash', async () => {
    const { user, service } = setup();
    user.findUnique.mockResolvedValue(null);
    await service.findById('id-1');
    expect(user.findUnique.mock.calls[0][0].select).not.toHaveProperty(
      'passwordHash',
    );
  });

  it('createUser stores only the given fields and returns a safe user', async () => {
    const { user, service } = setup();
    user.create.mockResolvedValue({ id: 'id-1' });
    await service.createUser({
      email: 'lisa@example.com',
      passwordHash: 'hash',
      firstName: 'Lisa',
      lastName: 'Smith',
    });
    const args = user.create.mock.calls[0][0];
    expect(args.data).toEqual({
      email: 'lisa@example.com',
      passwordHash: 'hash',
      firstName: 'Lisa',
      lastName: 'Smith',
    });
    expect(args.select).not.toHaveProperty('passwordHash');
  });

  it('turns a unique-email race (P2002) into 409', async () => {
    const { user, service } = setup();
    user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );
    await expect(
      service.createUser({
        email: 'a@b.co',
        passwordHash: 'h',
        firstName: 'A',
        lastName: 'B',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

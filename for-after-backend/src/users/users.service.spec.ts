import { ConflictException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { UsersService } from './users.service.js';

const setup = () => {
  const user = { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() };
  const auditLog = { create: vi.fn() };
  const prisma = {
    user,
    auditLog,
    $transaction: (fn: (tx: unknown) => unknown) => fn({ user, auditLog }),
  };
  return {
    user,
    auditLog,
    service: new UsersService(prisma as unknown as PrismaService),
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

  it('findById never selects passwordHash (passwordChangedAt is for the guard)', async () => {
    const { user, service } = setup();
    user.findUnique.mockResolvedValue(null);
    await service.findById('id-1');
    const { select } = user.findUnique.mock.calls[0][0];
    expect(select).not.toHaveProperty('passwordHash');
    expect(select).toHaveProperty('passwordChangedAt', true);
  });

  it('updateProfile writes only the name and returns a safe user', async () => {
    const { user, service } = setup();
    user.update.mockResolvedValue({ id: 'id-1' });
    await service.updateProfile('id-1', {
      firstName: 'Lisa',
      ...({ email: 'x@example.com', role: 'ADMIN' } as object),
    });
    const args = user.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: 'id-1' });
    expect(args.data).toEqual({ firstName: 'Lisa', lastName: undefined });
    expect(args.select).not.toHaveProperty('passwordHash');
  });

  it('updatePassword stores hash + passwordChangedAt and audits without secrets', async () => {
    const { user, auditLog, service } = setup();
    await service.updatePassword('id-1', 'new-hash', {
      type: 'CUSTOMER',
      userId: 'id-1',
      ip: '203.0.113.7',
    });
    expect(user.update.mock.calls[0][0].data).toEqual({
      passwordHash: 'new-hash',
      passwordChangedAt: expect.any(Date),
    });
    const { data } = auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({
      eventType: 'PASSWORD_CHANGED',
      actorType: 'CUSTOMER',
      actorUserId: 'id-1',
      subjectType: 'User',
      subjectId: 'id-1',
      ipPrefix: '203.0.113.0/24',
      metadata: undefined,
    });
    expect(JSON.stringify(data)).not.toContain('new-hash');
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

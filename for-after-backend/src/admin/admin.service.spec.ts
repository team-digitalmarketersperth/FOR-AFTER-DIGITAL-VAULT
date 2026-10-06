import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { AuditActor } from '../audit/audit-log.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AdminQueuesService } from './admin-queues.service.js';
import { AdminService } from './admin.service.js';

type Row = { id: string; role: string; status: string; email: string };

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const SUPER_ID = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const PASSED_ID = '55555555-5555-4555-8555-555555555555';

const actor = (type: 'ADMIN' | 'SUPER_ADMIN', userId: string): AuditActor => ({
  type,
  userId,
  ip: '203.0.113.9',
});

const setup = () => {
  const users = new Map<string, Row>(
    [
      { id: ADMIN_ID, role: 'ADMIN', status: 'ACTIVE' },
      { id: SUPER_ID, role: 'SUPER_ADMIN', status: 'ACTIVE' },
      { id: CUSTOMER_ID, role: 'CUSTOMER', status: 'ACTIVE' },
      { id: OTHER_ADMIN_ID, role: 'ADMIN', status: 'ACTIVE' },
      { id: PASSED_ID, role: 'CUSTOMER', status: 'PASSED' },
    ].map((u) => [u.id, { ...u, email: `${u.id}@example.test` }]),
  );
  const audit: Record<string, unknown>[] = [];
  const findMany = vi.fn(async () => []);
  const db = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const u = users.get(where.id);
        return u
          ? {
              ...u,
              firstName: 'F',
              lastName: 'L',
              twoFactorEnabled: false,
              _count: {
                recipients: 2,
                trustedContacts: 1,
                messages: 4,
                memoryVaultItems: 3,
              },
              deathVerificationCases: [],
            }
          : null;
      }),
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) =>
        users.get(where.id)!,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string; role: string };
        data: { status: string };
      }) => {
        const u = users.get(where.id);
        if (!u || u.status !== where.status || u.role !== where.role) {
          return { count: 0 };
        }
        u.status = data.status;
        return { count: 1 };
      },
      findMany,
      count: vi.fn(async () => 60),
      groupBy: vi.fn(async () => [
        { status: 'ACTIVE', _count: { _all: 7 } },
        { status: 'PASSED', _count: { _all: 1 } },
      ]),
    },
    message: { count: vi.fn(async () => 1) },
    deathVerificationCase: {
      groupBy: vi.fn(async () => [
        { status: 'READY_FOR_REVIEW', _count: { _all: 2 } },
      ]),
    },
    auditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audit.push(data);
        return { id: 'a' };
      },
    },
    $transaction: async (arg: unknown) =>
      typeof arg === 'function' ? arg(db) : Promise.all(arg as unknown[]),
  };
  const queues = { failedTotal: vi.fn(async (): Promise<number | null> => 3) };
  const service = new AdminService(
    db as unknown as PrismaService,
    queues as unknown as AdminQueuesService,
  );
  return { service, users, audit, db, queues, findMany };
};

describe('AdminService', () => {
  describe('users list', () => {
    it('search/role/status filters, bounded pages, safe fields only', async () => {
      const { service, findMany } = setup();
      const res = await service.listUsers({
        page: 2,
        limit: 25,
        search: 'lisa',
        role: 'CUSTOMER',
        status: 'SUSPENDED',
      });
      const args = (
        findMany.mock.calls[0] as unknown as [Record<string, never>]
      )[0];
      expect(args).toMatchObject({
        where: {
          role: 'CUSTOMER',
          status: 'SUSPENDED',
          OR: [
            { email: { contains: 'lisa', mode: 'insensitive' } },
            { firstName: { contains: 'lisa', mode: 'insensitive' } },
            { lastName: { contains: 'lisa', mode: 'insensitive' } },
          ],
        },
        skip: 25,
        take: 25,
      });
      expect(Object.keys(args.select).sort()).toEqual([
        'createdAt',
        'email',
        'firstName',
        'id',
        'lastName',
        'role',
        'status',
        'updatedAt',
      ]);
      expect(res.pagination).toEqual({
        page: 2,
        limit: 25,
        total: 60,
        pages: 3,
      });
    });

    it('no search → no name/email filter', async () => {
      const { service, findMany } = setup();
      await service.listUsers({ page: 1, limit: 25 });
      const args = (
        findMany.mock.calls[0] as unknown as [{ where: object }]
      )[0];
      expect(args.where).toEqual({
        role: undefined,
        status: undefined,
        OR: undefined,
      });
    });
  });

  describe('user detail', () => {
    it('returns metadata + counts, no private content, and audits the view', async () => {
      const { service, audit, db } = setup();
      const res = await service.getUser(CUSTOMER_ID, actor('ADMIN', ADMIN_ID));
      expect(res.counts).toEqual({
        recipientCount: 2,
        trustedContactCount: 1,
        messageCount: 4,
        releasedMessageCount: 1,
        memoryVaultCount: 3,
      });
      const select = (
        db.user.findUnique.mock.calls[0] as unknown as [{ select: object }]
      )[0].select;
      expect(Object.keys(select)).not.toEqual(
        expect.arrayContaining(['passwordHash']),
      );
      for (const field of [
        'passwordHash',
        'messages',
        'myStoryResponses',
        'myWishResponses',
        'adminMfaCredential',
        'adminMfaRecoveryCodes',
      ]) {
        expect(select).not.toHaveProperty(field);
      }
      // Phase 10: the current case is the newest one, chosen deterministically.
      expect(select).toMatchObject({
        deathVerificationCases: {
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          take: 1,
        },
      });
      expect(res.deathVerification).toBeNull();
      expect(audit).toEqual([
        expect.objectContaining({
          eventType: 'ADMIN_VIEWED_USER',
          actorUserId: ADMIN_ID,
          subjectType: 'User',
          subjectId: CUSTOMER_ID,
        }),
      ]);
    });

    it('unknown user → 404, nothing audited', async () => {
      const { service, audit } = setup();
      await expect(
        service.getUser(
          '99999999-9999-4999-8999-999999999999',
          actor('ADMIN', ADMIN_ID),
        ),
      ).rejects.toThrow(NotFoundException);
      expect(audit).toEqual([]);
    });
  });

  describe('suspend / reactivate', () => {
    it('ADMIN suspends an ACTIVE Customer; audited with before/after + reason', async () => {
      const { service, users, audit } = setup();
      const res = await service.suspend(
        CUSTOMER_ID,
        'Administrative suspension.',
        actor('ADMIN', ADMIN_ID),
      );
      expect(res.status).toBe('SUSPENDED');
      expect(users.get(CUSTOMER_ID)!.status).toBe('SUSPENDED');
      expect(audit).toEqual([
        expect.objectContaining({
          eventType: 'USER_SUSPENDED',
          actorType: 'ADMIN',
          actorUserId: ADMIN_ID,
          subjectId: CUSTOMER_ID,
          metadata: {
            previousStatus: 'ACTIVE',
            newStatus: 'SUSPENDED',
            reason: 'Administrative suspension.',
          },
        }),
      ]);
      // Already suspended → 409, nothing more audited.
      await expect(
        service.suspend(CUSTOMER_ID, 'again', actor('ADMIN', ADMIN_ID)),
      ).rejects.toThrow('already suspended');
      expect(audit).toHaveLength(1);
    });

    it('reactivates SUSPENDED only; never PASSED or an ACTIVE account', async () => {
      const { service, users, audit } = setup();
      users.get(CUSTOMER_ID)!.status = 'SUSPENDED';
      await service.reactivate(CUSTOMER_ID, null, actor('ADMIN', ADMIN_ID));
      expect(users.get(CUSTOMER_ID)!.status).toBe('ACTIVE');
      expect(audit[0]).toMatchObject({ eventType: 'USER_REACTIVATED' });
      await expect(
        service.reactivate(PASSED_ID, 'x', actor('SUPER_ADMIN', SUPER_ID)),
      ).rejects.toThrow(ConflictException);
      expect(users.get(PASSED_ID)!.status).toBe('PASSED');
      await expect(
        service.reactivate(CUSTOMER_ID, 'x', actor('ADMIN', ADMIN_ID)),
      ).rejects.toThrow('not suspended');
      // PASSED cannot be suspended either (status is not ACTIVE).
      await expect(
        service.suspend(PASSED_ID, 'x', actor('ADMIN', ADMIN_ID)),
      ).rejects.toThrow(/verified death/);
    });

    it('role safety: no self-change, ADMIN cannot manage admins, nobody manages SUPER_ADMIN', async () => {
      const { service, users, audit } = setup();
      await expect(
        service.suspend(ADMIN_ID, 'x', actor('ADMIN', ADMIN_ID)),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.suspend(OTHER_ADMIN_ID, 'x', actor('ADMIN', ADMIN_ID)),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.suspend(SUPER_ID, 'x', actor('ADMIN', ADMIN_ID)),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.suspend(SUPER_ID, 'x', actor('SUPER_ADMIN', SUPER_ID)),
      ).rejects.toThrow(ForbiddenException);
      expect(audit).toEqual([]);
      // SUPER_ADMIN may suspend an ADMIN.
      await service.suspend(
        OTHER_ADMIN_ID,
        'x',
        actor('SUPER_ADMIN', SUPER_ID),
      );
      expect(users.get(OTHER_ADMIN_ID)!.status).toBe('SUSPENDED');
      expect(audit[0]).toMatchObject({ actorType: 'SUPER_ADMIN' });
    });

    it('unknown user → 404', async () => {
      const { service } = setup();
      await expect(
        service.suspend(
          '99999999-9999-4999-8999-999999999999',
          'x',
          actor('ADMIN', ADMIN_ID),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('dashboard', () => {
    it('real aggregates; failed jobs null (not 0) when Redis is unreadable', async () => {
      const { service, queues } = setup();
      expect(await service.dashboard()).toEqual({
        users: { total: 8, active: 7, suspended: 0, passed: 1, deleted: 0 },
        deathVerification: {
          pending: 0,
          safeguardActive: 0,
          readyForReview: 2,
        },
        queues: { failed: 3 },
      });
      queues.failedTotal.mockResolvedValueOnce(null);
      expect((await service.dashboard()).queues).toEqual({ failed: null });
    });
  });
});

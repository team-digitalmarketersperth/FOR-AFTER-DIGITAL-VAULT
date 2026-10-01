import { NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuditLogQueryDto, PageQueryDto } from '../admin/dto/admin.dto.js';
import { AdminAuditController } from '../admin/admin.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  actorTypeFor,
  AuditLogService,
  ipPrefix,
  paginate,
  writeAuditLog,
} from './audit-log.service.js';

const actor = {
  type: 'ADMIN' as const,
  userId: '11111111-1111-4111-8111-111111111111',
  ip: '198.51.100.23',
  userAgent: 'x'.repeat(400),
};

describe('AuditLog', () => {
  it('stores a network prefix, never the raw IP', () => {
    expect(ipPrefix('198.51.100.23')).toBe('198.51.100.0/24');
    expect(ipPrefix('::ffff:198.51.100.23')).toBe('198.51.100.0/24');
    expect(ipPrefix('2001:db8:85a3:1:2:3:4:5')).toBe('2001:db8:85a3::/48');
    expect(ipPrefix('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(ipPrefix('::1')).toBe('0:0:0::/48');
    expect(ipPrefix('not-an-ip')).toBeNull();
    expect(ipPrefix(undefined)).toBeNull();
  });

  it('writes a minimal row; secret-looking metadata keys are dropped', async () => {
    const create = vi.fn(async () => ({ id: 'a1' }));
    await writeAuditLog({ auditLog: { create } } as never, {
      eventType: 'USER_SUSPENDED',
      actor,
      subjectType: 'User',
      subjectId: 'u2',
      metadata: {
        previousStatus: 'ACTIVE',
        newStatus: 'SUSPENDED',
        reason: 'Administrative suspension.',
        password: 'hunter2',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        recoveryCode: 'AAAA-BBBB-CCCC-DDDD',
        otp: '123456',
        sessionId: 's',
        privateNote: 'n',
        textContent: 'Dear Sofia',
        accessUrl: 'https://storage.test/x',
      },
    });
    const data = (create.mock.calls[0] as unknown as [{ data: object }])[0]
      .data;
    expect(data).toEqual({
      eventType: 'USER_SUSPENDED',
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      subjectType: 'User',
      subjectId: 'u2',
      ipPrefix: '198.51.100.0/24',
      userAgent: 'x'.repeat(256),
      metadata: {
        previousStatus: 'ACTIVE',
        newStatus: 'SUSPENDED',
        reason: 'Administrative suspension.',
      },
    });
    expect(JSON.stringify(data)).not.toMatch(
      /hunter2|JBSWY|AAAA-BBBB|123456|Dear Sofia|storage\.test|198\.51\.100\.23/,
    );
  });

  it('SUPER_ADMIN actors are recorded as such', () => {
    expect(actorTypeFor('SUPER_ADMIN')).toBe('SUPER_ADMIN');
    expect(actorTypeFor('ADMIN')).toBe('ADMIN');
  });

  it('is append-only: no update/delete in the service or routes', () => {
    const methods = (proto: object) => Object.getOwnPropertyNames(proto);
    expect(methods(AuditLogService.prototype).sort()).toEqual([
      'constructor',
      'get',
      'list',
      'record',
    ]);
    expect(methods(AdminAuditController.prototype).sort()).toEqual([
      'constructor',
      'get',
      'list',
    ]);
  });

  describe('list', () => {
    const findMany = vi.fn(async () => [{ id: 'a1' }]);
    const count = vi.fn(async () => 51);
    const prisma = {
      auditLog: { findMany, count, findUnique: vi.fn(async () => null) },
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    } as unknown as PrismaService;
    const service = new AuditLogService(prisma);

    it('filters by event, actor, subject and date; bounded pages', async () => {
      const res = await service.list({
        page: 3,
        limit: 25,
        eventType: 'USER_SUSPENDED',
        actorUserId: actor.userId,
        subjectType: 'User',
        subjectId: 'u2',
        from: '2026-01-01T00:00:00Z',
        to: '2026-12-31T00:00:00Z',
      });
      const args = (
        findMany.mock.calls[0] as unknown as [Record<string, unknown>]
      )[0];
      expect(args).toMatchObject({
        where: {
          eventType: 'USER_SUSPENDED',
          actorUserId: actor.userId,
          subjectType: 'User',
          subjectId: 'u2',
          createdAt: {
            gte: new Date('2026-01-01T00:00:00Z'),
            lte: new Date('2026-12-31T00:00:00Z'),
          },
        },
        skip: 50,
        take: 25,
      });
      expect(res.pagination).toEqual({
        page: 3,
        limit: 25,
        total: 51,
        pages: 3,
      });
    });

    it('unknown id → 404', async () => {
      await expect(service.get('nope')).rejects.toThrow(NotFoundException);
    });
  });

  it('pagination math', () => {
    expect(paginate(1, 25, 0)).toEqual({
      page: 1,
      limit: 25,
      total: 0,
      pages: 0,
    });
    expect(paginate(2, 100, 101)).toMatchObject({ pages: 2 });
  });

  it('query DTOs: defaults, max 100, typed filters', async () => {
    const parse = (cls: new () => object, q: object) => plainToInstance(cls, q);
    const errors = async (cls: new () => object, q: object) =>
      (await validate(parse(cls, q))).map((e) => e.property);
    expect(parse(PageQueryDto, {})).toMatchObject({ page: 1, limit: 25 });
    expect(parse(PageQueryDto, { page: '2', limit: '10' })).toMatchObject({
      page: 2,
      limit: 10,
    });
    expect(await errors(PageQueryDto, { limit: '101' })).toEqual(['limit']);
    expect(await errors(PageQueryDto, { page: '0' })).toEqual(['page']);
    expect(await errors(AuditLogQueryDto, { eventType: 'NOPE' })).toEqual([
      'eventType',
    ]);
    expect(await errors(AuditLogQueryDto, { actorUserId: 'x' })).toEqual([
      'actorUserId',
    ]);
    expect(await errors(AuditLogQueryDto, { from: 'yesterday' })).toEqual([
      'from',
    ]);
  });
});

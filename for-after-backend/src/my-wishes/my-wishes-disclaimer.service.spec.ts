import { ConflictException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AcknowledgeDisclaimerDto } from './dto/acknowledge-disclaimer.dto.js';
import {
  DISCLAIMER_NOT_ACKNOWLEDGED,
  DISCLAIMER_OUTDATED,
  MY_WISHES_DISCLAIMER_V1,
  MyWishesDisclaimer,
  MyWishesDisclaimerService,
} from './my-wishes-disclaimer.service.js';
import { MyWishesDisclaimerController } from './my-wishes.controller.js';

// Phase 15A (approved 2026-10-08 by the product owner).
const APPROVED_V1 =
  'My Wishes records personal preferences and guidance only. It is not a will, legal document, medical directive, financial instruction or substitute for professional advice.';
const ACK_AT = new Date('2026-10-08T00:00:00Z');

const setup = (version = 1) => {
  const myWishesDisclaimerAcknowledgement = {
    findUnique: vi.fn().mockResolvedValue(null),
    createMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  const auditLog = { create: vi.fn().mockResolvedValue({}) };
  const tx = { myWishesDisclaimerAcknowledgement, auditLog };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  const current = Object.assign(new MyWishesDisclaimer(), { version });
  const service = new MyWishesDisclaimerService(
    { ...tx, $transaction } as unknown as PrismaService,
    current,
  );
  return { myWishesDisclaimerAcknowledgement, auditLog, $transaction, service };
};

describe('My Wishes notice (Phase 15A)', () => {
  it('version 1 is exactly the approved wording', () => {
    expect(MY_WISHES_DISCLAIMER_V1).toBe(APPROVED_V1);
    expect(new MyWishesDisclaimer()).toMatchObject({
      version: 1,
      text: APPROVED_V1,
    });
  });

  it('status: current version and text, acknowledgement required, the user’s own state only', async () => {
    const { myWishesDisclaimerAcknowledgement: ack, service } = setup();
    expect(await service.status('lisa')).toEqual({
      version: 1,
      text: APPROVED_V1,
      requiresAcknowledgement: true,
      acknowledged: false,
      acknowledgedAt: null,
    });
    expect(ack.findUnique).toHaveBeenCalledWith({
      where: {
        userId_disclaimerVersion: { userId: 'lisa', disclaimerVersion: 1 },
      },
      select: { acknowledgedAt: true },
    });
    ack.findUnique.mockResolvedValue({ acknowledgedAt: ACK_AT });
    expect(await service.status('lisa')).toMatchObject({
      acknowledged: true,
      acknowledgedAt: ACK_AT,
    });
  });

  it('acknowledge: one row for this user and version, one audit event with the version only', async () => {
    const {
      myWishesDisclaimerAcknowledgement: ack,
      auditLog,
      service,
    } = setup();
    ack.findUnique.mockResolvedValue({ acknowledgedAt: ACK_AT });
    const res = await service.acknowledge('lisa', 1);
    expect(ack.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'lisa', disclaimerVersion: 1 }],
      skipDuplicates: true,
    });
    expect(auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({
      eventType: 'MY_WISHES_DISCLAIMER_ACKNOWLEDGED',
      actorType: 'CUSTOMER',
      actorUserId: 'lisa',
      subjectType: 'User',
      subjectId: 'lisa',
      metadata: { disclaimerVersion: 1 },
      ipPrefix: null,
      userAgent: null,
    });
    // Never the notice text or any wish content.
    expect(JSON.stringify(data)).not.toContain('will');
    expect(res).toMatchObject({ acknowledged: true });
  });

  it('acknowledging again (or concurrently) adds no row and no second audit event', async () => {
    const {
      myWishesDisclaimerAcknowledgement: ack,
      auditLog,
      service,
    } = setup();
    ack.createMany.mockResolvedValue({ count: 0 });
    await service.acknowledge('lisa', 1);
    expect(auditLog.create).not.toHaveBeenCalled();
  });

  it('only the current version can be acknowledged (an old one does not count for a new one)', async () => {
    const { myWishesDisclaimerAcknowledgement: ack, service } = setup(2);
    await expect(service.acknowledge('lisa', 1)).rejects.toThrow(
      new ConflictException(DISCLAIMER_OUTDATED),
    );
    expect(ack.createMany).not.toHaveBeenCalled();
    // The v2 check looks for a v2 row, so a v1 row never satisfies it.
    await service.status('lisa');
    expect(
      ack.findUnique.mock.calls[0][0].where.userId_disclaimerVersion
        .disclaimerVersion,
    ).toBe(2);
  });

  it('assertAcknowledged: 409 without a row for the current version', async () => {
    const { myWishesDisclaimerAcknowledgement: ack, service } = setup();
    await expect(service.assertAcknowledged('lisa')).rejects.toThrow(
      DISCLAIMER_NOT_ACKNOWLEDGED,
    );
    ack.findUnique.mockResolvedValue({ acknowledgedAt: ACK_AT });
    await expect(service.assertAcknowledged('lisa')).resolves.toBeUndefined();
  });

  describe('AcknowledgeDisclaimerDto', () => {
    const errorsFor = async (body: object) =>
      (
        await validate(plainToInstance(AcknowledgeDisclaimerDto, body), {
          whitelist: true,
          forbidNonWhitelisted: true,
        })
      ).map((e) => e.property);
    it('accepts a version only', async () => {
      expect(await errorsFor({ version: 1 })).toEqual([]);
    });
    it.each([
      ['version', {}],
      ['version', { version: '1' }],
      ['version', { version: 0 }],
      ['version', { version: 1.5 }],
      ['userId', { version: 1, userId: 'john' }],
      ['acknowledgedAt', { version: 1, acknowledgedAt: '2020-01-01' }],
      ['text', { version: 1, text: 'my own words' }],
    ])('rejects %s in %o', async (field, body) => {
      expect(await errorsFor(body)).toContain(field);
    });
  });

  describe('MyWishesDisclaimerController guards', () => {
    it('requires a session and the CUSTOMER role', () => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, MyWishesDisclaimerController),
      ).toEqual([SessionAuthGuard, CustomerGuard]);
    });
    it.each(['ADMIN', 'SUPER_ADMIN'])('CustomerGuard rejects %s', (role) => {
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as ExecutionContext;
      expect(new CustomerGuard().canActivate(ctx)).toBe(false);
    });
  });
});

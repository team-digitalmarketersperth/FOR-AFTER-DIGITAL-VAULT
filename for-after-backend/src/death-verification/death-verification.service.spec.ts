import {
  BadRequestException,
  ConflictException,
  Logger,
  ValidationPipe,
} from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { DeathVerificationQueue } from './death-verification-queue.service.js';
import {
  ALREADY_REPORTED,
  DeathVerificationService,
  NOT_ACCEPTING_REPORTS,
  REPORT_RECEIVED,
  type Reporter,
} from './death-verification.service.js';
import {
  CreateDeathReportDto,
  latestToday,
} from './dto/create-death-report.dto.js';

// Same options as the global pipe in app.setup.ts.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});
const check = (body: object) =>
  pipe.transform(body, { type: 'body', metatype: CreateDeathReportDto });
const rejects = (body: object) =>
  expect(check(body)).rejects.toBeInstanceOf(BadRequestException);

describe('CreateDeathReportDto', () => {
  it('accepts confirmReport only, and a past or today date', async () => {
    await expect(check({ confirmReport: true })).resolves.toBeTruthy();
    await expect(
      check({ confirmReport: true, reportedDateOfDeath: '2026-09-28' }),
    ).resolves.toBeTruthy();
    const today = new Date().toISOString().slice(0, 10);
    await expect(
      check({ confirmReport: true, reportedDateOfDeath: today }),
    ).resolves.toBeTruthy();
  });

  it('rejects future, impossible and non date-only values', async () => {
    const tomorrowEverywhere = new Date(
      Date.now() + 2 * 86_400_000 + 14 * 3_600_000,
    )
      .toISOString()
      .slice(0, 10);
    for (const reportedDateOfDeath of [
      tomorrowEverywhere,
      '2099-01-01',
      '2026-02-30',
      '2026-9-1',
      '2026-09-28T00:00:00Z',
      'yesterday',
    ]) {
      await rejects({ confirmReport: true, reportedDateOfDeath });
    }
  });

  it('"today" allows the furthest-ahead timezone (UTC+14), no further', () => {
    const utcEvening = new Date('2026-09-28T12:00:00Z');
    expect(latestToday(utcEvening)).toBe('2026-09-29');
    expect(latestToday(new Date('2026-09-28T09:00:00Z'))).toBe('2026-09-28');
  });

  it('confirmReport must be boolean true', async () => {
    for (const confirmReport of [undefined, false, 'true', 1]) {
      await rejects({ confirmReport });
    }
  });

  it('note: optional, trimmed, max 2000', async () => {
    const dto = (await check({
      confirmReport: true,
      note: '  Fictional test report.  ',
    })) as CreateDeathReportDto;
    expect(dto.note).toBe('Fictional test report.');
    expect(
      (
        (await check({
          confirmReport: true,
          note: '   ',
        })) as CreateDeathReportDto
      ).note,
    ).toBeNull();
    await rejects({ confirmReport: true, note: 'x'.repeat(2001) });
  });

  it('rejects unknown and injected fields (ownerUserId, status, VERIFIED...)', async () => {
    for (const extra of [
      { ownerUserId: '00000000-0000-4000-8000-000000000000' },
      { status: 'VERIFIED' },
      { verified: true },
      { trustedContactId: 'x' },
    ]) {
      await rejects({ confirmReport: true, ...extra });
    }
  });
});

describe('DeathVerificationService', () => {
  const reporter: Reporter = {
    id: 'tc-1',
    ownerUserId: 'owner-1',
    firstName: 'David',
    lastName: 'Test',
    email: 'david@example.com',
    mobile: ' +61 400 000 000 ',
  };
  const NOTE = 'Private fictional note that must never be logged.';

  // Records every model the service touches, inside or outside the transaction.
  const setup = ({
    status = 'PENDING_VERIFICATION',
    createError,
  }: { status?: string; createError?: unknown } = {}) => {
    const touched = new Set<string>();
    const created: Record<string, unknown>[] = [];
    const models = {
      deathVerificationCase: {
        createMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({ id: 'case-1', status })),
        findUnique: vi.fn(),
      },
      deathReport: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (createError) throw createError;
          created.push(data);
          return { id: 'report-1', createdAt: new Date('2026-09-29') };
        }),
      },
      deathVerificationAuditEvent: { create: vi.fn(async () => ({})) },
    };
    const tracked = new Proxy(models as Record<string, unknown>, {
      get: (target, name: string) => {
        touched.add(name);
        return target[name];
      },
    });
    const prisma = new Proxy(
      {
        $transaction: (fn: (tx: unknown) => unknown) => fn(tracked),
      } as Record<string, unknown>,
      {
        get: (target, name: string) =>
          name === '$transaction' ? target[name] : (tracked as never)[name],
      },
    );
    const queue = { afterReport: vi.fn(async () => undefined) };
    const service = new DeathVerificationService(
      prisma as unknown as PrismaService,
      queue as unknown as DeathVerificationQueue,
    );
    return { service, models, touched, created, queue };
  };

  it('files a report into a PENDING_VERIFICATION case with a reporter snapshot', async () => {
    const { service, models, created } = setup();
    const receipt = await service.submitReport(reporter, {
      confirmReport: true,
      reportedDateOfDeath: '2026-09-28',
      note: NOTE,
    });
    expect(receipt).toEqual({
      caseId: 'case-1',
      reportId: 'report-1',
      status: 'PENDING_VERIFICATION',
      reportedAt: expect.any(Date),
      message: REPORT_RECEIVED,
    });
    expect(models.deathVerificationCase.createMany).toHaveBeenCalledWith({
      data: [{ ownerUserId: 'owner-1' }],
      skipDuplicates: true,
    });
    expect(created[0]).toEqual({
      deathVerificationCaseId: 'case-1',
      reportedByTrustedContactId: 'tc-1',
      reporterFirstNameSnapshot: 'David',
      reporterLastNameSnapshot: 'Test',
      reporterEmailNormalized: 'david@example.com',
      reporterMobileNormalized: '+61 400 000 000',
      reportedDateOfDeath: new Date('2026-09-28T00:00:00.000Z'),
      note: NOTE,
    });
  });

  it('touches only the case, the report and its audit row (no Message, schedule, release, grant or User)', async () => {
    const { service, touched, models } = setup();
    await service.submitReport(reporter, { confirmReport: true });
    expect([...touched].sort()).toEqual([
      'deathReport',
      'deathVerificationAuditEvent',
      'deathVerificationCase',
    ]);
    expect(models.deathVerificationAuditEvent.create).toHaveBeenCalledWith({
      data: {
        deathVerificationCaseId: 'case-1',
        eventType: 'REPORT_RECEIVED',
        actorType: 'TRUSTED_CONTACT',
        actorUserId: null,
        actorTrustedContactId: 'tc-1',
      },
    });
  });

  it('a first report starts the safety-notice workflow; later reports do not', async () => {
    const first = setup();
    await first.service.submitReport(reporter, { confirmReport: true });
    expect(first.queue.afterReport).toHaveBeenCalledWith('case-1');
    const later = setup({ status: 'SAFEGUARD_ACTIVE' });
    await later.service.submitReport(reporter, { confirmReport: true });
    expect(later.queue.afterReport).not.toHaveBeenCalled();
  });

  it('never sets a case status: the case stays as found (PENDING_VERIFICATION)', async () => {
    const { service, models } = setup();
    await service.submitReport(reporter, { confirmReport: true });
    // Status is left to the column default (PENDING_VERIFICATION).
    expect(
      JSON.stringify(models.deathVerificationCase.createMany.mock.calls),
    ).not.toContain('status');
  });

  it('duplicate report by the same contact → 409 with a safe message', async () => {
    const { service } = setup({
      createError: new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    });
    await expect(
      service.submitReport(reporter, { confirmReport: true }),
    ).rejects.toThrow(new ConflictException(ALREADY_REPORTED));
  });

  it('a closed case (VERIFIED, REJECTED, CANCELLED) accepts no new reports', async () => {
    for (const status of ['VERIFIED', 'REJECTED', 'CANCELLED']) {
      const { service, created } = setup({ status });
      await expect(
        service.submitReport(reporter, { confirmReport: true }),
      ).rejects.toThrow(NOT_ACCEPTING_REPORTS);
      expect(created).toHaveLength(0);
    }
  });

  it('an open case under safeguard or review still accepts supporting reports', async () => {
    for (const status of ['SAFEGUARD_ACTIVE', 'READY_FOR_REVIEW']) {
      const { service, created } = setup({ status });
      const receipt = await service.submitReport(reporter, {
        confirmReport: true,
      });
      expect(receipt.status).toBe(status);
      expect(created).toHaveLength(1);
    }
  });

  it('logs ids only: never the note or reporter details', async () => {
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
    );
    const { service } = setup();
    await service.submitReport(reporter, { confirmReport: true, note: NOTE });
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    expect(logged).toContain('death_report_submitted');
    expect(logged).not.toMatch(/death_verified/);
    for (const secret of [NOTE, 'David', 'david@example.com', '400 000']) {
      expect(logged).not.toContain(secret);
    }
    spies.forEach((s) => s.mockRestore());
  });
});

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
  // `status` = the Customer's current (newest) case; none → a new case.
  const setup = ({
    status,
    createError,
  }: { status?: string; createError?: unknown } = {}) => {
    const touched = new Set<string>();
    const created: Record<string, unknown>[] = [];
    const models = {
      // 1st: the User row lock; 2nd: the current case, row-locked.
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(status ? [{ id: 'case-1', status }] : []),
      deathVerificationCase: {
        create: vi.fn(
          async ({
            data,
          }: {
            data: { reopenedFromCaseId: string | null };
          }) => ({
            id: data.reopenedFromCaseId ? 'case-2' : 'case-1',
            status: 'PENDING_VERIFICATION',
          }),
        ),
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
    expect(models.deathVerificationCase.create).toHaveBeenCalledWith({
      data: { ownerUserId: 'owner-1', reopenedFromCaseId: null },
      select: { id: true, status: true },
    });
    // Serialised per Customer: User row lock, then the current case row lock.
    const sql = models.$queryRaw.mock.calls.map((c) => c[0].join('?'));
    expect(sql[0]).toMatch(/FROM "User" WHERE id = \?::uuid FOR UPDATE/);
    expect(sql[1]).toMatch(
      /"DeathVerificationCase"[\s\S]*ORDER BY "openedAt" DESC, id DESC LIMIT 1 FOR UPDATE/,
    );
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
      '$queryRaw',
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
    // (A second report into a PENDING case re-pokes the idempotent workflow.)
    await later.service.submitReport(reporter, { confirmReport: true });
    expect(later.queue.afterReport).not.toHaveBeenCalled();
  });

  it('never sets a case status: the case stays as found (PENDING_VERIFICATION)', async () => {
    const { service, models } = setup();
    await service.submitReport(reporter, { confirmReport: true });
    // Status is left to the column default (PENDING_VERIFICATION).
    const [[{ data }]] = models.deathVerificationCase.create.mock.calls;
    expect(data).not.toHaveProperty('status');
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

  it('a VERIFIED case is never reopened: 409, no case or report written', async () => {
    const { service, models, created, queue } = setup({ status: 'VERIFIED' });
    await expect(
      service.submitReport(reporter, { confirmReport: true }),
    ).rejects.toThrow(NOT_ACCEPTING_REPORTS);
    expect(models.deathVerificationCase.create).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    expect(queue.afterReport).not.toHaveBeenCalled();
  });

  it('after CANCELLED or REJECTED a report opens a NEW case linked to the old one (Phase 10)', async () => {
    for (const status of ['CANCELLED', 'REJECTED']) {
      const { service, models, created, queue } = setup({ status });
      const receipt = await service.submitReport(reporter, {
        confirmReport: true,
      });
      expect(receipt).toMatchObject({
        caseId: 'case-2',
        status: 'PENDING_VERIFICATION',
      });
      expect(models.deathVerificationCase.create).toHaveBeenCalledWith({
        data: { ownerUserId: 'owner-1', reopenedFromCaseId: 'case-1' },
        select: { id: true, status: true },
      });
      // The old case is never written to: only the new case gets rows.
      expect(created[0].deathVerificationCaseId).toBe('case-2');
      const events = models.deathVerificationAuditEvent.create.mock.calls.map(
        (c) => (c as unknown as [{ data: Record<string, unknown> }])[0].data,
      );
      expect(events).toEqual([
        expect.objectContaining({
          deathVerificationCaseId: 'case-2',
          eventType: 'CASE_REOPENED',
          actorTrustedContactId: 'tc-1',
        }),
        expect.objectContaining({
          deathVerificationCaseId: 'case-2',
          eventType: 'REPORT_RECEIVED',
        }),
      ]);
      // The normal workflow starts again: safety notice, then safeguard.
      expect(queue.afterReport).toHaveBeenCalledWith('case-2');
    }
  });

  it('an open case still accepts supporting reports; no second case is opened', async () => {
    for (const status of [
      'PENDING_VERIFICATION',
      'SAFEGUARD_ACTIVE',
      'READY_FOR_REVIEW',
    ]) {
      const { service, created, models } = setup({ status });
      const receipt = await service.submitReport(reporter, {
        confirmReport: true,
      });
      expect(receipt.status).toBe(status);
      expect(created).toHaveLength(1);
      expect(models.deathVerificationCase.create).not.toHaveBeenCalled();
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

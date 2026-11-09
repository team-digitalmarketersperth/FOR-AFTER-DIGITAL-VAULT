import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminReleasesController } from './admin.controller.js';
import {
  AdminReleasesService,
  assessRelease,
  pastDueWhere,
  RELEASE_NOT_FOUND,
} from './admin-releases.service.js';
import { ReleaseListQueryDto } from './dto/admin.dto.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const PAST = new Date('2026-10-01T00:00:00.000Z');
const FUTURE = new Date('2027-01-01T00:00:00.000Z');
const ID = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const OWNER = '11111111-1111-4111-8111-111111111111';

const schedule = (triggerType: string, scheduledFor: Date | null = null, afterDeathDays: number | null = null) => ({
  triggerType,
  scheduledFor,
  afterDeathDays,
  createdAt: PAST,
  updatedAt: PAST,
});
const assess = (over: Record<string, unknown>) =>
  assessRelease(
    { status: 'SCHEDULED', schedule: null, deathActivation: null, pastDueOccurrences: 0, ...over } as Parameters<
      typeof assessRelease
    >[0],
    NOW,
  );
const activation = (triggerType: string, dueAt: Date, status = 'VERIFIED') => ({
  triggerType,
  dueAt,
  deathVerificationCase: { status },
});

describe('assessRelease (current assessment, evaluated at a stated time)', () => {
  it('released and cancelled come from the persisted status', () => {
    expect(assess({ status: 'RELEASED', schedule: schedule('FIXED_DATE', PAST) })).toBe('released');
    expect(assess({ status: 'CANCELLED', schedule: schedule('FIXED_DATE', PAST) })).toBe('cancelled');
  });

  it('a future date is scheduled, never past due; a past one is past due', () => {
    expect(assess({ schedule: schedule('FIXED_DATE', FUTURE) })).toBe('scheduled');
    expect(assess({ schedule: schedule('CUSTOM_EVENT', FUTURE) })).toBe('scheduled');
    expect(assess({ schedule: schedule('FIXED_DATE', PAST) })).toBe('past_due');
    expect(assess({ schedule: schedule('NOW') })).toBe('past_due');
  });

  it('after-death schedules wait for a verified death, however old they are', () => {
    const old = { ...schedule('ON_DEATH'), createdAt: new Date('2020-01-01T00:00:00Z') };
    expect(assess({ schedule: old })).toBe('awaiting_death_verification');
    expect(assess({ schedule: schedule('AFTER_DEATH', null, 30) })).toBe('awaiting_death_verification');
    // An activation whose case is not VERIFIED does not count.
    expect(
      assess({ schedule: schedule('ON_DEATH'), deathActivation: activation('ON_DEATH', PAST, 'READY_FOR_REVIEW') }),
    ).toBe('awaiting_death_verification');
    expect(
      assess({ schedule: schedule('AFTER_DEATH', null, 30), deathActivation: activation('AFTER_DEATH', FUTURE) }),
    ).toBe('scheduled');
    expect(assess({ schedule: schedule('ON_DEATH'), deathActivation: activation('ON_DEATH', PAST) })).toBe('past_due');
  });

  it('recurring triggers: past due only with a pending occurrence due by now', () => {
    expect(assess({ schedule: schedule('BIRTHDAY') })).toBe('recurring');
    expect(assess({ schedule: schedule('ANNIVERSARY'), pastDueOccurrences: 2 })).toBe('past_due');
    expect(assess({ schedule: schedule('ANNUAL_AFTER_DEATH') })).toBe('awaiting_death_verification');
    expect(
      assess({ schedule: schedule('ANNUAL_AFTER_DEATH'), deathActivation: activation('ANNUAL_AFTER_DEATH', PAST) }),
    ).toBe('recurring');
  });

  it('a scheduled message without a schedule row is reported as such', () => {
    expect(assess({})).toBe('no_schedule');
  });

  it('pastDueWhere is the reconciler’s due rule at now, live SCHEDULED messages only', () => {
    const w = pastDueWhere(NOW);
    expect(w).toMatchObject({ status: 'SCHEDULED', deletedAt: null });
    expect(JSON.stringify(w)).toContain(NOW.toISOString());
    expect(JSON.stringify(w)).toContain('"VERIFIED"');
  });
});

// Reads only: any write (or any table not listed) fails the test.
const READS = new Set(['findMany', 'findFirst', 'count', 'groupBy']);
function fakePrisma(tables: Record<string, Record<string, (...a: never[]) => unknown>>) {
  const calls: { table: string; method: string; args: unknown }[] = [];
  const db = new Proxy(
    {},
    {
      get(_t, table: string) {
        if (table === '$transaction') return (ops: Promise<unknown>[]) => Promise.all(ops);
        return new Proxy(
          {},
          {
            get(_x, method: string) {
              if (!READS.has(method)) throw new Error(`unexpected ${table}.${method}`);
              const fn = tables[table]?.[method];
              if (!fn) throw new Error(`unexpected ${table}.${method}`);
              return (args: unknown) => {
                calls.push({ table, method, args });
                return Promise.resolve((fn as (a: unknown) => unknown)(args));
              };
            },
          },
        );
      },
    },
  );
  return { db: db as unknown as PrismaService, calls };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  ownerUserId: OWNER,
  status: 'SCHEDULED',
  updatedAt: PAST,
  schedule: schedule('ON_DEATH'),
  release: null,
  deathActivation: null,
  _count: { recipientReleases: 0 },
  ...over,
});

describe('AdminReleasesService.list', () => {
  const setup = (rows = [row()], cases: unknown[] = []) =>
    fakePrisma({
      message: { findMany: () => rows, count: () => rows.length },
      deathVerificationCase: { findMany: () => cases },
    });

  it('ids, states and times only, with the open case only while waiting on it', async () => {
    const { db } = setup(
      [row()],
      [{ ownerUserId: OWNER, status: 'SAFEGUARD_ACTIVE', safeguardEndsAt: FUTURE }],
    );
    const res = await new AdminReleasesService(db).list(
      plainToInstance(ReleaseListQueryDto, {}),
      NOW,
    );
    expect(res).toEqual({
      evaluatedAt: NOW.toISOString(),
      items: [
        {
          reference: ID,
          accountId: OWNER,
          status: 'SCHEDULED',
          triggerType: 'ON_DEATH',
          scheduledFor: null,
          releasedAt: null,
          assessment: 'awaiting_death_verification',
          deathCaseStatus: 'SAFEGUARD_ACTIVE',
          safeguardEndsAt: FUTURE,
          lastRecordedAt: PAST,
        },
      ],
      pagination: expect.objectContaining({ page: 1, limit: 25, total: 1 }),
    });
  });

  it('selects no title, text, note or recipient detail', async () => {
    const { db, calls } = setup();
    await new AdminReleasesService(db).list(plainToInstance(ReleaseListQueryDto, {}), NOW);
    const select = JSON.stringify(calls.find((c) => c.table === 'message' && c.method === 'findMany')!.args);
    expect(select).not.toMatch(/title|textContent|privateNote|email|mobile|firstName|eventLabel/);
  });

  it('filters compose; pastDue uses the shared definition; stable order with an id tie-breaker', async () => {
    const { db, calls } = setup([]);
    await new AdminReleasesService(db).list(
      plainToInstance(ReleaseListQueryDto, {
        status: 'SCHEDULED',
        triggerType: 'FIXED_DATE',
        pastDue: 'true',
        accountId: OWNER,
        reference: ID,
        scheduledFrom: '2026-10-01T00:00:00Z',
        scheduledTo: '2026-10-31T00:00:00Z',
        sort: 'scheduledFor',
        dir: 'asc',
        page: '2',
        limit: '10',
      }),
      NOW,
    );
    const args = calls.find((c) => c.method === 'findMany' && c.table === 'message')!.args as {
      where: { AND: unknown[] };
      orderBy: unknown[];
      skip: number;
      take: number;
    };
    expect(args.where.AND).toContainEqual(pastDueWhere(NOW));
    expect(args.where.AND).toContainEqual({ id: ID });
    expect(args.where.AND).toContainEqual({ ownerUserId: OWNER });
    expect(args.where.AND).toContainEqual({ schedule: { triggerType: 'FIXED_DATE' } });
    expect(args.orderBy).toEqual([{ schedule: { scheduledFor: { sort: 'asc', nulls: 'last' } } }, { id: 'asc' }]);
    expect([args.skip, args.take]).toEqual([10, 10]);
    // No owners on the page: no case query at all.
    expect(calls.some((c) => c.table === 'deathVerificationCase')).toBe(false);
  });

  it('defaults: newest change first, id tie-breaker; drafts and deleted messages excluded', async () => {
    const { db, calls } = setup([]);
    await new AdminReleasesService(db).list(plainToInstance(ReleaseListQueryDto, {}), NOW);
    const args = calls[0].args as { where: { AND: unknown[] }; orderBy: unknown[] };
    expect(args.orderBy).toEqual([{ updatedAt: 'desc' }, { id: 'desc' }]);
    expect(args.where.AND[0]).toEqual({ deletedAt: null, status: { in: ['SCHEDULED', 'RELEASED', 'CANCELLED'] } });
  });

  it('a reversed date range is 400', async () => {
    const { db } = setup();
    await expect(
      new AdminReleasesService(db).list(
        plainToInstance(ReleaseListQueryDto, { scheduledFrom: '2026-11-01T00:00:00Z', scheduledTo: '2026-10-01T00:00:00Z' }),
        NOW,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('AdminReleasesService.detail', () => {
  const detailRow = {
    id: ID,
    ownerUserId: OWNER,
    status: 'RELEASED',
    schedule: { ...schedule('FIXED_DATE', PAST), updatedAt: new Date('2026-10-02T00:00:00Z') },
    release: { id: 'r1', triggerType: 'FIXED_DATE', scheduledFor: PAST, releasedAt: new Date('2026-10-01T00:00:05Z'), _count: { accessGrants: 2 } },
    deathActivation: null,
    _count: { recipients: 2 },
  };
  const setup = (found: unknown = detailRow) =>
    fakePrisma({
      message: { findFirst: () => found },
      messageRecipientRelease: { count: () => 0, findFirst: () => null, findMany: () => [] },
      releaseNotification: {
        groupBy: () => [
          { status: 'SENT', _count: { _all: 1 } },
          { status: 'FAILED', _count: { _all: 1 } },
        ],
        count: () => 0,
        findMany: () => [{ id: 'n1' }],
      },
      deathVerificationCase: { findFirst: () => null },
      deadLetterJob: {
        findMany: () => [
          { id: 'd1', queueName: 'email-delivery', errorCode: 'rate_limited', failedAt: new Date('2026-10-01T00:01:00Z'), failureCount: 3, status: 'OPEN' },
        ],
      },
    });

  it('recorded facts and history only, newest first; safe error codes only', async () => {
    const { db, calls } = setup();
    const d = await new AdminReleasesService(db).detail(ID, 'admin-1', NOW);
    expect(d).toMatchObject({
      reference: ID,
      accountId: OWNER,
      status: 'RELEASED',
      assessment: 'released',
      liveRecipients: 2,
      release: { id: 'r1', accessGrants: 2 },
      releaseEmails: { pending: 0, retrying: 0, accepted: 1, failed: 1 },
      deathCase: null,
    });
    expect(d.history.map((h) => h.event)).toEqual(['schedule_changed', 'job_dead_lettered', 'released', 'schedule_saved']);
    const body = JSON.stringify(d);
    expect(body).not.toMatch(/title|textContent|privateNote|errorMessage|payload|email"|mobile|url/i);
    // The dead-letter query never selects the free-text message.
    const dl = calls.find((c) => c.table === 'deadLetterJob')!.args as { select: Record<string, boolean> };
    expect(dl.select.errorMessage).toBeUndefined();
  });

  it('unknown, draft or deleted → the same 404', async () => {
    const { db, calls } = setup(null);
    await expect(new AdminReleasesService(db).detail(ID, 'admin-1', NOW)).rejects.toThrow(
      new NotFoundException(RELEASE_NOT_FOUND),
    );
    expect(calls[0].args).toMatchObject({
      where: { id: ID, deletedAt: null, status: { in: ['SCHEDULED', 'RELEASED', 'CANCELLED'] } },
    });
  });
});

describe('ReleaseListQueryDto and guards', () => {
  const errors = async (body: object) =>
    (await validate(plainToInstance(ReleaseListQueryDto, body))).map((e) => e.property);

  it('allowlists every filter, sort and direction; bounded page size', async () => {
    expect(await errors({})).toEqual([]);
    expect(await errors({ status: 'DRAFT' })).toEqual(['status']);
    expect(await errors({ triggerType: 'SOON' })).toEqual(['triggerType']);
    expect(await errors({ reference: 'not-a-uuid' })).toEqual(['reference']);
    expect(await errors({ accountId: 'x' })).toEqual(['accountId']);
    expect(await errors({ scheduledFrom: 'yesterday' })).toEqual(['scheduledFrom']);
    expect(await errors({ pastDue: 'maybe' })).toEqual(['pastDue']);
    expect(await errors({ sort: 'title' })).toEqual(['sort']);
    expect(await errors({ dir: 'sideways' })).toEqual(['dir']);
    expect(await errors({ limit: '101' })).toEqual(['limit']);
  });

  it('needs an admin session with completed MFA', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminReleasesController)).toEqual([SessionAuthGuard, AdminGuard]);
  });
});

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminGuard } from '../auth/guards/admin.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminDeliveriesController } from './admin.controller.js';
import {
  AdminDeliveriesService,
  DELIVERY_NOT_FOUND,
  errorCategory,
  maskDestination,
  releaseEmailWhere,
  uncertainWhere,
} from './admin-deliveries.service.js';
import type { AdminQueuesService } from './admin-queues.service.js';
import { DeliveryListQueryDto } from './dto/admin.dto.js';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const T0 = new Date('2026-10-30T10:00:00.000Z');
const ID = '7d6f1d8e-3c55-4a3a-9f1e-2b9a8f0e4c11';
const MSG = '11111111-1111-4111-8111-111111111111';
// Forbidden keys, addresses and links (values such as category 'release_email' are fine).
// The fixture's real address (masked destinations like r***@g***.com are fine).
const PRIVATE = /https?:|ruth\.private|gmail\.com|"(email|emailNormalized|recipientEmailNormalized|mobile|recipientMobileNormalized|subject|body|html|text|token|tokenHash|url|payload|errorMessage|lastErrorCode)":/i;

// Reads only: any write (or a table not listed) fails the test.
const READS = new Set(['findMany', 'findFirst', 'findUnique', 'count']);
function fakePrisma(tables: Record<string, Record<string, (args: never) => unknown>>) {
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
              const fn = tables[table]?.[method];
              if (!READS.has(method) || !fn) throw new Error(`unexpected ${table}.${method}`);
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
const queues = (state: unknown = { state: 'delayed', attemptsMade: 2, maxAttempts: 5 }) => {
  const jobState = vi.fn(async (_name: string, _jobId: string) => state);
  return { svc: { jobState } as unknown as AdminQueuesService, jobState };
};
const q = (body: object) => plainToInstance(DeliveryListQueryDto, body);

const email = (over: Record<string, unknown> = {}) => ({
  id: ID,
  status: 'PENDING',
  attemptCount: 0,
  lastErrorCode: null,
  sentAt: null,
  failedAt: null,
  createdAt: T0,
  updatedAt: T0,
  occurrenceId: null,
  grant: { messageId: MSG, recipientId: 'rcp-1', recipientEmailNormalized: 'ruth.private@gmail.com' },
  ...over,
});

describe('errorCategory: only allowlisted categories ever leave the API', () => {
  it.each([
    [null, null],
    ['timeout', 'timeout'],
    ['rate_limit_exceeded', 'rate_limit_exceeded'],
    ['mailbox_not_found', 'mailbox_not_found'],
    ['forbidden_ErrorAccessDenied', 'forbidden'],
    ['SomeProviderErrorName: user@example.com', 'provider_error'],
    ['<script>', 'provider_error'],
  ])('%s → %s', (code, category) => expect(errorCategory(code)).toBe(category));
});

describe('maskDestination: masked on the server; short or malformed values reveal nothing extra', () => {
  it.each([
    ['ruth@gmail.com', 'r***@g***.com'],
    ['ruth.private@mail.example.co.uk', 'r***@m***.uk'],
    ['a@b.co', '*@*.co'],
    ['ab@cd.io', 'a***@c***.io'],
    ['élodie@exämple.fr', 'é***@e***.fr'],
    [null, null],
    ['', null],
    ['not-an-email', '***'],
    ['@gmail.com', '***'],
    ['ruth@localhost', '***'],
    ['ruth@gmail.c0m', '***'],
    ['ruth@gmail.', '***'],
  ])('%s → %s', (input, out) => expect(maskDestination(input)).toBe(out));
});

describe('AdminDeliveriesService: release emails list', () => {
  const setup = (rows: unknown[]) =>
    fakePrisma({ releaseNotification: { findMany: () => rows, count: () => rows.length } });

  it('maps stored fields to statuses: accepted is not delivered; a failed attempt is not a terminal failure', async () => {
    const { db } = setup([
      email(),
      email({ id: 'b', attemptCount: 2, lastErrorCode: 'rate_limit_exceeded' }),
      email({ id: 'c', attemptCount: 1, lastErrorCode: 'timeout' }),
      email({ id: 'd', status: 'SENT', attemptCount: 2, lastErrorCode: 'timeout', sentAt: T0 }),
      email({ id: 'e', status: 'FAILED', attemptCount: 5, lastErrorCode: 'forbidden_Blocked', failedAt: T0 }),
    ]);
    const res = await new AdminDeliveriesService(db, queues().svc).list(q({}), NOW);
    const items = res.items as { status: string; lastAttemptUncertain: boolean; errorCategory: string | null }[];
    expect(items.map((i) => [i.status, i.lastAttemptUncertain, i.errorCategory])).toEqual([
      ['queued', false, null],
      ['retrying', false, 'rate_limit_exceeded'],
      // A timeout may have reached the provider: uncertain, not a clean failure.
      ['retrying', true, 'timeout'],
      // Accepted later: the old timeout no longer makes it uncertain.
      ['provider_accepted', false, 'timeout'],
      ['failed', false, 'forbidden'],
    ]);
    expect(res.items[0]).toEqual({
      reference: ID,
      channel: 'EMAIL',
      releaseReference: MSG,
      recipientReference: 'rcp-1',
      destination: 'r***@g***.com',
      yearlyOccurrence: false,
      status: 'queued',
      lastAttemptUncertain: false,
      attemptCount: 0,
      errorCategory: null,
      acceptedAt: null,
      failedAt: null,
      createdAt: T0,
      updatedAt: T0,
    });
  });

  it('the full address is read only to mask it: never returned; no mobile, provider text or payload', async () => {
    const { db, calls } = setup([email()]);
    const res = await new AdminDeliveriesService(db, queues().svc).list(q({}), NOW);
    expect(JSON.stringify(calls[0].args)).not.toMatch(/recipientMobile|providerMessageId|errorMessage|title|text/);
    expect(JSON.stringify(res)).not.toContain('ruth.private');
    expect(JSON.stringify(res)).not.toContain('gmail.com');
  });

  it('filters compose from the shared definitions; stable order with an id tie-breaker', async () => {
    const { db, calls } = setup([]);
    await new AdminDeliveriesService(db, queues().svc).list(
      q({
        status: 'retrying',
        outcomeUncertain: 'true',
        errorCategory: 'provider_error',
        releaseReference: MSG,
        reference: ID,
        createdFrom: '2026-10-01T00:00:00Z',
        createdTo: '2026-10-31T00:00:00Z',
        sort: 'updatedAt',
        dir: 'asc',
        page: '2',
        limit: '10',
      }),
      NOW,
    );
    const args = calls[0].args as { where: { AND: unknown[] }; orderBy: unknown[]; skip: number; take: number };
    expect(args.where.AND).toContainEqual(releaseEmailWhere.retrying);
    expect(args.where.AND).toContainEqual(uncertainWhere);
    expect(args.where.AND).toContainEqual({ grant: { messageId: MSG } });
    expect(args.where.AND).toContainEqual({ id: ID });
    expect(JSON.stringify(args.where.AND)).toContain('notIn');
    expect(args.orderBy).toEqual([{ updatedAt: 'asc' }, { id: 'asc' }]);
    expect([args.skip, args.take]).toEqual([10, 10]);
  });

  it('rejects a status from another category and a reversed range (400)', async () => {
    const svc = new AdminDeliveriesService(setup([]).db, queues().svc);
    await expect(svc.list(q({ status: 'attempted' }), NOW)).rejects.toThrow(BadRequestException);
    await expect(
      svc.list(q({ createdFrom: '2026-11-01T00:00:00Z', createdTo: '2026-10-01T00:00:00Z' }), NOW),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('AdminDeliveriesService: safety notices list', () => {
  const kase = (over: Record<string, unknown> = {}) => ({
    id: ID,
    ownerUserId: MSG,
    status: 'PENDING_VERIFICATION',
    safetyNoticeAttemptCount: 0,
    safetyNoticeLastAttemptAt: null,
    safetyNoticeSentAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });

  it('maps the case fields; a closed case never sent is not a "failure"', async () => {
    const { db, calls } = fakePrisma({
      deathVerificationCase: {
        findMany: () => [
          kase(),
          kase({ id: 'b', safetyNoticeAttemptCount: 3, safetyNoticeLastAttemptAt: T0 }),
          kase({ id: 'c', status: 'SAFEGUARD_ACTIVE', safetyNoticeAttemptCount: 1, safetyNoticeSentAt: T0 }),
          kase({ id: 'd', status: 'CANCELLED', safetyNoticeAttemptCount: 2 }),
        ],
        count: () => 4,
      },
    });
    const res = await new AdminDeliveriesService(db, queues().svc).list(q({ category: 'safety_notice' }), NOW);
    expect(res.items.map((i) => i.status)).toEqual(['queued', 'attempted', 'provider_accepted', 'not_sent_case_closed']);
    expect(JSON.stringify(calls[0].args)).not.toMatch(/email|firstName|lastName|note|reporter/i);
  });

  it('release-only filters are 400 for safety notices', async () => {
    const { db } = fakePrisma({ deathVerificationCase: { findMany: () => [], count: () => 0 } });
    const svc = new AdminDeliveriesService(db, queues().svc);
    for (const f of [{ outcomeUncertain: 'true' }, { errorCategory: 'timeout' }, { releaseReference: MSG }, { status: 'retrying' }]) {
      await expect(svc.list(q({ category: 'safety_notice', ...f }), NOW)).rejects.toThrow(BadRequestException);
    }
  });
});

describe('AdminDeliveriesService: details', () => {
  const detailRow = (over: Record<string, unknown> = {}) => ({
    ...email({ attemptCount: 2, lastErrorCode: 'network_error' }),
    providerMessageId: null,
    occurrence: null,
    grant: { messageId: MSG, messageReleaseId: 'r1', recipientId: 'rcp-1', recipientEmailNormalized: 'ruth.private@gmail.com' },
    ...over,
  });
  const setup = (row: unknown) =>
    fakePrisma({
      releaseNotification: { findUnique: () => row },
      deadLetterJob: {
        findMany: () => [
          { id: 'd1', queueName: 'email-delivery', errorCode: 'network_error', failedAt: NOW, failureCount: 1, status: 'OPEN' },
        ],
      },
    });

  it('stored record plus optional queue state; retry history is what is stored, no more', async () => {
    const { svc, jobState } = queues();
    const d = await new AdminDeliveriesService(setup(detailRow()).db, svc).releaseEmail(ID, 'admin', NOW);
    expect(jobState).toHaveBeenCalledWith('email-delivery', `release-notification-${ID}`);
    expect(d).toMatchObject({
      status: 'retrying',
      lastAttemptUncertain: true,
      attemptCount: 2,
      errorCategory: 'network_error',
      releaseReference: MSG,
      queueJob: { state: 'delayed', attemptsMade: 2, maxAttempts: 5 },
    });
    expect(d.history.map((h) => h.event)).toEqual(['dead_lettered', 'intent_created']);
    expect(JSON.stringify(d)).not.toMatch(PRIVATE);
  });

  it('Redis down: the stored record stays; queue state is null (unavailable), never invented', async () => {
    const d = await new AdminDeliveriesService(setup(detailRow()).db, queues(null).svc).releaseEmail(ID, 'admin', NOW);
    expect(d.queueJob).toBeNull();
    expect(d.attemptCount).toBe(2);
  });

  it('an accepted email: provider id shown as such, no queue lookup', async () => {
    const { svc, jobState } = queues();
    const d = await new AdminDeliveriesService(
      setup(detailRow({ status: 'SENT', sentAt: NOW, providerMessageId: 'provider-1' })).db,
      svc,
    ).releaseEmail(ID, 'admin', NOW);
    expect(jobState).not.toHaveBeenCalled();
    expect(d).toMatchObject({ status: 'provider_accepted', providerMessageId: 'provider-1', lastAttemptUncertain: false });
    expect(d.queueJob).toBeUndefined();
  });

  it('unknown reference → 404 for both kinds', async () => {
    const svc = new AdminDeliveriesService(
      fakePrisma({ releaseNotification: { findUnique: () => null }, deathVerificationCase: { findUnique: () => null } }).db,
      queues().svc,
    );
    await expect(svc.releaseEmail(ID, 'admin', NOW)).rejects.toThrow(new NotFoundException(DELIVERY_NOT_FOUND));
    await expect(svc.safetyNotice(ID, 'admin', NOW)).rejects.toThrow(new NotFoundException(DELIVERY_NOT_FOUND));
  });

  it('safety notice: case fields and its SAFETY_NOTICE_SENT events only', async () => {
    const { db, calls } = fakePrisma({
      deathVerificationCase: {
        findUnique: () => ({
          id: ID,
          ownerUserId: MSG,
          status: 'SAFEGUARD_ACTIVE',
          safetyNoticeAttemptCount: 2,
          safetyNoticeLastAttemptAt: T0,
          safetyNoticeSentAt: NOW,
          openedAt: new Date('2026-10-30T09:00:00.000Z'),
          createdAt: T0,
          updatedAt: NOW,
          auditEvents: [{ id: 'e1', createdAt: NOW }],
        }),
      },
    });
    const d = await new AdminDeliveriesService(db, queues().svc).safetyNotice(ID, 'admin', NOW);
    expect(d).toMatchObject({ status: 'provider_accepted', attemptCount: 2, caseEvents: [{ id: 'e1' }] });
    expect(d.history.map((h) => h.event)).toEqual(['provider_accepted', 'last_attempt_started', 'case_opened']);
    expect(JSON.stringify(calls[0].args)).toContain('SAFETY_NOTICE_SENT');
    expect(JSON.stringify(d)).not.toMatch(PRIVATE);
  });
});

describe('DeliveryListQueryDto and guards', () => {
  const errors = async (body: object) => (await validate(q(body))).map((e) => e.property);

  it('allowlisted filters; bounded pages; default category', async () => {
    expect(q({}).category).toBe('release_email');
    expect(await errors({})).toEqual([]);
    expect(await errors({ category: 'sms' })).toEqual(['category']);
    expect(await errors({ status: 'DROP TABLE' })).toEqual(['status']);
    expect(await errors({ errorCategory: 'raw' })).toEqual(['errorCategory']);
    expect(await errors({ reference: 'x' })).toEqual(['reference']);
    expect(await errors({ releaseReference: 'x' })).toEqual(['releaseReference']);
    expect(await errors({ createdFrom: 'today' })).toEqual(['createdFrom']);
    expect(await errors({ outcomeUncertain: 'maybe' })).toEqual(['outcomeUncertain']);
    expect(await errors({ sort: 'lastErrorCode' })).toEqual(['sort']);
    expect(await errors({ limit: '500' })).toEqual(['limit']);
  });

  it('needs an admin session with completed MFA', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminDeliveriesController)).toEqual([SessionAuthGuard, AdminGuard]);
  });
});

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  DeathVerificationCaseStatus,
  MessageStatus,
  Prisma,
  ReleaseNotificationStatus,
  ReleaseTriggerType as T,
} from '../generated/prisma/client.js';
import { paginate } from '../audit/audit-log.service.js';
import { releaseDueAt } from '../message-release/message-release.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReleaseListQueryDto } from './dto/admin.dto.js';

/**
 * Admin release monitoring (docs/admin.md §16): read-only operational
 * metadata about scheduled and released Messages. Never a title, text,
 * file, note, recipient detail, payload or provider error: ids, states,
 * trigger types, counts and timestamps only. Nothing here queues, releases,
 * sends or changes anything, and it needs no Redis.
 */

const LISTED = [MessageStatus.SCHEDULED, MessageStatus.RELEASED, MessageStatus.CANCELLED];
const DEATH = new Set<T>([T.ON_DEATH, T.AFTER_DEATH]);
const RECURRING = new Set<T>([T.BIRTHDAY, T.ANNIVERSARY, T.ANNUAL_AFTER_DEATH]);
const OPEN_CASE: DeathVerificationCaseStatus[] = [
  DeathVerificationCaseStatus.PENDING_VERIFICATION,
  DeathVerificationCaseStatus.SAFEGUARD_ACTIVE,
  DeathVerificationCaseStatus.READY_FOR_REVIEW,
];

/**
 * "Past due, not yet released": the release reconciler's own due rules with
 * the horizon at `now`, for live SCHEDULED Messages. Shared by the Overview
 * count and the Releases filter so both count the same Messages. Includes
 * releases the worker refused (for example no live recipients); it is not a
 * claim that the worker is late.
 */
export const pastDueWhere = (now: Date): Prisma.MessageWhereInput => ({
  status: MessageStatus.SCHEDULED,
  deletedAt: null,
  OR: [
    {
      schedule: {
        OR: [
          { triggerType: { in: [T.FIXED_DATE, T.CUSTOM_EVENT] }, scheduledFor: { lte: now } },
          { triggerType: T.NOW },
        ],
      },
    },
    { recipientReleases: { some: { releasedAt: null, dueAt: { lte: now } } } },
    {
      deathActivation: {
        triggerType: { in: [T.ON_DEATH, T.AFTER_DEATH] },
        dueAt: { lte: now },
        deathVerificationCase: { status: DeathVerificationCaseStatus.VERIFIED },
      },
    },
  ],
});

/**
 * Current assessment, evaluated at `now` (display only: the worker re-checks
 * everything in its own transaction before releasing). Mapping, docs/admin.md §16.
 */
export type ReleaseAssessment =
  | 'released'
  | 'cancelled'
  | 'past_due'
  | 'scheduled'
  | 'recurring'
  | 'awaiting_death_verification'
  | 'no_schedule';

type AssessInput = {
  status: MessageStatus;
  schedule: { triggerType: T; scheduledFor: Date | null; afterDeathDays: number | null; createdAt: Date } | null;
  deathActivation: {
    triggerType: T;
    dueAt: Date;
    deathVerificationCase: { status: DeathVerificationCaseStatus };
  } | null;
  pastDueOccurrences: number;
};

export function assessRelease(m: AssessInput, now: Date): ReleaseAssessment {
  if (m.status === MessageStatus.RELEASED) return 'released';
  if (m.status === MessageStatus.CANCELLED) return 'cancelled';
  const s = m.schedule;
  if (!s) return 'no_schedule';
  // Same predicates as pastDueWhere.
  const a = m.deathActivation;
  const pastDue =
    ((s.triggerType === T.FIXED_DATE || s.triggerType === T.CUSTOM_EVENT) &&
      !!s.scheduledFor &&
      s.scheduledFor <= now) ||
    s.triggerType === T.NOW ||
    m.pastDueOccurrences > 0 ||
    (!!a &&
      DEATH.has(a.triggerType) &&
      a.dueAt <= now &&
      a.deathVerificationCase.status === DeathVerificationCaseStatus.VERIFIED);
  if (pastDue) return 'past_due';
  if (RECURRING.has(s.triggerType)) {
    return s.triggerType === T.ANNUAL_AFTER_DEATH && !a ? 'awaiting_death_verification' : 'recurring';
  }
  if (DEATH.has(s.triggerType) && !releaseDueAt(s, a)) return 'awaiting_death_verification';
  return 'scheduled';
}

const SORT = {
  updatedAt: (dir: Prisma.SortOrder) => [{ updatedAt: dir }],
  createdAt: (dir: Prisma.SortOrder) => [{ createdAt: dir }],
  scheduledFor: (dir: Prisma.SortOrder) => [{ schedule: { scheduledFor: { sort: dir, nulls: 'last' as const } } }],
} satisfies Record<string, (dir: Prisma.SortOrder) => Prisma.MessageOrderByWithRelationInput[]>;
export const RELEASE_SORTS = Object.keys(SORT) as (keyof typeof SORT)[];

export const RELEASE_NOT_FOUND = 'Release not found.';

@Injectable()
export class AdminReleasesService {
  private readonly logger = new Logger(AdminReleasesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(q: ReleaseListQueryDto, now = new Date()) {
    if (q.scheduledFrom && q.scheduledTo && new Date(q.scheduledFrom) > new Date(q.scheduledTo)) {
      throw new BadRequestException('scheduledFrom must be before scheduledTo');
    }
    const where: Prisma.MessageWhereInput = {
      AND: [
        { deletedAt: null, status: q.status ?? { in: LISTED } },
        q.pastDue ? pastDueWhere(now) : {},
        q.reference ? { id: q.reference } : {},
        q.accountId ? { ownerUserId: q.accountId } : {},
        q.triggerType ? { schedule: { triggerType: q.triggerType } } : {},
        q.scheduledFrom || q.scheduledTo
          ? {
              schedule: {
                scheduledFor: {
                  ...(q.scheduledFrom && { gte: new Date(q.scheduledFrom) }),
                  ...(q.scheduledTo && { lte: new Date(q.scheduledTo) }),
                },
              },
            }
          : {},
      ],
    };
    const sort = q.sort ?? 'updatedAt';
    const dir = q.dir ?? 'desc';
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.message.findMany({
        where,
        // Unique tie-breaker: equal timestamps never reorder between pages.
        orderBy: [...SORT[sort](dir), { id: dir }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: {
          id: true,
          ownerUserId: true,
          status: true,
          updatedAt: true,
          schedule: {
            select: { triggerType: true, scheduledFor: true, afterDeathDays: true, createdAt: true, updatedAt: true },
          },
          release: { select: { triggerType: true, scheduledFor: true, releasedAt: true } },
          deathActivation: {
            select: {
              triggerType: true,
              dueAt: true,
              activatedAt: true,
              deathVerificationCase: { select: { status: true } },
            },
          },
          _count: { select: { recipientReleases: { where: { releasedAt: null, dueAt: { lte: now } } } } },
        },
      }),
      this.prisma.message.count({ where }),
    ]);
    // One bounded query for the page's owners (no N+1): their newest open case.
    const owners = [...new Set(rows.map((r) => r.ownerUserId))];
    const cases = owners.length
      ? await this.prisma.deathVerificationCase.findMany({
          where: { ownerUserId: { in: owners }, status: { in: OPEN_CASE } },
          orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
          select: { ownerUserId: true, status: true, safeguardEndsAt: true },
        })
      : [];
    const openCase = new Map<string, (typeof cases)[number]>();
    for (const c of cases) if (!openCase.has(c.ownerUserId)) openCase.set(c.ownerUserId, c);

    return {
      evaluatedAt: now.toISOString(),
      items: rows.map((r) => {
        const assessment = assessRelease(
          { ...r, pastDueOccurrences: r._count.recipientReleases },
          now,
        );
        const waiting = assessment === 'awaiting_death_verification' ? openCase.get(r.ownerUserId) : undefined;
        return {
          reference: r.id,
          accountId: r.ownerUserId,
          status: r.status,
          triggerType: r.schedule?.triggerType ?? r.release?.triggerType ?? null,
          scheduledFor: r.schedule?.scheduledFor ?? r.release?.scheduledFor ?? null,
          releasedAt: r.release?.releasedAt ?? null,
          assessment,
          // Only while the release is waiting for a death to be verified.
          deathCaseStatus: waiting?.status ?? null,
          safeguardEndsAt: waiting?.safeguardEndsAt ?? null,
          lastRecordedAt: latest(r.schedule?.updatedAt, r.release?.releasedAt, r.deathActivation?.activatedAt),
        };
      }),
      pagination: paginate(q.page, q.limit, total),
    };
  }

  /** One Message's release metadata and recorded history. Logged, not audited (docs/admin.md §16). */
  async detail(reference: string, adminId: string, now = new Date()) {
    const m = await this.prisma.message.findFirst({
      where: { id: reference, deletedAt: null, status: { in: LISTED } },
      select: {
        id: true,
        ownerUserId: true,
        status: true,
        schedule: {
          select: { triggerType: true, scheduledFor: true, afterDeathDays: true, createdAt: true, updatedAt: true },
        },
        release: {
          select: {
            id: true,
            triggerType: true,
            scheduledFor: true,
            releasedAt: true,
            _count: { select: { accessGrants: true } },
          },
        },
        deathActivation: {
          select: {
            id: true,
            triggerType: true,
            activatedAt: true,
            dueAt: true,
            deathVerificationCaseId: true,
            deathVerificationCase: { select: { status: true } },
          },
        },
        _count: { select: { recipients: { where: { recipient: { deletedAt: null } } } } },
      },
    });
    if (!m) throw new NotFoundException(RELEASE_NOT_FOUND);

    const occurrence = { messageId: m.id };
    const [occReleased, occPending, occPastDue, nextOcc, recentOcc, notifications, retrying, deathCase] =
      await Promise.all([
        this.prisma.messageRecipientRelease.count({ where: { ...occurrence, releasedAt: { not: null } } }),
        this.prisma.messageRecipientRelease.count({ where: { ...occurrence, releasedAt: null } }),
        this.prisma.messageRecipientRelease.count({ where: { ...occurrence, releasedAt: null, dueAt: { lte: now } } }),
        this.prisma.messageRecipientRelease.findFirst({
          where: { ...occurrence, releasedAt: null },
          orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
          select: { dueAt: true },
        }),
        this.prisma.messageRecipientRelease.findMany({
          where: { ...occurrence, releasedAt: { not: null } },
          orderBy: [{ releasedAt: 'desc' }, { id: 'desc' }],
          take: 10,
          select: { id: true, releasedAt: true },
        }),
        this.prisma.releaseNotification.groupBy({
          by: ['status'],
          where: { grant: { messageId: m.id } },
          _count: { _all: true },
        }),
        this.prisma.releaseNotification.count({
          where: { grant: { messageId: m.id }, status: ReleaseNotificationStatus.PENDING, attemptCount: { gt: 0 } },
        }),
        // The owner's newest case: the one a death trigger waits on.
        m.schedule && (DEATH.has(m.schedule.triggerType) || m.schedule.triggerType === T.ANNUAL_AFTER_DEATH)
          ? this.prisma.deathVerificationCase.findFirst({
              where: { ownerUserId: m.ownerUserId },
              orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
              select: { id: true, status: true, openedAt: true, safeguardEndsAt: true, verifiedAt: true },
            })
          : null,
      ]);

    // Dead letters for this Message's own jobs (release, occurrences, emails). Bounded.
    const [occIds, notificationIds] = await Promise.all([
      this.prisma.messageRecipientRelease.findMany({ where: occurrence, select: { id: true }, take: 500 }),
      this.prisma.releaseNotification.findMany({ where: { grant: { messageId: m.id } }, select: { id: true }, take: 500 }),
    ]);
    const deadLetters = await this.prisma.deadLetterJob.findMany({
      where: {
        OR: [
          { entityType: 'Message', entityId: m.id },
          { entityType: 'MessageRecipientRelease', entityId: { in: occIds.map((o) => o.id) } },
          { entityType: 'ReleaseNotification', entityId: { in: notificationIds.map((n) => n.id) } },
        ],
      },
      orderBy: [{ failedAt: 'desc' }, { id: 'desc' }],
      take: 20,
      // A safe category code only: never errorMessage, payload or provider text.
      select: { id: true, queueName: true, errorCode: true, failedAt: true, failureCount: true, status: true },
    });

    const byStatus = (s: ReleaseNotificationStatus) =>
      notifications.find((n) => n.status === s)?._count._all ?? 0;
    const history = [
      m.schedule && { at: m.schedule.createdAt, event: 'schedule_saved' as const },
      m.schedule && m.schedule.updatedAt > m.schedule.createdAt && { at: m.schedule.updatedAt, event: 'schedule_changed' as const },
      m.deathActivation && { at: m.deathActivation.activatedAt, event: 'death_trigger_activated' as const },
      m.release && { at: m.release.releasedAt, event: 'released' as const },
      ...recentOcc.map((o) => ({ at: o.releasedAt!, event: 'occurrence_released' as const })),
      ...deadLetters.map((d) => ({ at: d.failedAt, event: 'job_dead_lettered' as const })),
    ]
      .filter((e): e is { at: Date; event: HistoryEvent } => !!e)
      .sort((a, b) => b.at.getTime() - a.at.getTime());

    this.logger.log(`admin_release_viewed message ${m.id} admin ${adminId}`);
    return {
      evaluatedAt: now.toISOString(),
      reference: m.id,
      accountId: m.ownerUserId,
      status: m.status,
      assessment: assessRelease({ ...m, pastDueOccurrences: occPastDue }, now),
      liveRecipients: m._count.recipients,
      schedule: m.schedule && {
        triggerType: m.schedule.triggerType,
        scheduledFor: m.schedule.scheduledFor,
        afterDeathDays: m.schedule.afterDeathDays,
        createdAt: m.schedule.createdAt,
        updatedAt: m.schedule.updatedAt,
      },
      release: m.release && {
        id: m.release.id,
        triggerType: m.release.triggerType,
        scheduledFor: m.release.scheduledFor,
        releasedAt: m.release.releasedAt,
        accessGrants: m.release._count.accessGrants,
      },
      deathActivation: m.deathActivation && {
        id: m.deathActivation.id,
        triggerType: m.deathActivation.triggerType,
        activatedAt: m.deathActivation.activatedAt,
        dueAt: m.deathActivation.dueAt,
        deathVerificationCaseId: m.deathActivation.deathVerificationCaseId,
      },
      deathCase,
      occurrences: { released: occReleased, pending: occPending, pastDue: occPastDue, nextDueAt: nextOcc?.dueAt ?? null },
      releaseEmails: {
        pending: byStatus(ReleaseNotificationStatus.PENDING),
        retrying,
        accepted: byStatus(ReleaseNotificationStatus.SENT),
        failed: byStatus(ReleaseNotificationStatus.FAILED),
      },
      deadLetters,
      history,
    };
  }
}

type HistoryEvent =
  | 'schedule_saved'
  | 'schedule_changed'
  | 'death_trigger_activated'
  | 'released'
  | 'occurrence_released'
  | 'job_dead_lettered';

const latest = (...dates: (Date | null | undefined)[]) =>
  dates.reduce<Date | null>((max, d) => (d && (!max || d > max) ? d : max), null);

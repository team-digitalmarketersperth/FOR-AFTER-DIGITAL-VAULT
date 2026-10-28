import { Controller, Get, Injectable, Module, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { MessageStatus, ReleaseTriggerType as T } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersModule } from '../users/users.module.js';
import type { SafeUser } from '../users/users.service.js';

/** Something with a real time: due now (dueAt null, NOW) or at a stored instant. */
export type UpcomingDelivery = {
  key: string;
  messageId: string;
  title: string;
  triggerType: T;
  /** The stored UTC instant; null only for NOW (released as soon as possible). */
  dueAt: Date | null;
  /** The schedule's own IANA zone (recurring/event triggers); null = viewer's zone. */
  timezone: string | null;
  eventLabel: string | null;
  /** First names of the live Recipients this delivery goes to. */
  recipients: string[];
  repeatsAnnually: boolean;
};

/** Waits for a verified death: no calendar date exists yet, so none is given. */
export type ConditionalDelivery = {
  key: string;
  messageId: string;
  title: string;
  triggerType: T;
  afterDeathDays: number | null;
  recipients: string[];
};

export type RecentDelivery = { key: string; messageId: string; title: string; deliveredAt: Date; recipients: string[] };

export type DeliveryTimeline = {
  upcoming: UpcomingDelivery[];
  conditional: ConditionalDelivery[];
  recent: RecentDelivery[];
};

const RECENT_DAYS = 30;
const RECENT_MAX = 5;
const DEATH = new Set<T>([T.ON_DEATH, T.AFTER_DEATH, T.ANNUAL_AFTER_DEATH]);
const ANNUAL = new Set<T>([T.BIRTHDAY, T.ANNIVERSARY, T.ANNUAL_AFTER_DEATH]);
const CONDITIONAL_ORDER: T[] = [T.ON_DEATH, T.AFTER_DEATH, T.ANNUAL_AFTER_DEATH];

/**
 * "When will the people I love receive what I've prepared?" Read-only and
 * derived from the scheduling engine's own rows, never recomputed:
 *  - FIXED_DATE / CUSTOM_EVENT: the stored scheduledFor instant;
 *  - BIRTHDAY / ANNIVERSARY (and ANNUAL_AFTER_DEATH once a death is verified):
 *    the pending per-Recipient occurrences the engine materialises, which are
 *    only ever the next one each, so recurrence can never run away;
 *  - ON_DEATH / AFTER_DEATH: the activation's dueAt after a verified death,
 *    otherwise conditional (no fake date);
 *  - NOW: due now until the worker releases it.
 * Titles and first names only: never content, contact details, notes or ids
 * other than the Message's own.
 */
@Injectable()
export class DeliveryTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async getForUser(ownerUserId: string, now = new Date()): Promise<DeliveryTimeline> {
    const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);
    const live = { recipient: { deletedAt: null } };
    const messages = await this.prisma.message.findMany({
      where: { ownerUserId, deletedAt: null, status: { in: [MessageStatus.SCHEDULED, MessageStatus.RELEASED] } },
      select: {
        id: true,
        title: true,
        status: true,
        schedule: { select: { triggerType: true, scheduledFor: true, afterDeathDays: true, timezone: true, eventLabel: true } },
        // Assigned together = same createdAt, so first name breaks the tie (stable order).
        recipients: {
          where: live,
          orderBy: [{ createdAt: 'asc' }, { recipient: { firstName: 'asc' } }],
          select: { recipient: { select: { firstName: true } } },
        },
        release: { select: { releasedAt: true } },
        deathActivation: { select: { dueAt: true } },
        recipientReleases: {
          where: { ...live, OR: [{ releasedAt: null }, { releasedAt: { gte: since } }] },
          orderBy: { dueAt: 'asc' },
          select: { id: true, dueAt: true, releasedAt: true, recipient: { select: { firstName: true } } },
        },
      },
    });

    const upcoming: UpcomingDelivery[] = [];
    const conditional: ConditionalDelivery[] = [];
    const recent: RecentDelivery[] = [];
    for (const m of messages) {
      const names = m.recipients.map((r) => r.recipient.firstName);
      const base = { messageId: m.id, title: m.title };
      if (m.status === MessageStatus.RELEASED) {
        if (m.release && m.release.releasedAt >= since) {
          recent.push({ key: `${m.id}:released`, ...base, deliveredAt: m.release.releasedAt, recipients: names });
        }
        continue;
      }
      const s = m.schedule;
      if (!s) continue;
      const dated = (key: string, dueAt: Date | null, recipients: string[]) =>
        upcoming.push({
          key,
          ...base,
          triggerType: s.triggerType,
          dueAt,
          timezone: s.timezone,
          eventLabel: s.eventLabel,
          recipients,
          repeatsAnnually: ANNUAL.has(s.triggerType),
        });
      // Per-Recipient occurrences: one row per person, never merged.
      const pending = m.recipientReleases.filter((o) => !o.releasedAt);
      for (const o of pending) dated(`${m.id}:${o.id}`, o.dueAt, [o.recipient.firstName]);
      for (const o of m.recipientReleases) {
        if (o.releasedAt) {
          recent.push({ key: `${m.id}:${o.id}`, ...base, deliveredAt: o.releasedAt, recipients: [o.recipient.firstName] });
        }
      }
      if (s.triggerType === T.NOW) dated(`${m.id}:now`, null, names);
      else if (s.triggerType === T.FIXED_DATE || s.triggerType === T.CUSTOM_EVENT) dated(`${m.id}:at`, s.scheduledFor, names);
      else if (DEATH.has(s.triggerType)) {
        // After a verified death: ON_DEATH/AFTER_DEATH have the activation's
        // dueAt; ANNUAL_AFTER_DEATH has its occurrences (dated above). Before:
        // conditional, with no date at all.
        const activated = s.triggerType === T.ANNUAL_AFTER_DEATH ? pending.length > 0 : !!m.deathActivation;
        if (!activated) {
          conditional.push({
            key: `${m.id}:conditional`,
            ...base,
            triggerType: s.triggerType,
            afterDeathDays: s.afterDeathDays,
            recipients: names,
          });
        } else if (m.deathActivation && s.triggerType !== T.ANNUAL_AFTER_DEATH) {
          dated(`${m.id}:due`, m.deathActivation.dueAt, names);
        }
      }
    }

    // NOW first, then ascending by the real instant (id breaks ties stably).
    upcoming.sort(
      (a, b) =>
        (a.dueAt?.getTime() ?? -Infinity) - (b.dueAt?.getTime() ?? -Infinity) || a.key.localeCompare(b.key),
    );
    conditional.sort(
      (a, b) =>
        CONDITIONAL_ORDER.indexOf(a.triggerType) - CONDITIONAL_ORDER.indexOf(b.triggerType) ||
        (a.afterDeathDays ?? 0) - (b.afterDeathDays ?? 0) ||
        a.title.localeCompare(b.title),
    );
    recent.sort((a, b) => b.deliveredAt.getTime() - a.deliveredAt.getTime());
    return { upcoming, conditional, recent: recent.slice(0, RECENT_MAX) };
  }
}

// The signed-in Customer's own delivery plan; never anyone else's.
@ApiTags('Users')
@ApiCookieAuth(AUTH.customer)
@Controller('users/me/delivery-timeline')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class DeliveryTimelineController {
  constructor(private readonly timeline: DeliveryTimelineService) {}

  @Get()
  get(@CurrentUser() user: SafeUser): Promise<DeliveryTimeline> {
    return this.timeline.getForUser(user.id);
  }
}

// UsersModule backs SessionAuthGuard.
@Module({
  imports: [UsersModule],
  controllers: [DeliveryTimelineController],
  providers: [DeliveryTimelineService],
})
export class DeliveryTimelineModule {}

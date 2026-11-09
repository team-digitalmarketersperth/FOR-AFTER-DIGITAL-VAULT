import { Controller, Get, Injectable, Module, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { MessageStatus, ReleaseTriggerType } from '../generated/prisma/client.js';
import { MediaModule } from '../media/media.module.js';
import { StorageQuota } from '../media/storage-quota.service.js';
import { MISSING_BIRTHDAY_RECIPIENT } from '../message-schedules/message-schedules.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NEEDS_TIMING } from '../readiness/readiness.service.js';
import {
  latestInvitation,
  type TrustedContactReadiness,
  trustedContactReadiness,
} from '../trusted-contacts/trusted-contact-invitations.service.js';
import { UsersModule } from '../users/users.module.js';
import type { SafeUser } from '../users/users.service.js';

export type AttentionPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export type AttentionCategory = 'TRUSTED_CONTACTS' | 'MESSAGES' | 'PEOPLE' | 'STORAGE';

export type AttentionItem = {
  key: string;
  category: AttentionCategory;
  priority: AttentionPriority;
  title: string;
  description: string | null;
  actionLabel: string;
  /** A frontend route chosen here, never taken from the request. */
  actionHref: string;
};

export type Attention = { items: AttentionItem[]; total: number };

const PRIORITY: AttentionPriority[] = ['HIGH', 'MEDIUM', 'LOW'];
const CATEGORY: AttentionCategory[] = ['TRUSTED_CONTACTS', 'MESSAGES', 'PEOPLE', 'STORAGE'];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

type ContactState = NonNullable<TrustedContactReadiness['reason']> | TrustedContactReadiness['status'];

// Per contact (a Customer has at most two). Wording matches the Trusted Contacts page.
const CONTACT: Partial<
  Record<ContactState, { one: (name: string) => string; many?: (n: number) => string; action: string }>
> = {
  INVITATION_PENDING: {
    one: (name) => `${name} hasn’t accepted the invitation yet`,
    many: (n) => `${n} Trusted Contact invitations are pending`,
    action: 'Review contacts',
  },
  INVITATION_EXPIRED: {
    one: (name) => `${name}’s invitation has expired`,
    many: (n) => `${n} Trusted Contact invitations have expired`,
    action: 'Send a new invitation',
  },
  DECLINED: { one: (name) => `${name} declined the invitation`, action: 'Review contacts' },
  NOT_SENT: { one: (name) => `${name} hasn’t been invited yet`, action: 'Send invitation' },
};

/**
 * "What should I take care of next?" Derived on every request from the
 * Customer's own rows (counts and small selects; never content, notes, emails,
 * invitation tokens or anything about death verification). Each rule belongs
 * to its own domain and is reused, not redefined: messages needing timing
 * (readiness), Trusted Contact readiness, the BIRTHDAY scheduling rule and the
 * storage quota levels. Nothing is stored, so an item disappears as soon as
 * the underlying state is fixed. Overall progress stays with readiness.
 */
@Injectable()
export class AttentionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: StorageQuota,
  ) {}

  async getForUser(ownerUserId: string): Promise<Attention> {
    const [needsTiming, contacts, missingBirthdays, storage] = await Promise.all([
      this.prisma.message.count({ where: { ownerUserId, deletedAt: null, status: NEEDS_TIMING } }),
      this.prisma.trustedContact.findMany({
        where: { ownerUserId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true, firstName: true, email: true, mobile: true, invitations: latestInvitation },
      }),
      // A birthday cleared while a BIRTHDAY message is scheduled: this year's
      // pending release stands, but no later year can be placed.
      this.prisma.messageRecipient.findMany({
        where: {
          message: {
            ownerUserId,
            deletedAt: null,
            status: MessageStatus.SCHEDULED,
            schedule: { triggerType: ReleaseTriggerType.BIRTHDAY },
          },
          recipient: { ownerUserId, ...MISSING_BIRTHDAY_RECIPIENT },
        },
        select: { recipientId: true, recipient: { select: { firstName: true } } },
      }),
      this.quota.usage(ownerUserId),
    ]);

    const items: AttentionItem[] = [];

    const byState = new Map<ContactState, { id: string; firstName: string }[]>();
    for (const c of contacts) {
      const r = trustedContactReadiness(c, c.invitations[0]);
      if (r.status === 'READY') continue;
      const state = r.reason ?? r.status;
      byState.set(state, [...(byState.get(state) ?? []), c]);
    }
    for (const [state, list] of byState) {
      const copy = CONTACT[state];
      if (!copy) continue;
      const single = list.length === 1 || !copy.many;
      for (const c of single ? list : [list[0]]) {
        items.push({
          key: single ? `TRUSTED_CONTACT:${c.id}` : `TRUSTED_CONTACTS:${state}`,
          category: 'TRUSTED_CONTACTS',
          priority: 'MEDIUM',
          title: single ? copy.one(c.firstName) : copy.many!(list.length),
          description: null,
          actionLabel: copy.action,
          actionHref: '/trusted-contacts',
        });
      }
    }

    if (needsTiming) {
      items.push({
        key: 'MESSAGES_NEED_TIMING',
        category: 'MESSAGES',
        priority: 'MEDIUM',
        title: `${plural(needsTiming, 'message needs', 'messages need')} timing`,
        description: null,
        actionLabel: 'Review messages',
        actionHref: '/messages',
      });
    }

    // One item per Recipient, however many birthday messages they are on.
    const people = new Map<string, { firstName: string; messages: number }>();
    for (const m of missingBirthdays) {
      const p = people.get(m.recipientId) ?? { firstName: m.recipient.firstName, messages: 0 };
      people.set(m.recipientId, { ...p, messages: p.messages + 1 });
    }
    for (const [id, p] of people) {
      items.push({
        key: `RECIPIENT_BIRTHDAY_MISSING:${id}`,
        category: 'PEOPLE',
        priority: 'MEDIUM',
        title: `${p.firstName} is missing a birthday`,
        description: `Needed for ${plural(p.messages, 'scheduled birthday message', 'scheduled birthday messages')}.`,
        actionLabel: 'Add birthday',
        actionHref: `/people/${id}/edit`,
      });
    }

    if (storage.level !== 'NORMAL') {
      items.push({
        key: 'STORAGE',
        category: 'STORAGE',
        priority: storage.level === 'WARNING' ? 'LOW' : 'HIGH',
        title: storage.level === 'FULL' ? 'Storage is full' : `Storage is ${storage.percentage}% full`,
        description: 'Free up space to keep adding photos, recordings and videos.',
        actionLabel: 'Manage storage',
        actionHref: '/settings/storage',
      });
    }

    // Stable: priority, then category; ties keep their insertion order.
    items.sort(
      (a, b) =>
        PRIORITY.indexOf(a.priority) - PRIORITY.indexOf(b.priority) ||
        CATEGORY.indexOf(a.category) - CATEGORY.indexOf(b.category),
    );
    return { items, total: items.length };
  }
}

// The signed-in Customer's own items; never anyone else's.
@ApiTags('Users')
@ApiCookieAuth(AUTH.customer)
@Controller('users/me/attention')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class AttentionController {
  constructor(private readonly attention: AttentionService) {}

  @Get()
  get(@CurrentUser() user: SafeUser): Promise<Attention> {
    return this.attention.getForUser(user.id);
  }
}

// UsersModule backs SessionAuthGuard; MediaModule provides the storage quota.
@Module({
  imports: [UsersModule, MediaModule],
  controllers: [AttentionController],
  providers: [AttentionService],
})
export class AttentionModule {}

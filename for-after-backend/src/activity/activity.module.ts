import { Controller, Get, Injectable, Module, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { PageQueryDto } from '../admin/dto/admin.dto.js';
import { paginate } from '../audit/audit-log.service.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { AUTH } from '../config/swagger.js';
import { CustomerActivityType as T } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsersModule } from '../users/users.module.js';
import type { SafeUser } from '../users/users.service.js';

export type ActivityItem = {
  id: string;
  type: T;
  createdAt: Date;
  /** Id (or prompt key) to link to, only while the item still exists; else null. */
  target: string | null;
};

// Which live table each linkable event points at. Profile/email events link
// to settings (no target needed); removals never link.
const LINKS: Partial<Record<T, 'message' | 'recipient' | 'trustedContact' | 'memory' | 'story' | 'wish'>> = {
  PERSON_ADDED: 'recipient',
  PERSON_UPDATED: 'recipient',
  TRUSTED_CONTACT_ADDED: 'trustedContact',
  TRUSTED_CONTACT_UPDATED: 'trustedContact',
  MESSAGE_CREATED: 'message',
  MESSAGE_UPDATED: 'message',
  MESSAGE_SCHEDULED: 'message',
  MESSAGE_RESCHEDULED: 'message',
  MESSAGE_UNSCHEDULED: 'message',
  MEMORY_ADDED: 'memory',
  MEMORY_UPDATED: 'memory',
  STORY_RESPONSE_ADDED: 'story',
  STORY_RESPONSE_UPDATED: 'story',
  WISH_RESPONSE_ADDED: 'wish',
  WISH_RESPONSE_UPDATED: 'wish',
};

/** The signed-in Customer's own history, newest first. Ids and types only. */
@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, page: number, limit: number) {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.customerActivity.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: { id: true, type: true, entityId: true, createdAt: true },
      }),
      this.prisma.customerActivity.count({ where: { userId } }),
    ]);
    const live = await this.liveTargets(userId, rows);
    const items: ActivityItem[] = rows.map(({ entityId, ...r }) => {
      const table = LINKS[r.type];
      return { ...r, target: table && entityId && live[table].has(entityId) ? entityId : null };
    });
    return { items, pagination: paginate(page, limit, total) };
  }

  // One owner-scoped existence query per kind on this page, never per row.
  private async liveTargets(userId: string, rows: { type: T; entityId: string | null }[]) {
    const ids = (table: string) => [
      ...new Set(rows.filter((r) => LINKS[r.type] === table && r.entityId).map((r) => r.entityId!)),
    ];
    const own = { ownerUserId: userId, deletedAt: null };
    const found = async (list: string[], query: (list: string[]) => Promise<{ v: string }[]>) =>
      new Set(list.length ? (await query(list)).map((r) => r.v) : []);
    const byId = (model: { findMany: (args: object) => Promise<{ id: string }[]> }) => async (list: string[]) =>
      (await model.findMany({ where: { ...own, id: { in: list } }, select: { id: true } })).map((r) => ({ v: r.id }));
    const byKey = (model: { findMany: (args: object) => Promise<{ promptKey: string }[]> }) => async (list: string[]) =>
      (await model.findMany({ where: { ...own, promptKey: { in: list } }, select: { promptKey: true } })).map((r) => ({
        v: r.promptKey,
      }));
    const [message, recipient, trustedContact, memory, story, wish] = await Promise.all([
      found(ids('message'), byId(this.prisma.message)),
      found(ids('recipient'), byId(this.prisma.recipient)),
      found(ids('trustedContact'), byId(this.prisma.trustedContact)),
      found(ids('memory'), byId(this.prisma.memoryVaultItem)),
      found(ids('story'), byKey(this.prisma.myStoryResponse)),
      found(ids('wish'), byKey(this.prisma.myWishResponse)),
    ]);
    return { message, recipient, trustedContact, memory, story, wish };
  }
}

// "Recent changes": the Customer's own history; never anyone else's.
@ApiTags('Users')
@ApiCookieAuth(AUTH.customer)
@Controller('users/me/activity')
@UseGuards(SessionAuthGuard, CustomerGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get()
  list(@CurrentUser() user: SafeUser, @Query() query: PageQueryDto) {
    return this.activity.list(user.id, query.page, query.limit);
  }
}

// UsersModule backs SessionAuthGuard. Writing is a plain function
// (customer-activity.ts), called by each feature's service.
@Module({
  imports: [UsersModule],
  controllers: [ActivityController],
  providers: [ActivityService],
})
export class ActivityModule {}

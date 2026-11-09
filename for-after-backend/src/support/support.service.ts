import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { paginate, writeAuditLog, type AuditActor } from '../audit/audit-log.service.js';
import {
  AuditEventType,
  Prisma,
  SupportAuthorRole,
  SupportStatus,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  AdminSupportQueryDto,
  CreateSupportRequestDto,
  SupportStatusDto,
  SupportTextDto,
} from './dto/support.dto.js';

// Same message for a missing request and another Customer's.
export const REQUEST_NOT_FOUND = 'Support request not found.';
export const RESOLVED_CLOSED =
  'This request is resolved. Please create a new request if you still need help.';
export const STATUS_CHANGED =
  'This request’s status was changed by someone else. Reload it and try again.';
export const OPEN_LIMIT = 20;
export const TOO_MANY_OPEN = `You have ${OPEN_LIMIT} requests still open. Please wait for a reply before creating another.`;
export const ENTRY_LIMIT = 100;
export const CONVERSATION_FULL = 'This conversation is full. Please create a new request.';

/**
 * Admin transitions (docs/support.md): any other status, except that a
 * resolved request can only be reopened. Customers never set status; their
 * follow-up only returns WAITING_FOR_CUSTOMER to OPEN.
 */
export const canTransition = (from: SupportStatus, to: SupportStatus) =>
  from !== to && (from !== SupportStatus.RESOLVED || to === SupportStatus.OPEN);

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

const DAY = 24 * 60 * 60 * 1000;

const summarySelect = {
  id: true,
  subject: true,
  category: true,
  status: true,
  createdAt: true,
  lastPublicActivityAt: true,
} satisfies Prisma.SupportRequestSelect;

// The public conversation only. Author ids stay server-side: the Customer sees
// "You" or "For After support", never an admin's identity.
const publicMessages = {
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  select: { id: true, authorRole: true, body: true, createdAt: true },
} satisfies Prisma.SupportRequest$messagesArgs;

const customerDetailSelect = {
  ...summarySelect,
  description: true,
  messages: publicMessages,
} satisfies Prisma.SupportRequestSelect;

const adminDetailSelect = {
  ...summarySelect,
  ownerUserId: true,
  description: true,
  updatedAt: true,
  messages: { ...publicMessages, select: { ...publicMessages.select, authorUserId: true } },
  internalNotes: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, authorUserId: true, body: true, createdAt: true },
  },
} satisfies Prisma.SupportRequestSelect;

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Customer (always scoped to the session's own id) ──────────────────────

  async listOwn(ownerUserId: string, page: number, limit: number) {
    const where = { ownerUserId };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.supportRequest.findMany({
        where,
        orderBy: [{ lastPublicActivityAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: summarySelect,
      }),
      this.prisma.supportRequest.count({ where }),
    ]);
    return { items, pagination: paginate(page, limit, total) };
  }

  async getOwn(ownerUserId: string, id: string) {
    const found = await this.prisma.supportRequest.findFirst({
      where: { id, ownerUserId },
      select: customerDetailSelect,
    });
    if (!found) throw new NotFoundException(REQUEST_NOT_FOUND);
    return found;
  }

  async create(ownerUserId: string, dto: CreateSupportRequestDto, actor: AuditActor) {
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        // Serialises one Customer's creations, so the open limit holds.
        await tx.$queryRaw`SELECT 1 FROM "User" WHERE id = ${ownerUserId}::uuid FOR UPDATE`;
        const open = await tx.supportRequest.count({
          where: { ownerUserId, status: { not: SupportStatus.RESOLVED } },
        });
        if (open >= OPEN_LIMIT) throw new ConflictException(TOO_MANY_OPEN);
        const { id } = await tx.supportRequest.create({
          data: {
            ownerUserId,
            subject: dto.subject,
            category: dto.category,
            description: dto.description,
            clientRequestId: dto.clientRequestId,
          },
          select: { id: true },
        });
        await writeAuditLog(tx, {
          eventType: AuditEventType.SUPPORT_REQUEST_CREATED,
          actor,
          subjectType: 'SupportRequest',
          subjectId: id,
          metadata: { category: dto.category },
        });
        return id;
      });
      this.logger.log(`support_request_created request ${id} user ${ownerUserId}`);
      return this.getOwn(ownerUserId, id);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // A retry of the same submission: the first one, unchanged.
      const first = await this.prisma.supportRequest.findUniqueOrThrow({
        where: { ownerUserId_clientRequestId: { ownerUserId, clientRequestId: dto.clientRequestId } },
        select: { id: true },
      });
      return this.getOwn(ownerUserId, first.id);
    }
  }

  async followUp(ownerUserId: string, id: string, dto: SupportTextDto, actor: AuditActor) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const request = await tx.supportRequest.findFirst({
          where: { id, ownerUserId },
          select: { status: true, _count: { select: { messages: true } } },
        });
        if (!request) throw new NotFoundException(REQUEST_NOT_FOUND);
        if (request.status === SupportStatus.RESOLVED) throw new ConflictException(RESOLVED_CLOSED);
        if (request._count.messages >= ENTRY_LIMIT) throw new ConflictException(CONVERSATION_FULL);
        await tx.supportMessage.create({
          data: {
            supportRequestId: id,
            authorRole: SupportAuthorRole.CUSTOMER,
            authorUserId: ownerUserId,
            body: dto.body,
            clientRequestId: dto.clientRequestId,
          },
          select: { id: true },
        });
        const reopen = request.status === SupportStatus.WAITING_FOR_CUSTOMER;
        // Conditional on the status read above: an admin change in between is a 409, not overwritten.
        const { count } = await tx.supportRequest.updateMany({
          where: { id, status: request.status },
          data: { lastPublicActivityAt: new Date(), ...(reopen && { status: SupportStatus.OPEN }) },
        });
        if (!count) throw new ConflictException(STATUS_CHANGED);
        if (reopen) {
          await writeAuditLog(tx, {
            eventType: AuditEventType.SUPPORT_STATUS_CHANGED,
            actor,
            subjectType: 'SupportRequest',
            subjectId: id,
            metadata: { previousStatus: request.status, newStatus: SupportStatus.OPEN, by: 'customer_follow_up' },
          });
        }
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await this.sameRequest('supportMessage', ownerUserId, dto.clientRequestId, id);
    }
    return this.getOwn(ownerUserId, id);
  }

  // ─── Admin (AdminGuard: admin role + completed MFA) ───────────────────────

  async list(q: AdminSupportQueryDto) {
    if (q.from && q.to) {
      const span = new Date(q.to).getTime() - new Date(q.from).getTime();
      if (span < 0) throw new BadRequestException('from must be before to');
      if (span > 366 * DAY) throw new BadRequestException('The time range can be at most 366 days.');
    }
    const where: Prisma.SupportRequestWhereInput = {
      status: q.status,
      category: q.category,
      id: q.reference,
      ownerUserId: q.accountId,
      createdAt:
        q.from || q.to
          ? { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) }
          : undefined,
    };
    const sort = q.sort ?? 'createdAt';
    const [items, total] = await this.prisma.$transaction([
      this.prisma.supportRequest.findMany({
        where,
        orderBy: [{ [sort]: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: { ...summarySelect, ownerUserId: true },
      }),
      this.prisma.supportRequest.count({ where }),
    ]);
    return { items, pagination: paginate(q.page, q.limit, total) };
  }

  async get(id: string) {
    const found = await this.prisma.supportRequest.findUnique({ where: { id }, select: adminDetailSelect });
    if (!found) throw new NotFoundException(REQUEST_NOT_FOUND);
    return found;
  }

  /** "Reply to customer": public; does not change the status. */
  async reply(id: string, dto: SupportTextDto, actor: AuditActor) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const request = await tx.supportRequest.findUnique({
          where: { id },
          select: { _count: { select: { messages: true } } },
        });
        if (!request) throw new NotFoundException(REQUEST_NOT_FOUND);
        if (request._count.messages >= ENTRY_LIMIT) throw new ConflictException(CONVERSATION_FULL);
        await tx.supportMessage.create({
          data: {
            supportRequestId: id,
            authorRole: SupportAuthorRole.ADMIN,
            authorUserId: actor.userId,
            body: dto.body,
            clientRequestId: dto.clientRequestId,
          },
          select: { id: true },
        });
        await tx.supportRequest.update({ where: { id }, data: { lastPublicActivityAt: new Date() }, select: { id: true } });
        await writeAuditLog(tx, {
          eventType: AuditEventType.SUPPORT_REPLY_SENT,
          actor,
          subjectType: 'SupportRequest',
          subjectId: id,
        });
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await this.sameRequest('supportMessage', actor.userId, dto.clientRequestId, id);
    }
    return this.get(id);
  }

  /** "Internal note": admins only; never touches the request row or its public times. */
  async note(id: string, dto: SupportTextDto, actor: AuditActor) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const request = await tx.supportRequest.findUnique({
          where: { id },
          select: { _count: { select: { internalNotes: true } } },
        });
        if (!request) throw new NotFoundException(REQUEST_NOT_FOUND);
        if (request._count.internalNotes >= ENTRY_LIMIT) throw new ConflictException(CONVERSATION_FULL);
        await tx.supportInternalNote.create({
          data: { supportRequestId: id, authorUserId: actor.userId, body: dto.body, clientRequestId: dto.clientRequestId },
          select: { id: true },
        });
        await writeAuditLog(tx, {
          eventType: AuditEventType.SUPPORT_NOTE_ADDED,
          actor,
          subjectType: 'SupportRequest',
          subjectId: id,
        });
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await this.sameRequest('supportInternalNote', actor.userId, dto.clientRequestId, id);
    }
    return this.get(id);
  }

  async setStatus(id: string, dto: SupportStatusDto, actor: AuditActor) {
    if (!canTransition(dto.expectedStatus, dto.status)) {
      throw new BadRequestException(
        dto.expectedStatus === SupportStatus.RESOLVED
          ? 'A resolved request can only be reopened.'
          : 'Choose a different status.',
      );
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.supportRequest.updateMany({
        where: { id, status: dto.expectedStatus },
        data: { status: dto.status },
      });
      if (!count) {
        const exists = await tx.supportRequest.count({ where: { id } });
        throw exists ? new ConflictException(STATUS_CHANGED) : new NotFoundException(REQUEST_NOT_FOUND);
      }
      await writeAuditLog(tx, {
        eventType: AuditEventType.SUPPORT_STATUS_CHANGED,
        actor,
        subjectType: 'SupportRequest',
        subjectId: id,
        metadata: { previousStatus: dto.expectedStatus, newStatus: dto.status },
      });
    });
    return this.get(id);
  }

  // A reused submission id is only a retry if it was for this same request.
  private async sameRequest(
    table: 'supportMessage' | 'supportInternalNote',
    authorUserId: string,
    clientRequestId: string,
    requestId: string,
  ) {
    const where = { authorUserId_clientRequestId: { authorUserId, clientRequestId } };
    const first =
      table === 'supportMessage'
        ? await this.prisma.supportMessage.findUnique({ where, select: { supportRequestId: true } })
        : await this.prisma.supportInternalNote.findUnique({ where, select: { supportRequestId: true } });
    if (first?.supportRequestId !== requestId) {
      throw new ConflictException('This submission id was already used. Reload and try again.');
    }
  }
}

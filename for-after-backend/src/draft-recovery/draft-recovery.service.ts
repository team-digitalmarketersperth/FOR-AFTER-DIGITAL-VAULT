import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsString,
  isUUID,
  MaxLength,
  validateSync,
} from 'class-validator';
import { randomUUID } from 'node:crypto';
import {
  DraftRecoveryType,
  MessageStatus,
  type Prisma,
} from '../generated/prisma/client.js';
import { SUPPORTED_CONTENT_TYPES, TEXT_CONTENT_MAX } from '../messages/dto/create-message.dto.js';
import { getPromptByKey, MY_STORY_ANSWER_MAX } from '../my-story/my-story.prompts.js';
import { getWishPromptByKey } from '../my-wishes/my-wishes.prompts.js';
import { PrismaService } from '../prisma/prisma.service.js';

// Retention (approved 2026-10-14): 30 days after the last autosave.
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// ponytail: fixed cap on unsaved new-message drafts per Customer; oldest beyond it are dropped.
const NEW_MESSAGE_DRAFTS_MAX = 5;
const NOT_FOUND = 'Draft not found.';
const NOT_EDITABLE = 'This item can no longer be changed.';
const NONE = 'none';

// Payloads hold what the editor's text fields hold, nothing else: no ids,
// status, recipients or media. Partial text is fine (it is unsaved), so no
// "required" rules; the explicit Save still runs the full validation.
class MessageDraftPayload {
  @IsString()
  @MaxLength(200)
  title: string;

  @IsIn(SUPPORTED_CONTENT_TYPES)
  contentType: string;

  @IsString()
  @MaxLength(TEXT_CONTENT_MAX)
  textContent: string;
}

class StoryDraftPayload {
  @IsString()
  @MaxLength(MY_STORY_ANSWER_MAX)
  textContent: string;
}

class WishDraftPayload {
  @IsString()
  @MaxLength(TEXT_CONTENT_MAX)
  textContent: string;
}

const PAYLOADS = {
  MESSAGE: MessageDraftPayload,
  NEW_MESSAGE: MessageDraftPayload,
  MY_STORY: StoryDraftPayload,
  MY_WISHES: WishDraftPayload,
} as const;

type Payload = { title?: string; contentType?: string; textContent: string };

export type DraftView = {
  key: string;
  payload: Payload;
  /** What the editor started from, and what the saved item is now. */
  baseRevision: string;
  currentRevision: string;
  /** The saved item changed after this draft started (another tab or device). */
  conflict: boolean;
  updatedAt: Date;
};

// The saved (canonical) item a draft belongs to, as the editor compares it.
type Canonical = { revision: string; content: Payload | null; editable: boolean };

/**
 * My Story / My Wishes base revision: a short FNV-1a hash of the saved text
 * ("t" + 8 hex). The frontend computes the same from the answer it loaded, so
 * a draft started from different saved text is flagged. Not a security
 * control (collisions only hide a conflict hint); never sent anywhere else.
 */
export const textRevision = (text: string | null | undefined) => {
  let h = 0x811c9dc5;
  for (const c of text ?? '') {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `t${h.toString(16).padStart(8, '0')}`;
};

// Field by field: PostgreSQL JSONB does not keep key order.
const samePayload = (a: Payload, b: Payload) => {
  const keys = Object.keys(b) as (keyof Payload)[];
  return Object.keys(a).length === keys.length && keys.every((k) => a[k] === b[k]);
};

const sameText = (a: string | null | undefined, b: string | null | undefined) =>
  (a?.trim() || null) === (b?.trim() || null);

/**
 * Server-side autosave (docs/draft-recovery.md). Owner-only by construction:
 * every query has userId = the session user. Payloads are private content:
 * never logged, audited, sent to activity or shown to anyone else.
 */
@Injectable()
export class DraftRecoveryService {
  constructor(private readonly prisma: PrismaService) {}

  /** The draft, or null when there is none, it expired, or it matches what is saved (then deleted). */
  async get(userId: string, type: DraftRecoveryType, key: string): Promise<DraftView | null> {
    // First, so another Customer's message (or an unknown prompt) is 404 like every other route.
    const canonical = await this.canonical(userId, type, key);
    const row = await this.prisma.draftRecovery.findFirst({
      where: { userId, type, key, expiresAt: { gt: new Date() } },
    });
    if (!row) return null;
    const payload = row.payload as Payload;
    if (canonical.content && this.matches(type, payload, canonical.content)) {
      await this.prisma.draftRecovery.deleteMany({ where: { id: row.id } });
      return null;
    }
    return this.view(row, canonical);
  }

  /** The newest unsaved new-message draft (the /messages/new page offers it). */
  async latestNewMessage(userId: string): Promise<DraftView | null> {
    const row = await this.prisma.draftRecovery.findFirst({
      where: { userId, type: 'NEW_MESSAGE', expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
    return row && this.view(row, { revision: NONE, content: null, editable: true });
  }

  /** Issues the key for a never-saved message's first autosave. */
  async createNewMessage(userId: string, payload: unknown): Promise<DraftView> {
    const data = this.validate('NEW_MESSAGE', payload);
    const now = Date.now();
    const row = await this.prisma.$transaction(async (tx) => {
      await this.sweep(tx, userId);
      const created = await tx.draftRecovery.create({
        data: {
          userId,
          type: 'NEW_MESSAGE',
          key: randomUUID(),
          payload: data,
          baseRevision: NONE,
          expiresAt: new Date(now + DRAFT_TTL_MS),
        },
      });
      const older = await tx.draftRecovery.findMany({
        where: { userId, type: 'NEW_MESSAGE' },
        orderBy: { updatedAt: 'desc' },
        skip: NEW_MESSAGE_DRAFTS_MAX,
        select: { id: true },
      });
      if (older.length) {
        await tx.draftRecovery.deleteMany({ where: { id: { in: older.map((o) => o.id) } } });
      }
      return created;
    });
    return this.view(row, { revision: NONE, content: null, editable: true });
  }

  /**
   * Autosave. Only for an item the Customer may change right now (an own
   * DRAFT message, a catalogue prompt). A NEW_MESSAGE key must have been issued to this Customer.
   * The same payload again writes nothing.
   */
  async put(
    userId: string,
    type: DraftRecoveryType,
    key: string,
    payload: unknown,
    baseRevision: string,
  ): Promise<DraftView> {
    const data = this.validate(type, payload);
    const canonical = await this.canonical(userId, type, key);
    if (!canonical.editable) throw new ConflictException(NOT_EDITABLE);
    const where = { userId_type_key: { userId, type, key } };
    const existing = await this.prisma.draftRecovery.findUnique({ where });
    if (type === 'NEW_MESSAGE' && !existing) throw new NotFoundException(NOT_FOUND);
    if (existing && samePayload(existing.payload as Payload, data)) {
      return this.view(existing, canonical);
    }
    const expiresAt = new Date(Date.now() + DRAFT_TTL_MS);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.sweep(tx, userId);
      return tx.draftRecovery.upsert({
        where,
        // The base is fixed when the draft starts; later autosaves keep it.
        create: { userId, type, key, payload: data, baseRevision, expiresAt },
        update: { payload: data, expiresAt },
      });
    });
    return this.view(row, canonical);
  }

  async discard(userId: string, type: DraftRecoveryType, key: string): Promise<void> {
    await this.prisma.draftRecovery.deleteMany({ where: { userId, type, key } });
  }

  private view(
    row: { key: string; payload: unknown; baseRevision: string; updatedAt: Date },
    canonical: Canonical,
  ): DraftView {
    return {
      key: row.key,
      payload: row.payload as Payload,
      baseRevision: row.baseRevision,
      currentRevision: canonical.revision,
      conflict: row.baseRevision !== canonical.revision,
      updatedAt: row.updatedAt,
    };
  }

  // Opportunistic expiry: no job, just this Customer's expired rows on write.
  private sweep(tx: Prisma.TransactionClient, userId: string) {
    return tx.draftRecovery.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } });
  }

  // Whitelisted fields only; anything else (status, ownerUserId, ...) is 400.
  private validate(type: DraftRecoveryType, payload: unknown): Payload {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new BadRequestException('payload must be an object');
    }
    const instance = plainToInstance(PAYLOADS[type], payload);
    const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) throw new BadRequestException('payload is not valid');
    // forbidNonWhitelisted: what passed is exactly what was sent.
    return payload as Payload;
  }

  private matches(type: DraftRecoveryType, draft: Payload, saved: Payload) {
    if (type === 'MESSAGE') {
      return (
        sameText(draft.title, saved.title) &&
        draft.contentType === saved.contentType &&
        sameText(draft.textContent, saved.textContent)
      );
    }
    // Answers are stored exactly as written.
    return (draft.textContent || null) === (saved.textContent || null);
  }

  // 404 for anything that isn't this Customer's (or isn't a catalogue prompt).
  private async canonical(userId: string, type: DraftRecoveryType, key: string): Promise<Canonical> {
    switch (type) {
      case 'NEW_MESSAGE':
        return { revision: NONE, content: null, editable: true };
      case 'MESSAGE': {
        if (!isUUID(key)) throw new NotFoundException(NOT_FOUND);
        const m = await this.prisma.message.findFirst({
          where: { id: key, ownerUserId: userId, deletedAt: null },
          select: {
            status: true,
            title: true,
            contentType: true,
            textContent: true,
            versions: { select: { version: true }, orderBy: { version: 'desc' }, take: 1 },
          },
        });
        if (!m) throw new NotFoundException(NOT_FOUND);
        return {
          revision: String(m.versions[0]?.version ?? 0),
          content: { title: m.title, contentType: m.contentType, textContent: m.textContent ?? '' },
          editable: m.status === MessageStatus.DRAFT,
        };
      }
      case 'MY_STORY':
      case 'MY_WISHES': {
        const story = type === 'MY_STORY';
        if (!(story ? getPromptByKey(key) : getWishPromptByKey(key))) {
          throw new NotFoundException(NOT_FOUND);
        }
        const where = { ownerUserId: userId, promptKey: key, deletedAt: null };
        const select = { textContent: true };
        const r = story
          ? await this.prisma.myStoryResponse.findFirst({ where, select })
          : await this.prisma.myWishResponse.findFirst({ where, select });
        return {
          revision: textRevision(r?.textContent),
          content: { textContent: r?.textContent ?? '' },
          editable: true,
        };
      }
    }
  }
}

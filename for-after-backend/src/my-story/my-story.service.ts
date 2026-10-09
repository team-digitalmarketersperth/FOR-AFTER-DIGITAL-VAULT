import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetStatus, Prisma } from '../generated/prisma/client.js';
import { MediaCleanup } from '../media/media-cleanup.service.js';
import { isNoMatch, storedRefSelect } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MY_STORY_PROMPTS,
  type MyStoryCategory,
  type MyStoryPrompt,
  PROMPT_NOT_FOUND,
} from './my-story.prompts.js';

// ownerUserId and deletedAt never leave the API. The snapshot is the wording
// (and version) this answer was written for (Phase 14A). Linked memories are
// listed by id, title and category only, live ones only (Phase 14B).
const responseSelect = {
  id: true,
  promptKey: true,
  promptTextSnapshot: true,
  promptVersion: true,
  textContent: true,
  createdAt: true,
  updatedAt: true,
  memoryLinks: {
    where: { memoryVaultItem: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      memoryVaultItem: { select: { id: true, title: true, category: true } },
    },
  },
  _count: {
    select: {
      mediaAssets: {
        where: { deletedAt: null, status: MediaAssetStatus.READY },
      },
    },
  },
} satisfies Prisma.MyStoryResponseSelect;

type ResponseRow = Prisma.MyStoryResponseGetPayload<{
  select: typeof responseSelect;
}>;
export type StoryResponse = Omit<ResponseRow, 'memoryLinks' | '_count'> & {
  memories: ResponseRow['memoryLinks'][number]['memoryVaultItem'][];
  mediaCount: number;
};

export type PromptWithResponse = MyStoryPrompt & {
  answered: boolean;
  response: StoryResponse | null;
};

// Same message whether it was never answered, deleted, or (for another
// customer) answered by someone else.
export const RESPONSE_NOT_FOUND = 'Response not found.';
export const EMPTY_ANSWER =
  'Add some words, a photo, a recording or a memory before saving.';
// Same message whether a memory is missing, deleted or someone else's.
export const INVALID_MEMORIES = 'One or more memories are invalid.';

const toResponse = ({
  memoryLinks,
  _count,
  ...row
}: ResponseRow): StoryResponse => ({
  ...row,
  memories: memoryLinks.map((l) => l.memoryVaultItem),
  mediaCount: _count.mediaAssets,
});

/**
 * An answer counts once it has some content: text, a READY file or a live
 * linked memory. A row with none is an upload shell (files still uploading)
 * and is never shown as an answer.
 */
export const hasContent = (r: StoryResponse) =>
  Boolean(r.textContent?.trim()) || r.mediaCount > 0 || r.memories.length > 0;

const withResponse = (
  prompt: MyStoryPrompt,
  row: StoryResponse | null | undefined,
): PromptWithResponse => {
  const response = row && hasContent(row) ? row : null;
  return { ...prompt, answered: !!response, response };
};

/**
 * The live answer row to attach something to (Phase 14B uploads), created as
 * an empty, private shell when there is none. A deleted answer is restored
 * empty with the current wording (its old text, files and links went with
 * the delete). A retired prompt only accepts additions to a live answer.
 */
export async function liveResponseId(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  prompt: MyStoryPrompt,
): Promise<string> {
  const unique = {
    ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key },
  };
  const row = await tx.myStoryResponse.findUnique({
    where: unique,
    select: { id: true, deletedAt: true },
  });
  if (row && !row.deletedAt) return row.id;
  if (prompt.retired) throw new NotFoundException(PROMPT_NOT_FOUND);
  const fresh = {
    promptTextSnapshot: prompt.prompt,
    promptVersion: prompt.version,
    textContent: null,
  };
  const created = await tx.myStoryResponse.upsert({
    where: unique,
    create: { ownerUserId, promptKey: prompt.key, ...fresh },
    update: { ...fresh, deletedAt: null },
    select: { id: true },
  });
  return created.id;
}

/**
 * Private My Story answers, one per customer and prompt. Not Messages: no
 * recipients, schedule or release of their own; sharing is a separate Message
 * snapshot (StoryToMessageService). Every query includes the session user's
 * id; story text is never logged.
 */
@Injectable()
export class MyStoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cleanup: MediaCleanup,
  ) {}

  private live(ownerUserId: string, promptKey: string) {
    return { ownerUserId, promptKey, deletedAt: null };
  }

  async listPrompts(
    ownerUserId: string,
    category?: MyStoryCategory,
  ): Promise<PromptWithResponse[]> {
    const prompts = category
      ? MY_STORY_PROMPTS.filter((p) => p.category === category)
      : MY_STORY_PROMPTS;
    const rows = await this.prisma.myStoryResponse.findMany({
      where: {
        ownerUserId,
        deletedAt: null,
        promptKey: { in: prompts.map((p) => p.key) },
      },
      select: responseSelect,
    });
    const byKey = new Map(rows.map((r) => [r.promptKey, toResponse(r)]));
    // A retired prompt is listed only while it has an answer.
    return prompts
      .map((p) => withResponse(p, byKey.get(p.key)))
      .filter((p) => !p.retired || p.answered);
  }

  async getPrompt(
    ownerUserId: string,
    prompt: MyStoryPrompt,
  ): Promise<PromptWithResponse> {
    const result = withResponse(
      prompt,
      await this.findLive(ownerUserId, prompt.key),
    );
    if (prompt.retired && !result.answered) {
      throw new NotFoundException(PROMPT_NOT_FOUND);
    }
    return result;
  }

  async getResponse(
    ownerUserId: string,
    prompt: MyStoryPrompt,
  ): Promise<StoryResponse> {
    const { response } = withResponse(
      prompt,
      await this.findLive(ownerUserId, prompt.key),
    );
    if (!response) throw new NotFoundException(RESPONSE_NOT_FOUND);
    return response;
  }

  /**
   * Snapshot policy (approved, Phase 14A): an answer keeps the wording it was
   * first written for. Editing a live answer changes only what is sent; a new
   * answer, or one written again after a delete, takes the current wording
   * and version from the catalogue (never from the client). Still one row
   * per customer and prompt. A retired prompt takes edits, not new answers.
   *
   * Phase 14B: textContent may be omitted (unchanged) or null (cleared);
   * memoryVaultItemIds, when present, replaces the linked memories (own, live
   * ones only). One transaction, which refuses to leave the answer empty.
   */
  async save(
    ownerUserId: string,
    prompt: MyStoryPrompt,
    input: { textContent?: string | null; memoryVaultItemIds?: string[] },
  ): Promise<StoryResponse> {
    const { textContent, memoryVaultItemIds: links } = input;
    const unique = {
      ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key },
    };
    return this.prisma.$transaction(async (tx) => {
      if (links?.length) {
        const owned = await tx.memoryVaultItem.count({
          where: { id: { in: links }, ownerUserId, deletedAt: null },
        });
        if (owned !== links.length) {
          throw new BadRequestException(INVALID_MEMORIES);
        }
      }
      const existing = await tx.myStoryResponse.findUnique({
        where: unique,
        select: { id: true, deletedAt: true },
      });
      let id: string;
      if (existing && !existing.deletedAt) {
        id = existing.id;
        if (textContent !== undefined) {
          await tx.myStoryResponse.update({
            where: { id },
            data: { textContent },
            select: { id: true },
          });
        }
      } else {
        if (prompt.retired) throw new NotFoundException(PROMPT_NOT_FOUND);
        const fresh = {
          promptTextSnapshot: prompt.prompt,
          promptVersion: prompt.version,
          textContent: textContent ?? null,
        };
        // Atomic on (ownerUserId, promptKey): creates, or restores a deleted one.
        ({ id } = await tx.myStoryResponse.upsert({
          where: unique,
          create: { ownerUserId, promptKey: prompt.key, ...fresh },
          update: { ...fresh, deletedAt: null },
          select: { id: true },
        }));
      }
      if (links) {
        await tx.myStoryMemoryLink.deleteMany({
          where: { myStoryResponseId: id },
        });
        await tx.myStoryMemoryLink.createMany({
          data: links.map((memoryVaultItemId) => ({
            myStoryResponseId: id,
            memoryVaultItemId,
          })),
        });
      }
      const saved = toResponse(
        await tx.myStoryResponse.findUniqueOrThrow({
          where: { id },
          select: responseSelect,
        }),
      );
      if (!hasContent(saved)) throw new BadRequestException(EMPTY_ANSWER);
      return saved;
    });
  }

  /**
   * Soft delete of the answer and, in the same transaction, its live files
   * (any status) and its memory links, so nothing of it stays reachable. The
   * files are then removed from the provider, best effort (MediaCleanup
   * retries). No live answer (P2025) is a 404.
   */
  async remove(ownerUserId: string, prompt: MyStoryPrompt): Promise<void> {
    const deletedAt = new Date();
    let media;
    try {
      ({ mediaAssets: media } = await this.prisma.$transaction(async (tx) => {
        const row = await tx.myStoryResponse.update({
          where: {
            ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key },
            deletedAt: null,
          },
          data: {
            deletedAt,
            mediaAssets: {
              updateMany: { where: { deletedAt: null }, data: { deletedAt } },
            },
          },
          select: {
            id: true,
            // Read after the write: exactly the files this delete just hid.
            mediaAssets: { where: { deletedAt }, select: storedRefSelect },
          },
        });
        await tx.myStoryMemoryLink.deleteMany({
          where: { myStoryResponseId: row.id },
        });
        return row;
      }));
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(RESPONSE_NOT_FOUND);
      throw err;
    }
    await this.cleanup.purge('myStoryMediaAsset', media);
  }

  private async findLive(ownerUserId: string, promptKey: string) {
    const row = await this.prisma.myStoryResponse.findFirst({
      where: this.live(ownerUserId, promptKey),
      select: responseSelect,
    });
    return row && toResponse(row);
  }
}

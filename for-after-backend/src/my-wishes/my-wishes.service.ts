import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaAssetStatus, Prisma } from '../generated/prisma/client.js';
import { MediaCleanup } from '../media/media-cleanup.service.js';
import { isNoMatch, storedRefSelect } from '../media/media.service.js';
import { MyWishesDisclaimerService } from './my-wishes-disclaimer.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MY_WISHES_PROMPTS,
  type MyWishesCategory,
  type MyWishPrompt,
} from './my-wishes.prompts.js';

// ownerUserId, deletedAt and the prompt snapshot never leave the API.
// Phase 15B: plus the number of READY files (listed by …/response/media).
const responseSelect = {
  id: true,
  promptKey: true,
  textContent: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: {
      mediaAssets: {
        where: { deletedAt: null, status: MediaAssetStatus.READY },
      },
    },
  },
} satisfies Prisma.MyWishResponseSelect;

type ResponseRow = Prisma.MyWishResponseGetPayload<{
  select: typeof responseSelect;
}>;
export type WishResponse = Omit<ResponseRow, '_count'> & {
  mediaCount: number;
};

export type WishPromptWithResponse = MyWishPrompt & {
  answered: boolean;
  response: WishResponse | null;
};

// Same message whether it was never answered, deleted, or (for another
// customer) answered by someone else.
export const WISH_NOT_FOUND = 'Response not found.';
export const EMPTY_WISH =
  'Add some words, a photo or a recording before saving.';

const toResponse = ({ _count, ...row }: ResponseRow): WishResponse => ({
  ...row,
  mediaCount: _count.mediaAssets,
});

/**
 * A wish counts once it has some content: text or a READY file. A row with
 * neither is an upload shell (files still uploading) and is never shown.
 */
export const hasContent = (r: WishResponse) =>
  Boolean(r.textContent?.trim()) || r.mediaCount > 0;

const withResponse = (
  prompt: MyWishPrompt,
  row: WishResponse | undefined | null,
): WishPromptWithResponse => {
  const response = row && hasContent(row) ? row : null;
  return { ...prompt, answered: !!response, response };
};

/**
 * The live wish row to attach a file to (Phase 15B uploads), created as an
 * empty, private shell when there is none. A deleted wish is restored empty
 * with the current wording (its old text and files went with the delete).
 */
export async function liveWishId(
  tx: Prisma.TransactionClient,
  ownerUserId: string,
  prompt: MyWishPrompt,
): Promise<string> {
  const unique = {
    ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key },
  };
  const row = await tx.myWishResponse.findUnique({
    where: unique,
    select: { id: true, deletedAt: true },
  });
  if (row && !row.deletedAt) return row.id;
  const fresh = {
    promptTextSnapshot: prompt.prompt,
    promptVersion: prompt.version,
    textContent: null,
  };
  const created = await tx.myWishResponse.upsert({
    where: unique,
    create: { ownerUserId, promptKey: prompt.key, ...fresh },
    update: { ...fresh, deletedAt: null },
    select: { id: true },
  });
  return created.id;
}

/**
 * Private My Wishes answers, one per customer and prompt. Personal
 * preferences only, never a legal document. Not Messages: no recipients,
 * schedule or release of their own; sharing is a separate Message snapshot
 * (WishToMessageService, Phase 15B). Every query includes the session user's
 * id; the text is never logged.
 */
@Injectable()
export class MyWishesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly disclaimer: MyWishesDisclaimerService,
    private readonly cleanup: MediaCleanup,
  ) {}

  async listPrompts(
    ownerUserId: string,
    category?: MyWishesCategory,
  ): Promise<WishPromptWithResponse[]> {
    const prompts = category
      ? MY_WISHES_PROMPTS.filter((p) => p.category === category)
      : MY_WISHES_PROMPTS;
    const rows = await this.prisma.myWishResponse.findMany({
      where: {
        ownerUserId,
        deletedAt: null,
        promptKey: { in: prompts.map((p) => p.key) },
      },
      select: responseSelect,
    });
    const byKey = new Map(rows.map((r) => [r.promptKey, toResponse(r)]));
    return prompts.map((p) => withResponse(p, byKey.get(p.key)));
  }

  async getPrompt(
    ownerUserId: string,
    prompt: MyWishPrompt,
  ): Promise<WishPromptWithResponse> {
    return withResponse(prompt, await this.findLive(ownerUserId, prompt.key));
  }

  async getResponse(
    ownerUserId: string,
    prompt: MyWishPrompt,
  ): Promise<WishResponse> {
    const { response } = withResponse(
      prompt,
      await this.findLive(ownerUserId, prompt.key),
    );
    if (!response) throw new NotFoundException(WISH_NOT_FOUND);
    return response;
  }

  // One atomic upsert on (ownerUserId, promptKey): creates the answer, updates
  // it, or restores a soft-deleted one. The snapshot always comes from the
  // catalogue and records the wording the current text answers. Phase 15A:
  // only once the current My Wishes notice is acknowledged (409 otherwise);
  // reading and deleting never need it. Phase 15B: textContent omitted =
  // unchanged, null = cleared; a wish left with no text and no READY file is
  // refused (the transaction rolls back, nothing changes).
  async save(
    ownerUserId: string,
    prompt: MyWishPrompt,
    textContent: string | null | undefined,
  ): Promise<WishResponse> {
    await this.disclaimer.assertAcknowledged(ownerUserId);
    const snapshot = {
      promptTextSnapshot: prompt.prompt,
      promptVersion: prompt.version,
    };
    return this.prisma.$transaction(async (tx) => {
      const saved = toResponse(
        await tx.myWishResponse.upsert({
          where: {
            ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key },
          },
          create: {
            ownerUserId,
            promptKey: prompt.key,
            ...snapshot,
            textContent: textContent ?? null,
          },
          update: { ...snapshot, textContent, deletedAt: null },
          select: responseSelect,
        }),
      );
      if (!hasContent(saved)) throw new BadRequestException(EMPTY_WISH);
      return saved;
    });
  }

  /**
   * Soft delete of the wish and, in the same UPDATE, its live files (any
   * status), so nothing of it stays reachable. The files are then removed
   * from the provider, best effort (MediaCleanup retries). Messages already
   * made from it are independent copies and are not touched. No live answer
   * (P2025) is a 404.
   */
  async remove(ownerUserId: string, prompt: MyWishPrompt): Promise<void> {
    const deletedAt = new Date();
    let media;
    try {
      ({ mediaAssets: media } = await this.prisma.myWishResponse.update({
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
          // Read after the write: exactly the files this delete just hid.
          mediaAssets: { where: { deletedAt }, select: storedRefSelect },
        },
      }));
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(WISH_NOT_FOUND);
      throw err;
    }
    await this.cleanup.purge('myWishMediaAsset', media);
  }

  private async findLive(ownerUserId: string, promptKey: string) {
    const row = await this.prisma.myWishResponse.findFirst({
      where: { ownerUserId, promptKey, deletedAt: null },
      select: responseSelect,
    });
    return row && toResponse(row);
  }
}

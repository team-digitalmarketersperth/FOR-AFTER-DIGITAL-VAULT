import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { isNoMatch } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MY_WISHES_PROMPTS,
  type MyWishesCategory,
  type MyWishPrompt,
} from './my-wishes.prompts.js';

// ownerUserId, deletedAt and the prompt snapshot never leave the API.
const responseSelect = {
  id: true,
  promptKey: true,
  textContent: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MyWishResponseSelect;

export type WishResponse = Prisma.MyWishResponseGetPayload<{
  select: typeof responseSelect;
}>;

export type WishPromptWithResponse = MyWishPrompt & {
  answered: boolean;
  response: WishResponse | null;
};

// Same message whether it was never answered, deleted, or (for another
// customer) answered by someone else.
export const WISH_NOT_FOUND = 'Response not found.';

const withResponse = (
  prompt: MyWishPrompt,
  response: WishResponse | undefined | null,
): WishPromptWithResponse => ({
  ...prompt,
  answered: !!response,
  response: response ?? null,
});

/**
 * Private My Wishes answers, one per customer and prompt. Personal
 * preferences only, never a legal document. Only touches MyWishResponse: no
 * Messages, schedules, recipients, release or media. Every query includes the
 * session user's id; the text is never logged.
 */
@Injectable()
export class MyWishesService {
  constructor(private readonly prisma: PrismaService) {}

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
    const byKey = new Map(rows.map((r) => [r.promptKey, r]));
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
    const row = await this.findLive(ownerUserId, prompt.key);
    if (!row) throw new NotFoundException(WISH_NOT_FOUND);
    return row;
  }

  // One atomic upsert on (ownerUserId, promptKey): creates the answer, updates
  // it, or restores a soft-deleted one. The snapshot always comes from the
  // catalogue and records the wording the current text answers.
  save(
    ownerUserId: string,
    prompt: MyWishPrompt,
    textContent: string,
  ): Promise<WishResponse> {
    const answer = {
      promptTextSnapshot: prompt.prompt,
      promptVersion: prompt.version,
      textContent,
    };
    return this.prisma.myWishResponse.upsert({
      where: { ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key } },
      create: { ownerUserId, promptKey: prompt.key, ...answer },
      update: { ...answer, deletedAt: null },
      select: responseSelect,
    });
  }

  // Soft delete with one conditional UPDATE; no live answer (P2025) is a 404.
  async remove(ownerUserId: string, prompt: MyWishPrompt): Promise<void> {
    try {
      await this.prisma.myWishResponse.update({
        where: {
          ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key },
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
        select: { id: true },
      });
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(WISH_NOT_FOUND);
      throw err;
    }
  }

  private findLive(ownerUserId: string, promptKey: string) {
    return this.prisma.myWishResponse.findFirst({
      where: { ownerUserId, promptKey, deletedAt: null },
      select: responseSelect,
    });
  }
}

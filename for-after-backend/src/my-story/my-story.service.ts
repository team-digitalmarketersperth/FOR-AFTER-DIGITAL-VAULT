import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { isNoMatch } from '../media/media.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  MY_STORY_PROMPTS,
  type MyStoryCategory,
  type MyStoryPrompt,
} from './my-story.prompts.js';

// ownerUserId, deletedAt and the prompt snapshot never leave the API.
const responseSelect = {
  id: true,
  promptKey: true,
  textContent: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MyStoryResponseSelect;

export type StoryResponse = Prisma.MyStoryResponseGetPayload<{
  select: typeof responseSelect;
}>;

export type PromptWithResponse = MyStoryPrompt & {
  answered: boolean;
  response: StoryResponse | null;
};

// Same message whether it was never answered, deleted, or (for another
// customer) answered by someone else.
export const RESPONSE_NOT_FOUND = 'Response not found.';

const withResponse = (
  prompt: MyStoryPrompt,
  response: StoryResponse | undefined | null,
): PromptWithResponse => ({
  ...prompt,
  answered: !!response,
  response: response ?? null,
});

/**
 * Private My Story answers, one per customer and prompt. Not Messages or
 * Memory Vault items: no recipients, schedule, release or media. Every query
 * includes the session user's id; the story text is never logged.
 */
@Injectable()
export class MyStoryService {
  constructor(private readonly prisma: PrismaService) {}

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
    const byKey = new Map(rows.map((r) => [r.promptKey, r]));
    return prompts.map((p) => withResponse(p, byKey.get(p.key)));
  }

  async getPrompt(
    ownerUserId: string,
    prompt: MyStoryPrompt,
  ): Promise<PromptWithResponse> {
    return withResponse(prompt, await this.findLive(ownerUserId, prompt.key));
  }

  async getResponse(
    ownerUserId: string,
    prompt: MyStoryPrompt,
  ): Promise<StoryResponse> {
    const row = await this.findLive(ownerUserId, prompt.key);
    if (!row) throw new NotFoundException(RESPONSE_NOT_FOUND);
    return row;
  }

  // One atomic upsert on (ownerUserId, promptKey): creates the answer, updates
  // it, or restores a soft-deleted one. The snapshot always comes from the
  // catalogue and records the wording the current text answers.
  save(
    ownerUserId: string,
    prompt: MyStoryPrompt,
    textContent: string,
  ): Promise<StoryResponse> {
    const answer = {
      promptTextSnapshot: prompt.prompt,
      promptVersion: prompt.version,
      textContent,
    };
    return this.prisma.myStoryResponse.upsert({
      where: { ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key } },
      create: { ownerUserId, promptKey: prompt.key, ...answer },
      update: { ...answer, deletedAt: null },
      select: responseSelect,
    });
  }

  // Soft delete with one conditional UPDATE; no live answer (P2025) is a 404.
  async remove(ownerUserId: string, prompt: MyStoryPrompt): Promise<void> {
    try {
      await this.prisma.myStoryResponse.update({
        where: {
          ownerUserId_promptKey: { ownerUserId, promptKey: prompt.key },
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
        select: { id: true },
      });
    } catch (err) {
      if (isNoMatch(err)) throw new NotFoundException(RESPONSE_NOT_FOUND);
      throw err;
    }
  }

  private findLive(ownerUserId: string, promptKey: string) {
    return this.prisma.myStoryResponse.findFirst({
      where: this.live(ownerUserId, promptKey),
      select: responseSelect,
    });
  }
}

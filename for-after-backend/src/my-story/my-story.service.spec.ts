import {
  BadRequestException,
  type ExecutionContext,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  MyStoryPromptsQueryDto,
  SaveMyStoryResponseDto,
} from './dto/save-my-story-response.dto.js';
import { MyStoryController, PromptKeyPipe } from './my-story.controller.js';
import {
  getPromptByKey,
  MY_STORY_ANSWER_MAX,
  MY_STORY_CATEGORIES,
  MY_STORY_PROMPTS,
  type MyStoryPrompt,
  PROMPT_KEY_PATTERN,
  PROMPT_NOT_FOUND,
} from './my-story.prompts.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
import {
  EMPTY_ANSWER,
  INVALID_MEMORIES,
  MyStoryService,
  RESPONSE_NOT_FOUND,
} from './my-story.service.js';

const prompt = getPromptByKey('legacy.remembered')!;
const text = 'A fictional answer.';
const row = {
  id: 'r1',
  promptKey: 'legacy.remembered',
  promptTextSnapshot: 'How would you like to be remembered?',
  promptVersion: 1,
  textContent: text,
  createdAt: new Date(),
  updatedAt: new Date(),
};
// As selected from the database (links + READY file count), and as returned.
const dbRow = (over: object = {}) => ({
  ...row,
  memoryLinks: [] as { memoryVaultItem: object }[],
  _count: { mediaAssets: 0 },
  ...over,
});
const response = { ...row, memories: [], mediaCount: 0 };
const unique = { ownerUserId: 'lisa', promptKey: 'legacy.remembered' };
const MEM1 = '11111111-1111-4111-8111-111111111111';
const MEM2 = '22222222-2222-4222-8222-222222222222';

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

const setup = () => {
  const myStoryResponse = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(dbRow()),
    // Default: the answer is live, so a save is an edit.
    findUnique: vi.fn().mockResolvedValue({ id: 'r1', deletedAt: null }),
    findUniqueOrThrow: vi.fn().mockResolvedValue(dbRow()),
    upsert: vi.fn().mockResolvedValue({ id: 'r1' }),
    update: vi.fn().mockResolvedValue({ id: 'r1', mediaAssets: [] }),
  };
  // Every requested memory is the owner's and live unless a test says not.
  const memoryVaultItem = {
    count: vi.fn(
      async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.length,
    ),
  };
  const myStoryMemoryLink = {
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const tx = { myStoryResponse, memoryVaultItem, myStoryMemoryLink };
  const $transaction = vi.fn((fn: (t: typeof tx) => unknown) => fn(tx));
  const cleanup = {
    purge: vi.fn().mockResolvedValue({ purged: 0, failed: 0 }),
  };
  return {
    myStoryResponse,
    memoryVaultItem,
    myStoryMemoryLink,
    cleanup,
    service: new MyStoryService(
      { ...tx, $transaction } as unknown as PrismaService,
      cleanup as unknown as MediaCleanup,
    ),
  };
};

const errorsFor = async (cls: new () => object, body: object) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

// The V1 catalogue approved by the product owner (2026-10-08, Phase 14A), in
// display order. Changing it here means a new product decision.
const APPROVED: [string, string[]][] = [
  [
    'CHILDHOOD',
    ['childhood.earliest-memory', 'childhood.home', 'childhood.school'],
  ],
  [
    'FAMILY',
    ['family.influence', 'family.lesson-from-parents', 'family.tradition'],
  ],
  ['RELATIONSHIPS', ['relationships.love', 'relationships.friendship']],
  ['WORK', ['work.first-job', 'work.meaningful']],
  ['TRAVEL', ['travel.place', 'travel.journey']],
  [
    'MILESTONES',
    [
      'milestones.proudest',
      'milestones.turning-point',
      'milestones.favourite-day',
    ],
  ],
  ['VALUES', ['values.guiding-values', 'values.kindness']],
  [
    'LIFE_LESSONS',
    [
      'life-lessons.hardest',
      'life-lessons.advice',
      'life-lessons.younger-self',
    ],
  ],
  ['LEGACY', ['legacy.remembered', 'legacy.most-important']],
];

// The keys that existed before V1, with the exact wording answers were
// written for: none may be renamed, reworded without a version bump, or reused.
const PRE_V1: Record<string, string> = {
  'childhood.earliest-memory': 'What is one of your earliest memories?',
  'childhood.home': 'What was the place you grew up in like?',
  'family.influence': 'Who had the greatest influence on you growing up?',
  'family.tradition': 'What family tradition has meant the most to you?',
  'relationships.love': 'What has love taught you?',
  'milestones.proudest': 'What are you most proud of in your life?',
  'milestones.turning-point': 'What moment changed the direction of your life?',
  'values.guiding-values': 'What values have guided the way you live?',
  'life-lessons.hardest': 'What lesson took you the longest to learn?',
  'life-lessons.advice':
    'What advice would you want the people you love to remember?',
  'legacy.remembered': 'How would you like to be remembered?',
  'legacy.most-important':
    'What do you hope the people you love will carry forward from your life?',
};

describe('My Story V1 catalogue (approved 2026-10-08)', () => {
  it('has exactly the approved categories, in order', () => {
    expect([...MY_STORY_CATEGORIES]).toEqual(APPROVED.map(([c]) => c));
  });

  it('has exactly the approved prompts, in order, each in its category', () => {
    expect(MY_STORY_PROMPTS.map((p) => p.key)).toEqual(
      APPROVED.flatMap(([, keys]) => keys),
    );
    for (const [category, keys] of APPROVED)
      expect(
        MY_STORY_PROMPTS.filter((p) => p.category === category).map(
          (p) => p.key,
        ),
      ).toEqual(keys);
    expect(MY_STORY_PROMPTS).toHaveLength(22);
  });

  it('integrity: unique well-formed keys, valid categories and versions, no blank or duplicate wording', () => {
    const keys = MY_STORY_PROMPTS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    const texts = MY_STORY_PROMPTS.filter((p) => !p.retired).map((p) =>
      p.prompt.trim().toLowerCase(),
    );
    expect(new Set(texts).size).toBe(texts.length);
    for (const p of MY_STORY_PROMPTS) {
      expect(p.key).toMatch(PROMPT_KEY_PATTERN);
      expect(MY_STORY_CATEGORIES).toContain(p.category);
      expect(Number.isInteger(p.version) && p.version >= 1).toBe(true);
      expect(p.prompt.trim()).not.toBe('');
      expect(p.prompt).toBe(p.prompt.trim());
    }
    // Every category has at least one active prompt.
    expect(
      new Set(
        MY_STORY_PROMPTS.filter((p) => !p.retired).map((p) => p.category),
      ),
    ).toEqual(new Set(MY_STORY_CATEGORIES));
  });

  it('keeps every pre-V1 key with its exact wording at version 1 (stored answers stay true)', () => {
    for (const [key, wording] of Object.entries(PRE_V1)) {
      const p = getPromptByKey(key);
      expect(p, key).toBeDefined();
      expect(p!.prompt).toBe(wording);
      expect(p!.version).toBe(1);
    }
  });

  it('looks prompts up by key only', () => {
    expect(getPromptByKey('work.first-job')?.category).toBe('WORK');
    expect(getPromptByKey('nope.unknown')).toBeUndefined();
    expect(getPromptByKey('What has love taught you?')).toBeUndefined();
    expect(getPromptByKey('0')).toBeUndefined();
  });
});

describe('PromptKeyPipe', () => {
  const pipe = new PromptKeyPipe();

  it('resolves a known key to the trusted definition', () => {
    expect(pipe.transform('legacy.remembered')).toBe(prompt);
    expect(pipe.transform('travel.journey').category).toBe('TRAVEL');
  });

  it('unknown but well-formed key → 404', () => {
    expect(() => pipe.transform('legacy.unknown')).toThrow(NotFoundException);
  });

  it.each([
    '../../etc/passwd',
    '..',
    'legacy/remembered',
    'https://example.test',
    'Legacy.Remembered',
    'legacy',
    'legacy..remembered',
    'legacy.remembered ',
    `a.${'b'.repeat(100)}`,
  ])('malformed key %j → 400', (key) => {
    expect(() => pipe.transform(key)).toThrow(BadRequestException);
  });
});

describe('SaveMyStoryResponseDto (50,000 characters, approved)', () => {
  it.each([
    { textContent: 'x' },
    // Phase 14B: text is optional (files or memories only) and can be cleared.
    {},
    { textContent: null },
    { memoryVaultItemIds: [] },
    { memoryVaultItemIds: [MEM1, MEM2] },
    { textContent: 'x', memoryVaultItemIds: [MEM1] },
    { textContent: '  Kept with its spaces.  ' },
    { textContent: 'a\n\nb' },
    { textContent: 'x'.repeat(MY_STORY_ANSWER_MAX) },
    { textContent: '<script>alert(1)</script>' },
  ])('accepts %#', async (body) => {
    expect(await errorsFor(SaveMyStoryResponseDto, body)).toEqual([]);
  });

  it('the limit is 50,000', () => {
    expect(MY_STORY_ANSWER_MAX).toBe(50_000);
  });

  it.each([
    ['textContent', { textContent: '' }],
    ['textContent', { textContent: '   \n\t ' }],
    ['textContent', { textContent: 42 }],
    ['memoryVaultItemIds', { memoryVaultItemIds: null }],
    ['memoryVaultItemIds', { memoryVaultItemIds: ['not-a-uuid'] }],
    ['memoryVaultItemIds', { memoryVaultItemIds: [MEM1, MEM1.toUpperCase()] }],
    ['memoryVaultItemIds', { memoryVaultItemIds: Array(101).fill(MEM1) }],
    ['textContent', { textContent: 'x'.repeat(MY_STORY_ANSWER_MAX + 1) }],
    ['ownerUserId', { textContent: 'x', ownerUserId: 'john' }],
    ['promptVersion', { textContent: 'x', promptVersion: 9 }],
    ['promptTextSnapshot', { textContent: 'x', promptTextSnapshot: 'x' }],
    ['promptKey', { textContent: 'x', promptKey: 'family.influence' }],
    ['recipientIds', { textContent: 'x', recipientIds: [] }],
    ['deletedAt', { textContent: 'x', deletedAt: null }],
  ])('rejects %s in %#', async (field, body) => {
    expect(await errorsFor(SaveMyStoryResponseDto, body)).toContain(field);
  });

  it('does not change the text', () => {
    const raw = '  My story.\n';
    expect(
      plainToInstance(SaveMyStoryResponseDto, { textContent: raw }).textContent,
    ).toBe(raw);
  });
});

describe('MyStoryPromptsQueryDto', () => {
  it('accepts no filter or a V1 category, rejects others', async () => {
    expect(await errorsFor(MyStoryPromptsQueryDto, {})).toEqual([]);
    for (const category of MY_STORY_CATEGORIES)
      expect(await errorsFor(MyStoryPromptsQueryDto, { category })).toEqual([]);
    for (const category of ['childhood', 'RECIPES', 'CAREER', '']) {
      expect(await errorsFor(MyStoryPromptsQueryDto, { category })).toEqual([
        'category',
      ]);
    }
  });
});

describe('MyStoryService', () => {
  it('lists every prompt in order with the owner’s live answers (answered wording, memories, file count)', async () => {
    const { myStoryResponse, service } = setup();
    myStoryResponse.findMany.mockResolvedValue([dbRow()]);
    const list = await service.listPrompts('lisa');
    expect(list.map((p) => p.key)).toEqual(MY_STORY_PROMPTS.map((p) => p.key));
    const { where, select } = myStoryResponse.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ ownerUserId: 'lisa', deletedAt: null });
    expect(select).not.toHaveProperty('ownerUserId');
    expect(select).not.toHaveProperty('deletedAt');
    expect(select).toMatchObject({
      promptTextSnapshot: true,
      promptVersion: true,
    });
    // Only live linked memories, by id/title/category; READY files only.
    expect(select.memoryLinks.where).toEqual({
      memoryVaultItem: { deletedAt: null },
    });
    expect(select.memoryLinks.select.memoryVaultItem.select).toEqual({
      id: true,
      title: true,
      category: true,
    });
    expect(select._count.select.mediaAssets.where).toEqual({
      deletedAt: null,
      status: 'READY',
    });
    expect(list.find((p) => p.key === 'legacy.remembered')).toMatchObject({
      answered: true,
      response,
    });
    expect(list.find((p) => p.key === 'childhood.home')).toMatchObject({
      answered: false,
      response: null,
    });
  });

  it.each([
    ['text only', dbRow(), true],
    [
      'files only',
      dbRow({ textContent: null, _count: { mediaAssets: 2 } }),
      true,
    ],
    [
      'linked memories only',
      dbRow({
        textContent: null,
        memoryLinks: [
          { memoryVaultItem: { id: MEM1, title: 'T', category: 'OTHER' } },
        ],
      }),
      true,
    ],
    [
      'an upload shell (nothing READY yet)',
      dbRow({ textContent: null }),
      false,
    ],
    ['blank text and nothing else', dbRow({ textContent: '   ' }), false],
  ])('answered when it has content: %s → %s', async (_, r, answered) => {
    const { myStoryResponse, service } = setup();
    myStoryResponse.findMany.mockResolvedValue([r]);
    const p = (await service.listPrompts('lisa', 'LEGACY')).find(
      (x) => x.key === 'legacy.remembered',
    )!;
    expect(p.answered).toBe(answered);
    expect(p.response === null).toBe(!answered);
  });

  it.each(APPROVED)(
    'filters by category %s, in order',
    async (category, keys) => {
      const { myStoryResponse, service } = setup();
      const list = await service.listPrompts(
        'lisa',
        category as (typeof MY_STORY_CATEGORIES)[number],
      );
      expect(list.map((p) => p.key)).toEqual(keys);
      expect(myStoryResponse.findMany.mock.calls[0][0].where.promptKey).toEqual(
        { in: keys },
      );
    },
  );

  it('GET prompt / response: owner + key + live; unanswered or a bare shell → 404', async () => {
    const { myStoryResponse, service } = setup();
    expect(await service.getResponse('lisa', prompt)).toEqual(response);
    expect(myStoryResponse.findFirst.mock.calls[0][0].where).toEqual({
      ...unique,
      deletedAt: null,
    });
    myStoryResponse.findFirst.mockResolvedValue(dbRow({ textContent: null }));
    await expect(service.getResponse('lisa', prompt)).rejects.toThrow(
      RESPONSE_NOT_FOUND,
    );
    myStoryResponse.findFirst.mockResolvedValue(null);
    await expect(service.getResponse('john', prompt)).rejects.toThrow(
      RESPONSE_NOT_FOUND,
    );
    expect(myStoryResponse.findFirst.mock.calls[2][0].where.ownerUserId).toBe(
      'john',
    );
    expect(await service.getPrompt('lisa', prompt)).toMatchObject({
      key: 'legacy.remembered',
      answered: false,
      response: null,
    });
  });

  describe('save: snapshot policy (first-answered wording)', () => {
    it('editing a live answer changes only its text: wording and version stay', async () => {
      const { myStoryResponse, service } = setup();
      expect(
        await service.save('lisa', prompt, { textContent: 'Edited.' }),
      ).toEqual(response);
      expect(myStoryResponse.findUnique.mock.calls[0][0].where).toEqual({
        ownerUserId_promptKey: unique,
      });
      const args = myStoryResponse.update.mock.calls[0][0];
      expect(args.where).toEqual({ id: 'r1' });
      expect(args.data).toEqual({ textContent: 'Edited.' });
      expect(myStoryResponse.upsert).not.toHaveBeenCalled();
    });

    it('an edit after a wording change (v2) still keeps the original v1 snapshot', async () => {
      const { myStoryResponse, service } = setup();
      const reworded: MyStoryPrompt = {
        ...prompt,
        version: 2,
        prompt: 'How do you hope to be remembered?',
      };
      await service.save('lisa', reworded, { textContent: 'Edited.' });
      expect(myStoryResponse.update.mock.calls[0][0].data).toEqual({
        textContent: 'Edited.',
      });
    });

    it('text omitted → unchanged (no text write); null → cleared', async () => {
      const { myStoryResponse, service } = setup();
      await service.save('lisa', prompt, { memoryVaultItemIds: [MEM1] });
      expect(myStoryResponse.update).not.toHaveBeenCalled();
      myStoryResponse.findUniqueOrThrow.mockResolvedValue(
        dbRow({ textContent: null, _count: { mediaAssets: 1 } }),
      );
      await service.save('lisa', prompt, { textContent: null });
      expect(myStoryResponse.update.mock.calls[0][0].data).toEqual({
        textContent: null,
      });
    });

    it('a first answer, or one written again after a delete, takes the current wording and version', async () => {
      const { myStoryResponse, service } = setup();
      myStoryResponse.findUnique.mockResolvedValue({
        id: 'r1',
        deletedAt: new Date(),
      });
      const reworded: MyStoryPrompt = {
        ...prompt,
        version: 2,
        prompt: 'How do you hope to be remembered?',
      };
      await service.save('lisa', reworded, { textContent: text });
      const args = myStoryResponse.upsert.mock.calls[0][0];
      expect(args.where).toEqual({ ownerUserId_promptKey: unique });
      const answer = {
        promptTextSnapshot: 'How do you hope to be remembered?',
        promptVersion: 2,
        textContent: text,
      };
      expect(args.create).toEqual({ ...unique, ...answer });
      // The same row is restored (one answer per prompt), never a second one.
      expect(args.update).toEqual({ ...answer, deletedAt: null });
    });

    it('the owner and snapshot never come from the client', async () => {
      const { myStoryResponse, service } = setup();
      myStoryResponse.findUnique.mockResolvedValue(null);
      await service.save('john', prompt, { textContent: text });
      const { where, create } = myStoryResponse.upsert.mock.calls[0][0];
      expect(where.ownerUserId_promptKey.ownerUserId).toBe('john');
      expect(create.ownerUserId).toBe('john');
      expect(create.promptTextSnapshot).toBe(prompt.prompt);
      expect(create.promptVersion).toBe(prompt.version);
    });

    it('never leaves the answer empty (400, rolled back)', async () => {
      const { myStoryResponse, service } = setup();
      myStoryResponse.findUniqueOrThrow.mockResolvedValue(
        dbRow({ textContent: null }),
      );
      await expect(
        service.save('lisa', prompt, { textContent: null }),
      ).rejects.toThrow(EMPTY_ANSWER);
    });

    it('a files-only answer is fine', async () => {
      const { myStoryResponse, service } = setup();
      myStoryResponse.findUniqueOrThrow.mockResolvedValue(
        dbRow({ textContent: null, _count: { mediaAssets: 1 } }),
      );
      expect(
        (await service.save('lisa', prompt, { textContent: null })).mediaCount,
      ).toBe(1);
    });
  });

  describe('save: linked memories (Phase 14B)', () => {
    it('present → only own live memories, then the whole set is replaced', async () => {
      const { memoryVaultItem, myStoryMemoryLink, service } = setup();
      await service.save('lisa', prompt, { memoryVaultItemIds: [MEM1, MEM2] });
      expect(memoryVaultItem.count).toHaveBeenCalledWith({
        where: {
          id: { in: [MEM1, MEM2] },
          ownerUserId: 'lisa',
          deletedAt: null,
        },
      });
      expect(myStoryMemoryLink.deleteMany).toHaveBeenCalledWith({
        where: { myStoryResponseId: 'r1' },
      });
      expect(myStoryMemoryLink.createMany).toHaveBeenCalledWith({
        data: [
          { myStoryResponseId: 'r1', memoryVaultItemId: MEM1 },
          { myStoryResponseId: 'r1', memoryVaultItemId: MEM2 },
        ],
      });
    });

    it('[] unlinks all; omitted keeps the links untouched', async () => {
      const { memoryVaultItem, myStoryMemoryLink, service } = setup();
      await service.save('lisa', prompt, { memoryVaultItemIds: [] });
      expect(memoryVaultItem.count).not.toHaveBeenCalled();
      expect(myStoryMemoryLink.deleteMany).toHaveBeenCalledTimes(1);
      expect(myStoryMemoryLink.createMany).toHaveBeenCalledWith({ data: [] });
      await service.save('lisa', prompt, { textContent: 'x' });
      expect(myStoryMemoryLink.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('another Customer’s, deleted or missing memory → 400, nothing written', async () => {
      const { myStoryResponse, memoryVaultItem, myStoryMemoryLink, service } =
        setup();
      memoryVaultItem.count.mockResolvedValue(1);
      await expect(
        service.save('lisa', prompt, { memoryVaultItemIds: [MEM1, MEM2] }),
      ).rejects.toThrow(INVALID_MEMORIES);
      expect(myStoryResponse.update).not.toHaveBeenCalled();
      expect(myStoryResponse.upsert).not.toHaveBeenCalled();
      expect(myStoryMemoryLink.createMany).not.toHaveBeenCalled();
    });
  });

  describe('retired prompts (approved policy)', () => {
    const retired: MyStoryPrompt = {
      key: 'legacy.old-question',
      category: 'LEGACY',
      version: 3,
      prompt: 'An old question.',
      retired: true,
    };
    const withRetired = () => {
      (MY_STORY_PROMPTS as MyStoryPrompt[]).push(retired);
      return () => void (MY_STORY_PROMPTS as MyStoryPrompt[]).pop();
    };

    it('listed only while answered', async () => {
      const restore = withRetired();
      try {
        const { myStoryResponse, service } = setup();
        expect(
          (await service.listPrompts('lisa')).map((p) => p.key),
        ).not.toContain(retired.key);
        myStoryResponse.findMany.mockResolvedValue([
          dbRow({ promptKey: retired.key }),
        ]);
        expect(
          (await service.listPrompts('lisa', 'LEGACY')).map((p) => p.key),
        ).toEqual(['legacy.remembered', 'legacy.most-important', retired.key]);
      } finally {
        restore();
      }
    });

    it('GET prompt: answered → shown; unanswered → 404 like an unknown prompt', async () => {
      const { myStoryResponse, service } = setup();
      expect(await service.getPrompt('lisa', retired)).toMatchObject({
        answered: true,
      });
      myStoryResponse.findFirst.mockResolvedValue(null);
      await expect(service.getPrompt('lisa', retired)).rejects.toThrow(
        PROMPT_NOT_FOUND,
      );
    });

    it('an existing answer can be edited (wording kept) and deleted', async () => {
      const { myStoryResponse, service } = setup();
      await service.save('lisa', retired, { textContent: 'Edited.' });
      expect(myStoryResponse.update.mock.calls[0][0].data).toEqual({
        textContent: 'Edited.',
      });
      await service.remove('lisa', retired);
      expect(myStoryResponse.update.mock.calls[1][0].data.deletedAt).toEqual(
        expect.any(Date),
      );
    });

    it('no new answer and no re-answer after delete → 404, nothing written', async () => {
      const { myStoryResponse, service } = setup();
      myStoryResponse.findUnique.mockResolvedValue(null);
      await expect(
        service.save('lisa', retired, { textContent: text }),
      ).rejects.toThrow(PROMPT_NOT_FOUND);
      expect(myStoryResponse.upsert).not.toHaveBeenCalled();
    });
  });

  it('Lisa and John get separate rows for the same prompt', async () => {
    const { myStoryResponse, service } = setup();
    myStoryResponse.findUnique.mockResolvedValue(null);
    await service.save('lisa', prompt, { textContent: 'Lisa text' });
    await service.save('john', prompt, { textContent: 'John text' });
    const [lisa, john] = myStoryResponse.upsert.mock.calls.map((c) => c[0]);
    expect(lisa.where.ownerUserId_promptKey.ownerUserId).toBe('lisa');
    expect(john.where.ownerUserId_promptKey.ownerUserId).toBe('john');
  });

  it('DELETE soft-deletes the answer and its files, drops its links, then cleans the files up; none → 404', async () => {
    const { myStoryResponse, myStoryMemoryLink, cleanup, service } = setup();
    const media = [{ id: 'm1', storageKey: 'k' }];
    myStoryResponse.update.mockResolvedValue({ id: 'r1', mediaAssets: media });
    await service.remove('lisa', prompt);
    const { where, data, select } = myStoryResponse.update.mock.calls[0][0];
    expect(where).toEqual({ ownerUserId_promptKey: unique, deletedAt: null });
    const deletedAt = data.deletedAt;
    expect(deletedAt).toBeInstanceOf(Date);
    expect(data.mediaAssets).toEqual({
      updateMany: { where: { deletedAt: null }, data: { deletedAt } },
    });
    expect(select.mediaAssets.where).toEqual({ deletedAt });
    expect(myStoryMemoryLink.deleteMany).toHaveBeenCalledWith({
      where: { myStoryResponseId: 'r1' },
    });
    expect(cleanup.purge).toHaveBeenCalledWith('myStoryMediaAsset', media);
    myStoryResponse.update.mockRejectedValue(noMatch());
    await expect(service.remove('john', prompt)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('unexpected database errors are not turned into 404', async () => {
    const { myStoryResponse, service } = setup();
    const boom = new Error('connection lost');
    myStoryResponse.update.mockRejectedValue(boom);
    myStoryResponse.findFirst.mockRejectedValue(boom);
    myStoryResponse.findUnique.mockRejectedValue(boom);
    await expect(service.remove('lisa', prompt)).rejects.toBe(boom);
    await expect(service.getResponse('lisa', prompt)).rejects.toBe(boom);
    await expect(
      service.save('lisa', prompt, { textContent: text }),
    ).rejects.toBe(boom);
  });

  it('never logs the story text', async () => {
    const spies = [
      ...(['log', 'error', 'warn', 'debug', 'verbose'] as const).map((m) =>
        vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      ),
      ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      ),
    ];
    const { myStoryResponse, service } = setup();
    const secret = 'A deeply personal fictional sentence.';
    await service.save('lisa', prompt, { textContent: secret });
    myStoryResponse.update.mockRejectedValue(new Error('boom'));
    await service
      .save('lisa', prompt, { textContent: secret })
      .catch(() => undefined);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
      spy.mockRestore();
    }
  });
});

describe('MyStoryController guards', () => {
  it('requires a session and the CUSTOMER role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MyStoryController)).toEqual([
      SessionAuthGuard,
      CustomerGuard,
    ]);
  });

  it.each(['ADMIN', 'SUPER_ADMIN'])(
    'CustomerGuard rejects %s (403)',
    (role) => {
      const ctx = {
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as ExecutionContext;
      expect(new CustomerGuard().canActivate(ctx)).toBe(false);
    },
  );
});

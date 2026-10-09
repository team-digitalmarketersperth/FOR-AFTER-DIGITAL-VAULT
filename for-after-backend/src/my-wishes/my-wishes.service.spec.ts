import {
  BadRequestException,
  ConflictException,
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
import { TEXT_CONTENT_MAX } from '../messages/dto/create-message.dto.js';
import { PROMPT_KEY_PATTERN } from '../my-story/my-story.prompts.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  MyWishesPromptsQueryDto,
  SaveMyWishResponseDto,
} from './dto/save-my-wish-response.dto.js';
import {
  MyWishesController,
  WishPromptKeyPipe,
} from './my-wishes.controller.js';
import {
  getWishPromptByKey,
  MY_WISHES_CATEGORIES,
  MY_WISHES_PROMPTS,
} from './my-wishes.prompts.js';
import {
  DISCLAIMER_NOT_ACKNOWLEDGED,
  type MyWishesDisclaimerService,
} from './my-wishes-disclaimer.service.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
import {
  EMPTY_WISH,
  MyWishesService,
  WISH_NOT_FOUND,
} from './my-wishes.service.js';

const prompt = getWishPromptByKey('ceremony.style')!;
const text = 'A fictional wish.';
const wish = {
  id: 'w1',
  promptKey: 'ceremony.style',
  textContent: text as string | null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
// As selected: READY file count in _count, returned as mediaCount.
const row = { ...wish, _count: { mediaAssets: 0 } };
const answer = { ...wish, mediaCount: 0 };
const unique = { ownerUserId: 'lisa', promptKey: 'ceremony.style' };

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

// Any Prisma delegate other than myWishResponse (message, messageSchedule,
// memoryVaultItem, myStoryResponse, ...) throws, so a hidden side effect fails.
// $transaction runs its callback with the same guarded client.
const setup = () => {
  const myWishResponse = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(row),
    upsert: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue({ mediaAssets: [] }),
  };
  const prisma: object = new Proxy(
    { myWishResponse },
    {
      get(target, prop) {
        if (prop === 'myWishResponse') return target.myWishResponse;
        if (prop === '$transaction')
          return (fn: (tx: object) => unknown) => fn(prisma);
        throw new Error(`My Wishes must not use prisma.${String(prop)}`);
      },
    },
  );
  const cleanup = { purge: vi.fn().mockResolvedValue({}) };
  // Phase 15A: acknowledged unless a test says otherwise.
  const disclaimer = {
    assertAcknowledged: vi.fn().mockResolvedValue(undefined),
  };
  return {
    myWishResponse,
    disclaimer,
    cleanup,
    service: new MyWishesService(
      prisma as unknown as PrismaService,
      disclaimer as unknown as MyWishesDisclaimerService,
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

describe('My Wishes prompt catalogue', () => {
  it('has the V1 prompts with unique, well-formed keys and version 1', () => {
    const keys = MY_WISHES_PROMPTS.map((p) => p.key);
    expect(keys).toHaveLength(10);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of MY_WISHES_PROMPTS) {
      expect(p.key).toMatch(PROMPT_KEY_PATTERN);
      expect(MY_WISHES_CATEGORIES).toContain(p.category);
      expect(p.version).toBe(1);
      expect(p.prompt.trim()).not.toBe('');
    }
    expect(new Set(MY_WISHES_PROMPTS.map((p) => p.category))).toEqual(
      new Set(MY_WISHES_CATEGORIES),
    );
  });

  it('uses neutral, non-legal wording', () => {
    const copy = JSON.stringify(MY_WISHES_PROMPTS).toLowerCase();
    for (const word of [
      'legal',
      'binding',
      'will ',
      'executor',
      'directive',
      'mandatory',
      'instruction',
      'attorney',
    ]) {
      expect(copy).not.toContain(word);
    }
  });

  it('looks prompts up by key only', () => {
    expect(getWishPromptByKey('music-and-readings.music')?.category).toBe(
      'MUSIC_AND_READINGS',
    );
    expect(getWishPromptByKey('ceremony.unknown')).toBeUndefined();
    expect(getWishPromptByKey(prompt.prompt)).toBeUndefined();
    expect(getWishPromptByKey('0')).toBeUndefined();
    // My Story keys are not My Wishes keys.
    expect(getWishPromptByKey('legacy.remembered')).toBeUndefined();
  });
});

describe('WishPromptKeyPipe', () => {
  const pipe = new WishPromptKeyPipe();

  it('resolves a known key to the trusted definition', () => {
    expect(pipe.transform('ceremony.style')).toBe(prompt);
  });

  it('unknown but well-formed key → 404', () => {
    expect(() => pipe.transform('ceremony.unknown')).toThrow(NotFoundException);
  });

  it.each([
    '../../secret',
    'https://example.com',
    'ceremony/style',
    'Ceremony.Style',
    'ceremony',
    'ceremony..style',
    `a.${'b'.repeat(100)}`,
  ])('malformed key %j → 400', (key) => {
    expect(() => pipe.transform(key)).toThrow(BadRequestException);
  });
});

describe('SaveMyWishResponseDto', () => {
  it.each([
    { textContent: 'x' },
    { textContent: '  Simple and warm.  ' },
    { textContent: 'x'.repeat(TEXT_CONTENT_MAX) },
    { textContent: '<i>not html</i>' },
    // Phase 15B: omitted = unchanged, null = cleared (media-only wish).
    {},
    { textContent: null },
  ])('accepts %#', async (body) => {
    expect(await errorsFor(SaveMyWishResponseDto, body)).toEqual([]);
  });

  it.each([
    ['textContent', { textContent: '' }],
    ['textContent', { textContent: ' \n\t ' }],
    ['textContent', { textContent: 'x'.repeat(TEXT_CONTENT_MAX + 1) }],
    ['ownerUserId', { textContent: 'x', ownerUserId: 'john' }],
    ['promptVersion', { textContent: 'x', promptVersion: 9 }],
    ['promptTextSnapshot', { textContent: 'x', promptTextSnapshot: 'x' }],
    ['promptKey', { textContent: 'x', promptKey: 'ceremony.setting' }],
    ['recipientIds', { textContent: 'x', recipientIds: [] }],
    ['triggerType', { textContent: 'x', triggerType: 'ON_DEATH' }],
    [
      'acceptedLegalDisclaimer',
      { textContent: 'x', acceptedLegalDisclaimer: true },
    ],
  ])('rejects %s in %#', async (field, body) => {
    expect(await errorsFor(SaveMyWishResponseDto, body)).toContain(field);
  });

  it('does not change the text', () => {
    const raw = '  My wish.\n';
    expect(
      plainToInstance(SaveMyWishResponseDto, { textContent: raw }).textContent,
    ).toBe(raw);
  });
});

describe('MyWishesPromptsQueryDto', () => {
  it('accepts no filter or a known category, rejects others', async () => {
    expect(await errorsFor(MyWishesPromptsQueryDto, {})).toEqual([]);
    expect(
      await errorsFor(MyWishesPromptsQueryDto, { category: 'CEREMONY' }),
    ).toEqual([]);
    for (const category of ['ceremony', 'CHILDHOOD', 'LEGAL', '']) {
      expect(await errorsFor(MyWishesPromptsQueryDto, { category })).toEqual([
        'category',
      ]);
    }
  });
});

describe('MyWishesService: disclaimer gate (Phase 15A)', () => {
  it('a save checks the current acknowledgement first; without it nothing is written', async () => {
    const { myWishResponse, disclaimer, service } = setup();
    await service.save('lisa', prompt, 'A wish.');
    expect(disclaimer.assertAcknowledged).toHaveBeenCalledWith('lisa');
    expect(
      disclaimer.assertAcknowledged.mock.invocationCallOrder[0],
    ).toBeLessThan(myWishResponse.upsert.mock.invocationCallOrder[0]);
    disclaimer.assertAcknowledged.mockRejectedValue(
      new ConflictException(DISCLAIMER_NOT_ACKNOWLEDGED),
    );
    await expect(service.save('lisa', prompt, 'A wish.')).rejects.toThrow(
      DISCLAIMER_NOT_ACKNOWLEDGED,
    );
    expect(myWishResponse.upsert).toHaveBeenCalledTimes(1);
  });

  it('reading and deleting never need an acknowledgement', async () => {
    const { disclaimer, service } = setup();
    disclaimer.assertAcknowledged.mockRejectedValue(
      new Error('not acknowledged'),
    );
    await service.listPrompts('lisa');
    await service.getResponse('lisa', prompt).catch(() => undefined);
    await service.remove('lisa', prompt);
    expect(disclaimer.assertAcknowledged).not.toHaveBeenCalled();
  });
});

describe('MyWishesService', () => {
  it('lists every prompt with the owner’s live answers only', async () => {
    const { myWishResponse, service } = setup();
    myWishResponse.findMany.mockResolvedValue([row]);
    const list = await service.listPrompts('lisa');
    expect(list).toHaveLength(MY_WISHES_PROMPTS.length);
    const { where, select } = myWishResponse.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ ownerUserId: 'lisa', deletedAt: null });
    expect(select).not.toHaveProperty('ownerUserId');
    expect(select).not.toHaveProperty('deletedAt');
    expect(select).not.toHaveProperty('promptTextSnapshot');
    expect(list.find((p) => p.key === 'ceremony.style')).toMatchObject({
      answered: true,
      response: answer,
    });
    expect(list.find((p) => p.key === 'ceremony.setting')).toMatchObject({
      answered: false,
      response: null,
    });
  });

  it('filters by category', async () => {
    const { myWishResponse, service } = setup();
    const list = await service.listPrompts('lisa', 'CEREMONY');
    expect(list.map((p) => p.key)).toEqual([
      'ceremony.style',
      'ceremony.setting',
    ]);
    expect(myWishResponse.findMany.mock.calls[0][0].where.promptKey).toEqual({
      in: ['ceremony.style', 'ceremony.setting'],
    });
  });

  it('GET prompt / response: owner + key + live; unanswered → 404', async () => {
    const { myWishResponse, service } = setup();
    expect(await service.getResponse('lisa', prompt)).toEqual(answer);
    expect(myWishResponse.findFirst.mock.calls[0][0].where).toEqual({
      ...unique,
      deletedAt: null,
    });
    myWishResponse.findFirst.mockResolvedValue(null);
    await expect(service.getResponse('john', prompt)).rejects.toThrow(
      WISH_NOT_FOUND,
    );
    expect(myWishResponse.findFirst.mock.calls[1][0].where.ownerUserId).toBe(
      'john',
    );
    expect(await service.getPrompt('lisa', prompt)).toMatchObject({
      key: 'ceremony.style',
      answered: false,
      response: null,
    });
  });

  it('PUT: one owner-scoped upsert with the trusted snapshot; restores deleted', async () => {
    const { myWishResponse, service } = setup();
    expect(await service.save('lisa', prompt, text)).toEqual(answer);
    const args = myWishResponse.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ ownerUserId_promptKey: unique });
    const saved = {
      promptTextSnapshot:
        'How would you like your farewell or celebration of life to feel?',
      promptVersion: 1,
      textContent: text,
    };
    expect(args.create).toEqual({ ...unique, ...saved });
    expect(args.update).toEqual({ ...saved, deletedAt: null });
    expect(args.select).not.toHaveProperty('ownerUserId');
  });

  it('Lisa and John get separate rows for the same prompt', async () => {
    const { myWishResponse, service } = setup();
    await service.save('lisa', prompt, 'Lisa text');
    await service.save('john', prompt, 'John text');
    const [lisa, john] = myWishResponse.upsert.mock.calls.map((c) => c[0]);
    expect(lisa.where.ownerUserId_promptKey.ownerUserId).toBe('lisa');
    expect(lisa.create.ownerUserId).toBe('lisa');
    expect(john.where.ownerUserId_promptKey.ownerUserId).toBe('john');
    expect(john.create.ownerUserId).toBe('john');
  });

  it('DELETE soft-deletes the live answer and its files, then purges them; none → 404', async () => {
    const { myWishResponse, cleanup, service } = setup();
    const file = { id: 'f1', storageKey: 'k' };
    myWishResponse.update.mockResolvedValue({ mediaAssets: [file] });
    await service.remove('lisa', prompt);
    const { where, data } = myWishResponse.update.mock.calls[0][0];
    expect(where).toEqual({ ownerUserId_promptKey: unique, deletedAt: null });
    expect(data).toEqual({
      deletedAt: expect.any(Date),
      mediaAssets: {
        updateMany: {
          where: { deletedAt: null },
          data: { deletedAt: data.deletedAt },
        },
      },
    });
    expect(cleanup.purge).toHaveBeenCalledWith('myWishMediaAsset', [file]);
    cleanup.purge.mockClear();
    myWishResponse.update.mockRejectedValue(noMatch());
    await expect(service.remove('john', prompt)).rejects.toThrow(
      NotFoundException,
    );
    expect(cleanup.purge).not.toHaveBeenCalled();
  });

  it('Phase 15B: a wish with files only is an answer; with nothing it is refused', async () => {
    const { myWishResponse, service } = setup();
    const mediaOnly = {
      ...row,
      textContent: null,
      _count: { mediaAssets: 2 },
    };
    myWishResponse.upsert.mockResolvedValue(mediaOnly);
    expect(await service.save('lisa', prompt, null)).toMatchObject({
      textContent: null,
      mediaCount: 2,
    });
    // Omitted text = unchanged on update.
    await service.save('lisa', prompt, undefined);
    expect(myWishResponse.upsert.mock.calls[1][0].update.textContent).toBe(
      undefined,
    );
    myWishResponse.upsert.mockResolvedValue({
      ...mediaOnly,
      _count: { mediaAssets: 0 },
    });
    await expect(service.save('lisa', prompt, null)).rejects.toThrow(
      new BadRequestException(EMPTY_WISH),
    );
  });

  it('Phase 15B: an upload shell (no text, no READY file) is never shown as an answer', async () => {
    const { myWishResponse, service } = setup();
    const shell = { ...row, textContent: null };
    myWishResponse.findMany.mockResolvedValue([shell]);
    myWishResponse.findFirst.mockResolvedValue(shell);
    const list = await service.listPrompts('lisa');
    expect(list.find((p) => p.key === prompt.key)).toMatchObject({
      answered: false,
      response: null,
    });
    await expect(service.getResponse('lisa', prompt)).rejects.toThrow(
      WISH_NOT_FOUND,
    );
  });

  it('unexpected database errors are not turned into 404', async () => {
    const { myWishResponse, service } = setup();
    const boom = new Error('connection lost');
    myWishResponse.update.mockRejectedValue(boom);
    myWishResponse.findFirst.mockRejectedValue(boom);
    myWishResponse.upsert.mockRejectedValue(boom);
    await expect(service.remove('lisa', prompt)).rejects.toBe(boom);
    await expect(service.getResponse('lisa', prompt)).rejects.toBe(boom);
    await expect(service.save('lisa', prompt, text)).rejects.toBe(boom);
  });

  it('never creates Messages, schedules or other records (only MyWishResponse)', async () => {
    // setup() throws on any other Prisma delegate.
    const { service } = setup();
    await service.save('lisa', prompt, text);
    await service.listPrompts('lisa');
    await service.getPrompt('lisa', prompt);
    await service.getResponse('lisa', prompt);
    await service.remove('lisa', prompt);
  });

  it('never logs the wish text', async () => {
    const spies = [
      ...(['log', 'error', 'warn', 'debug', 'verbose'] as const).map((m) =>
        vi.spyOn(Logger.prototype, m).mockImplementation(() => undefined),
      ),
      ...(['log', 'error', 'warn', 'info', 'debug'] as const).map((m) =>
        vi.spyOn(console, m).mockImplementation(() => undefined),
      ),
    ];
    const { myWishResponse, service } = setup();
    const secret = 'A deeply personal fictional wish.';
    await service.save('lisa', prompt, secret);
    myWishResponse.upsert.mockRejectedValue(new Error('boom'));
    await service.save('lisa', prompt, secret).catch(() => undefined);
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
      spy.mockRestore();
    }
  });
});

describe('MyWishesController guards', () => {
  it('requires a session and the CUSTOMER role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MyWishesController)).toEqual([
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

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
import { TEXT_CONTENT_MAX } from '../messages/dto/create-message.dto.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  MyStoryPromptsQueryDto,
  SaveMyStoryResponseDto,
} from './dto/save-my-story-response.dto.js';
import { MyStoryController, PromptKeyPipe } from './my-story.controller.js';
import {
  getPromptByKey,
  MY_STORY_CATEGORIES,
  MY_STORY_PROMPTS,
  PROMPT_KEY_PATTERN,
} from './my-story.prompts.js';
import { MyStoryService, RESPONSE_NOT_FOUND } from './my-story.service.js';

const prompt = getPromptByKey('legacy.remembered')!;
const text = 'A fictional answer.';
const row = {
  id: 'r1',
  promptKey: 'legacy.remembered',
  textContent: text,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const unique = { ownerUserId: 'lisa', promptKey: 'legacy.remembered' };

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

const setup = () => {
  const myStoryResponse = {
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn().mockResolvedValue(row),
    upsert: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue({ id: 'r1' }),
  };
  return {
    myStoryResponse,
    service: new MyStoryService({
      myStoryResponse,
    } as unknown as PrismaService),
  };
};

const errorsFor = async (cls: new () => object, body: object) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe('My Story prompt catalogue', () => {
  it('has the V1 prompts with unique, well-formed keys and version 1', () => {
    const keys = MY_STORY_PROMPTS.map((p) => p.key);
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(keys.length);
    for (const p of MY_STORY_PROMPTS) {
      expect(p.key).toMatch(PROMPT_KEY_PATTERN);
      expect(MY_STORY_CATEGORIES).toContain(p.category);
      expect(p.version).toBe(1);
      expect(p.prompt.trim()).not.toBe('');
    }
    // Every category has at least one prompt.
    expect(new Set(MY_STORY_PROMPTS.map((p) => p.category))).toEqual(
      new Set(MY_STORY_CATEGORIES),
    );
  });

  it('looks prompts up by key only', () => {
    expect(getPromptByKey('childhood.earliest-memory')?.prompt).toBe(
      'What is one of your earliest memories?',
    );
    expect(getPromptByKey('nope.unknown')).toBeUndefined();
    expect(getPromptByKey('What has love taught you?')).toBeUndefined();
    expect(getPromptByKey('0')).toBeUndefined();
  });
});

describe('PromptKeyPipe', () => {
  const pipe = new PromptKeyPipe();

  it('resolves a known key to the trusted definition', () => {
    expect(pipe.transform('legacy.remembered')).toBe(prompt);
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

describe('SaveMyStoryResponseDto', () => {
  it.each([
    { textContent: 'x' },
    { textContent: '  Kept with its spaces.  ' },
    { textContent: 'a\n\nb' },
    { textContent: 'x'.repeat(TEXT_CONTENT_MAX) },
    { textContent: '<script>alert(1)</script>' },
  ])('accepts %#', async (body) => {
    expect(await errorsFor(SaveMyStoryResponseDto, body)).toEqual([]);
  });

  it.each([
    ['textContent', {}],
    ['textContent', { textContent: '' }],
    ['textContent', { textContent: '   \n\t ' }],
    ['textContent', { textContent: null }],
    ['textContent', { textContent: 42 }],
    ['textContent', { textContent: 'x'.repeat(TEXT_CONTENT_MAX + 1) }],
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
  it('accepts no filter or a known category, rejects others', async () => {
    expect(await errorsFor(MyStoryPromptsQueryDto, {})).toEqual([]);
    expect(
      await errorsFor(MyStoryPromptsQueryDto, { category: 'CHILDHOOD' }),
    ).toEqual([]);
    for (const category of ['childhood', 'RECIPES', '']) {
      expect(await errorsFor(MyStoryPromptsQueryDto, { category })).toEqual([
        'category',
      ]);
    }
  });
});

describe('MyStoryService', () => {
  it('lists every prompt with the owner’s live answers only', async () => {
    const { myStoryResponse, service } = setup();
    myStoryResponse.findMany.mockResolvedValue([row]);
    const list = await service.listPrompts('lisa');
    expect(list).toHaveLength(MY_STORY_PROMPTS.length);
    const { where, select } = myStoryResponse.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ ownerUserId: 'lisa', deletedAt: null });
    expect(select).not.toHaveProperty('ownerUserId');
    expect(select).not.toHaveProperty('deletedAt');
    expect(select).not.toHaveProperty('promptTextSnapshot');
    expect(list.find((p) => p.key === 'legacy.remembered')).toMatchObject({
      answered: true,
      response: row,
    });
    expect(list.find((p) => p.key === 'childhood.home')).toMatchObject({
      answered: false,
      response: null,
    });
  });

  it('filters by category', async () => {
    const { myStoryResponse, service } = setup();
    const list = await service.listPrompts('lisa', 'CHILDHOOD');
    expect(list.map((p) => p.key)).toEqual([
      'childhood.earliest-memory',
      'childhood.home',
    ]);
    expect(myStoryResponse.findMany.mock.calls[0][0].where.promptKey).toEqual({
      in: ['childhood.earliest-memory', 'childhood.home'],
    });
  });

  it('GET prompt / response: owner + key + live; unanswered → 404', async () => {
    const { myStoryResponse, service } = setup();
    expect(await service.getResponse('lisa', prompt)).toBe(row);
    expect(myStoryResponse.findFirst.mock.calls[0][0].where).toEqual({
      ...unique,
      deletedAt: null,
    });
    myStoryResponse.findFirst.mockResolvedValue(null);
    await expect(service.getResponse('john', prompt)).rejects.toThrow(
      RESPONSE_NOT_FOUND,
    );
    expect(myStoryResponse.findFirst.mock.calls[1][0].where.ownerUserId).toBe(
      'john',
    );
    expect(await service.getPrompt('lisa', prompt)).toMatchObject({
      key: 'legacy.remembered',
      answered: false,
      response: null,
    });
  });

  it('PUT: one owner-scoped upsert with the trusted snapshot; restores deleted', async () => {
    const { myStoryResponse, service } = setup();
    expect(await service.save('lisa', prompt, text)).toBe(row);
    const args = myStoryResponse.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ ownerUserId_promptKey: unique });
    const answer = {
      promptTextSnapshot: 'How would you like to be remembered?',
      promptVersion: 1,
      textContent: text,
    };
    expect(args.create).toEqual({ ...unique, ...answer });
    expect(args.update).toEqual({ ...answer, deletedAt: null });
    expect(args.select).not.toHaveProperty('ownerUserId');
  });

  it('PUT: the owner and snapshot never come from the client', async () => {
    const { myStoryResponse, service } = setup();
    // Even if a DTO carried extra fields, only the text is passed in.
    await service.save('john', prompt, text);
    const { where, create } = myStoryResponse.upsert.mock.calls[0][0];
    expect(where.ownerUserId_promptKey.ownerUserId).toBe('john');
    expect(create.ownerUserId).toBe('john');
    expect(create.promptTextSnapshot).toBe(prompt.prompt);
    expect(create.promptVersion).toBe(prompt.version);
  });

  it('Lisa and John get separate rows for the same prompt', async () => {
    const { myStoryResponse, service } = setup();
    await service.save('lisa', prompt, 'Lisa text');
    await service.save('john', prompt, 'John text');
    const [lisa, john] = myStoryResponse.upsert.mock.calls.map((c) => c[0]);
    expect(lisa.where.ownerUserId_promptKey.ownerUserId).toBe('lisa');
    expect(john.where.ownerUserId_promptKey.ownerUserId).toBe('john');
  });

  it('DELETE soft-deletes the live answer; none → 404', async () => {
    const { myStoryResponse, service } = setup();
    await service.remove('lisa', prompt);
    const { where, data } = myStoryResponse.update.mock.calls[0][0];
    expect(where).toEqual({ ownerUserId_promptKey: unique, deletedAt: null });
    expect(data).toEqual({ deletedAt: expect.any(Date) });
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
    myStoryResponse.upsert.mockRejectedValue(boom);
    await expect(service.remove('lisa', prompt)).rejects.toBe(boom);
    await expect(service.getResponse('lisa', prompt)).rejects.toBe(boom);
    await expect(service.save('lisa', prompt, text)).rejects.toBe(boom);
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
    await service.save('lisa', prompt, secret);
    myStoryResponse.upsert.mockRejectedValue(new Error('boom'));
    await service.save('lisa', prompt, secret).catch(() => undefined);
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

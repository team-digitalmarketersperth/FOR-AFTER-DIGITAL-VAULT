import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CreateMessageDto } from './dto/create-message.dto.js';
import { UpdateMessageDto } from './dto/update-message.dto.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
import {
  MessagesService,
  TEXT_PREVIEW_MAX,
  textPreview,
} from './messages.service.js';

const sofia = {
  id: 'r1',
  firstName: 'Sofia',
  lastName: 'Smith',
  relationship: 'Daughter',
};
const row = {
  id: 'm1',
  title: 'For Sofia',
  contentType: 'TEXT',
  textContent: 'Fictional text.',
  status: 'DRAFT',
  createdAt: new Date(),
  updatedAt: new Date(),
  recipients: [{ recipient: sofia }],
};

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

// `owned` = how many of the requested recipients belong to the owner.
const setup = (owned = 1) => {
  const message = {
    create: vi.fn().mockResolvedValue(row),
    findMany: vi.fn().mockResolvedValue([row]),
    findFirst: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
    count: vi.fn().mockResolvedValue(0),
  };
  const recipient = { count: vi.fn().mockResolvedValue(owned) };
  // The media cleanup (file purge); named storage for the assertions below.
  const storage = {
    purge: vi.fn().mockResolvedValue({ purged: 0, failed: 0 }),
  };
  const prisma = {
    message,
    recipient,
    // Array form: run the queries as given.
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return {
    message,
    recipient,
    storage,
    service: new MessagesService(
      prisma as unknown as PrismaService,
      storage as unknown as MediaCleanup,
    ),
  };
};

const ownedBy = (ownerUserId: string, id: string) => ({
  id,
  ownerUserId,
  deletedAt: null,
});
const draft = (ownerUserId: string, id: string) => ({
  ...ownedBy(ownerUserId, id),
  status: 'DRAFT',
});

const create = {
  title: 'For Sofia',
  textContent: 'Fictional text.',
  recipientIds: ['r1'],
};

const uuid1 = '0b7a3f6e-2d4c-4b8a-9f1e-3c5d7e9f1a2b';
const uuid2 = '1c8b4a7f-3e5d-4c9b-8a2f-4d6e8f0a2b3c';
const valid = {
  title: 'For Sofia',
  contentType: 'TEXT',
  textContent: 'I love you.',
  recipientIds: [uuid1],
};

// Same options as the global ValidationPipe.
const errorsFor = async (cls: typeof CreateMessageDto, body: object) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

describe('CreateMessageDto', () => {
  it.each([
    valid,
    { ...valid, contentType: undefined },
    // Drafts may be incomplete: media types without text, blank text.
    { title: 'A photo', contentType: 'PHOTO', recipientIds: [uuid1] },
    { title: 'Voice', contentType: 'AUDIO', recipientIds: [uuid1] },
    { ...valid, contentType: 'MIXED' },
    { ...valid, textContent: null },
    { ...valid, textContent: '   ' },
  ])('accepts %o', async (body) => {
    expect(await errorsFor(CreateMessageDto, body)).toEqual([]);
  });

  it('trims outer whitespace but keeps inner formatting', () => {
    const dto = plainToInstance(CreateMessageDto, {
      ...valid,
      textContent: '  Line 1\n\n  Line 2  ',
    });
    expect(dto.textContent).toBe('Line 1\n\n  Line 2');
  });

  it('blank text becomes null (no text)', () => {
    const dto = plainToInstance(CreateMessageDto, {
      ...valid,
      textContent: ' \n ',
    });
    expect(dto.textContent).toBeNull();
  });

  it.each([
    ['title', { title: '   ' }],
    ['title', { title: null }],
    ['title', { title: 'x'.repeat(201) }],
    ['textContent', { textContent: 'x'.repeat(20_001) }],
    ['textContent', { textContent: 42 }],
    ['recipientIds', { recipientIds: [] }],
    ['recipientIds', { recipientIds: null }],
    ['recipientIds', { recipientIds: [uuid1, uuid1] }],
    ['recipientIds', { recipientIds: [uuid1, uuid1.toUpperCase()] }],
    ['recipientIds', { recipientIds: ['not-a-uuid'] }],
    ['ownerUserId', { ownerUserId: uuid2 }],
    ['status', { status: 'RELEASED' }],
    ['somethingElse', { somethingElse: 1 }],
    ['contentType', { contentType: 'DOCUMENT' }],
    ['contentType', { contentType: 'video' }],
    ['contentType', { contentType: 'text' }],
    ['contentType', { contentType: null }],
  ])('rejects %s in %o', async (field, patch) => {
    expect(await errorsFor(CreateMessageDto, { ...valid, ...patch })).toContain(
      field,
    );
  });
});

describe('UpdateMessageDto', () => {
  const errors = (body: object) =>
    errorsFor(UpdateMessageDto as typeof CreateMessageDto, body);

  it('accepts partial bodies', async () => {
    expect(await errors({})).toEqual([]);
    expect(await errors({ title: 'New' })).toEqual([]);
    expect(await errors({ recipientIds: [uuid1, uuid2] })).toEqual([]);
    // VIDEO since Phase 12.
    for (const contentType of ['TEXT', 'PHOTO', 'AUDIO', 'VIDEO', 'MIXED']) {
      expect(await errors({ contentType })).toEqual([]);
    }
    expect(await errors({ textContent: null })).toEqual([]);
  });

  it('missing textContent stays undefined (unchanged); null clears', () => {
    const cls = UpdateMessageDto as typeof CreateMessageDto;
    expect(plainToInstance(cls, { title: 'x' }).textContent).toBeUndefined();
    expect(plainToInstance(cls, { textContent: null }).textContent).toBeNull();
  });

  it.each([
    ['title', { title: null }],
    ['contentType', { contentType: null }],
    ['recipientIds', { recipientIds: [] }],
    ['recipientIds', { recipientIds: null }],
    ['recipientIds', { recipientIds: [uuid1, uuid1] }],
    ['status', { status: 'RELEASED' }],
    ['ownerUserId', { ownerUserId: uuid2 }],
    ['contentType', { contentType: 'DOCUMENT' }],
  ])('rejects %s in %o', async (field, body) => {
    expect(await errors(body)).toContain(field);
  });
});

describe('MessagesService', () => {
  it('create: owner from the argument, always DRAFT + TEXT, one nested (transactional) write', async () => {
    const { message, service } = setup();
    await service.create('owner-a', {
      ...create,
      // Smuggled fields (the ValidationPipe rejects these first in HTTP).
      ...({ ownerUserId: 'owner-b', status: 'RELEASED' } as object),
    });
    expect(message.create).toHaveBeenCalledTimes(1);
    const { data } = message.create.mock.calls[0][0];
    expect(data).toEqual({
      ownerUserId: 'owner-a',
      title: 'For Sofia',
      textContent: 'Fictional text.',
      contentType: 'TEXT',
      status: 'DRAFT',
      recipients: { create: [{ recipientId: 'r1' }] },
    });
  });

  it.each(['PHOTO', 'AUDIO', 'MIXED'] as const)(
    'create %s draft without media or text',
    async (contentType) => {
      const { message, service } = setup();
      await service.create('owner-a', {
        title: 'Draft',
        contentType,
        recipientIds: ['r1'],
      });
      const { data } = message.create.mock.calls[0][0];
      expect(data).toMatchObject({ contentType, textContent: null });
      expect(data.status).toBe('DRAFT');
    },
  );

  it('create with several owned recipients assigns each once', async () => {
    const { message, recipient, service } = setup(2);
    await service.create('owner-a', { ...create, recipientIds: ['r1', 'r2'] });
    expect(recipient.count).toHaveBeenCalledWith({
      where: {
        id: { in: ['r1', 'r2'] },
        ownerUserId: 'owner-a',
        deletedAt: null,
      },
    });
    expect(message.create.mock.calls[0][0].data.recipients.create).toEqual([
      { recipientId: 'r1' },
      { recipientId: 'r2' },
    ]);
  });

  // Another owner's, deleted and unknown recipients all fail the owner-scoped
  // count, so none is created and the error is the same generic 400.
  it.each([
    ['another user’s recipient', ['r-john'], 0],
    ['a deleted recipient', ['r-deleted'], 0],
    ['an unknown recipient', ['r-missing'], 0],
    ['a mix of own and foreign', ['r1', 'r-john'], 1],
  ])('create rejects %s without writing', async (_, recipientIds, owned) => {
    const { message, service } = setup(owned);
    await expect(
      service.create('owner-a', { ...create, recipientIds }),
    ).rejects.toThrow(
      new BadRequestException('One or more recipients are invalid.'),
    );
    expect(message.create).not.toHaveBeenCalled();
  });

  it('lists one page of the owner’s live messages, newest first, as summaries', async () => {
    const { message, service } = setup();
    const { createdAt: _, ...summaryRow } = row;
    message.findMany.mockResolvedValue([summaryRow]);
    message.count.mockResolvedValue(30);
    const res = await service.findPageForOwner('owner-a', 2, 10);
    const where = { ownerUserId: 'owner-a', deletedAt: null };
    const args = message.findMany.mock.calls[0][0];
    expect(args).toMatchObject({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: 10,
      take: 10,
    });
    expect(message.count).toHaveBeenCalledWith({ where });
    for (const hidden of [
      'ownerUserId',
      'deletedAt',
      'mediaAssets',
      'createdAt',
    ]) {
      expect(args.select).not.toHaveProperty(hidden);
    }
    expect(res.pagination).toEqual({ page: 2, limit: 10, total: 30, pages: 3 });
    expect(res.items[0]).toEqual({
      id: 'm1',
      title: 'For Sofia',
      contentType: 'TEXT',
      status: 'DRAFT',
      updatedAt: expect.any(Date),
      textPreview: 'Fictional text.',
      recipients: [sofia],
    });
    expect(res.items[0]).not.toHaveProperty('textContent');
  });

  it('textPreview keeps short text, cuts long text without splitting emoji', () => {
    expect(textPreview(null)).toBeNull();
    expect(textPreview('Short.')).toBe('Short.');
    const exact = 'a'.repeat(TEXT_PREVIEW_MAX);
    expect(textPreview(exact)).toBe(exact);
    expect(textPreview('a'.repeat(TEXT_PREVIEW_MAX + 1))).toBe(`${exact}…`);
    // 200 emoji = 400 code units but 200 characters: not cut.
    const emoji = '💛'.repeat(TEXT_PREVIEW_MAX);
    expect(textPreview(emoji)).toBe(emoji);
    expect(textPreview(`${emoji}x`)).toBe(`${emoji}…`);
  });

  it('findOwnedById is owner-scoped and returns a safe shape', async () => {
    const { message, service } = setup();
    const res = await service.findOwnedById('owner-a', 'm1');
    const { where, select } = message.findFirst.mock.calls[0][0];
    expect(where).toEqual(ownedBy('owner-a', 'm1'));
    expect(select).not.toHaveProperty('ownerUserId');
    expect(select).not.toHaveProperty('deletedAt');
    expect(res).not.toHaveProperty('ownerUserId');
    expect(res).not.toHaveProperty('deletedAt');
    expect(res.recipients).toEqual([sofia]);
  });

  it('findOwnedById: another owner’s or a deleted message is 404', async () => {
    const { message, service } = setup();
    message.findFirst.mockResolvedValue(null);
    await expect(service.findOwnedById('owner-b', 'm1')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('update title/text is one owner-scoped, DRAFT-only write', async () => {
    const { message, recipient, service } = setup();
    await service.update('owner-a', 'm1', {
      title: 'New',
      textContent: 'New text',
    });
    const { where, data } = message.update.mock.calls[0][0];
    expect(where).toEqual(draft('owner-a', 'm1'));
    expect(data).toEqual({
      title: 'New',
      textContent: 'New text',
      recipients: undefined,
    });
    expect(recipient.count).not.toHaveBeenCalled();
  });

  it.each([
    ['TEXT → PHOTO', 'PHOTO'],
    ['PHOTO → AUDIO', 'AUDIO'],
    ['AUDIO → MIXED', 'MIXED'],
  ] as const)(
    'update changes contentType %s and never touches media',
    async (_, contentType) => {
      const { message, service } = setup();
      await service.update('owner-a', 'm1', { contentType });
      const { data } = message.update.mock.calls[0][0];
      expect(data.contentType).toBe(contentType);
      expect(data).not.toHaveProperty('mediaAssets');
      expect(data.textContent).toBeUndefined();
    },
  );

  it('update: textContent null clears, missing leaves it unchanged', async () => {
    const { message, service } = setup();
    await service.update('owner-a', 'm1', { textContent: null });
    expect(message.update.mock.calls[0][0].data.textContent).toBeNull();
    await service.update('owner-a', 'm1', { title: 'Only title' });
    const { data } = message.update.mock.calls[1][0];
    expect(data.textContent).toBeUndefined();
    expect(data.contentType).toBeUndefined();
  });

  it('update replaces assignments in the same write', async () => {
    const { message, service } = setup(2);
    await service.update('owner-a', 'm1', { recipientIds: ['r1', 'r2'] });
    expect(message.update.mock.calls[0][0].data.recipients).toEqual({
      deleteMany: {},
      create: [{ recipientId: 'r1' }, { recipientId: 'r2' }],
    });
  });

  it('update with an invalid recipient changes nothing', async () => {
    const { message, service } = setup(0);
    await expect(
      service.update('owner-a', 'm1', { recipientIds: ['r-john'] }),
    ).rejects.toThrow(BadRequestException);
    expect(message.update).not.toHaveBeenCalled();
  });

  it('cross-user update and delete are 404', async () => {
    const { message, service } = setup();
    message.update.mockRejectedValue(noMatch());
    await expect(
      service.update('owner-b', 'm1', { title: 'X' }),
    ).rejects.toThrow(NotFoundException);
    await expect(service.remove('owner-b', 'm1')).rejects.toThrow(
      NotFoundException,
    );
    expect(message.count).toHaveBeenCalledWith({
      where: ownedBy('owner-b', 'm1'),
    });
  });

  it('an owned message that is not DRAFT is 409 on update and delete', async () => {
    const { message, service } = setup();
    message.update.mockRejectedValue(noMatch());
    message.count.mockResolvedValue(1);
    await expect(
      service.update('owner-a', 'm1', { title: 'X' }),
    ).rejects.toThrow(ConflictException);
    await expect(service.remove('owner-a', 'm1')).rejects.toThrow(
      ConflictException,
    );
  });

  it('remove soft-deletes an owned draft and its live media in one write', async () => {
    const { message, storage, service } = setup();
    message.update.mockResolvedValue({ mediaAssets: [] });
    await service.remove('owner-a', 'm1');
    const { where, data, select } = message.update.mock.calls[0][0];
    expect(where).toEqual(draft('owner-a', 'm1'));
    const deletedAt = data.deletedAt;
    expect(deletedAt).toBeInstanceOf(Date);
    expect(data.mediaAssets).toEqual({
      updateMany: { where: { deletedAt: null }, data: { deletedAt } },
    });
    expect(select.mediaAssets.where).toEqual({ deletedAt });
    expect(storage.purge).toHaveBeenCalledWith('mediaAsset', []);
  });

  it('remove purges exactly the media it hid', async () => {
    const { message, storage, service } = setup();
    const hidden = [
      { id: 'p1', storageKey: '/for-after/u/messages/m1/photo/p1.jpg' },
      { id: 'a1', storageKey: '/for-after/u/messages/m1/audio/a1.mp3' },
    ];
    message.update.mockResolvedValue({ mediaAssets: hidden });
    await expect(service.remove('owner-a', 'm1')).resolves.toBeUndefined();
    expect(storage.purge).toHaveBeenCalledWith('mediaAsset', hidden);
  });

  it('remove of a missing/foreign/non-draft message touches no storage', async () => {
    const { message, storage, service } = setup();
    message.update.mockRejectedValue(noMatch());
    await expect(service.remove('owner-a', 'm1')).rejects.toThrow(
      NotFoundException,
    );
    expect(storage.purge).not.toHaveBeenCalled();
  });

  it('does not turn unexpected database errors into 404s', async () => {
    const { message, service } = setup();
    message.update.mockRejectedValue(new Error('boom'));
    await expect(service.remove('owner-a', 'm1')).rejects.toThrow('boom');
    message.create.mockRejectedValue(new Error('boom'));
    await expect(service.create('owner-a', create)).rejects.toThrow('boom');
    expect(message.count).not.toHaveBeenCalled();
  });
});

import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { Prisma } from '../generated/prisma/client.js';
import type { MediaCleanup } from '../media/media-cleanup.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  CreateMemoryVaultItemDto,
  MemoryVaultQueryDto,
  normalizeTag,
} from './dto/create-memory-vault-item.dto.js';
import { UpdateMemoryVaultItemDto } from './dto/update-memory-vault-item.dto.js';
import { MemoryVaultController } from './memory-vault.controller.js';
import {
  MEMORY_NOT_FOUND,
  MemoryVaultService,
} from './memory-vault.service.js';

const tagRow = { tag: { id: 't1', name: 'Family' } };
const row = {
  id: 'v1',
  title: 'Christmas With My Family',
  category: 'FAMILY',
  textContent: 'A fictional memory.',
  createdAt: new Date(),
  updatedAt: new Date(),
  tags: [tagRow],
};
// What the API returns: tags flattened to { id, name }.
const response = { ...row, tags: [tagRow.tag] };
const owned = { id: 'v1', ownerUserId: 'owner-a', deletedAt: null };

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

const query = (q: object = {}) =>
  plainToInstance(MemoryVaultQueryDto, q) as MemoryVaultQueryDto;

const setup = () => {
  const memoryVaultItem = {
    create: vi.fn().mockResolvedValue(row),
    findMany: vi.fn().mockResolvedValue([row]),
    findFirst: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
    count: vi.fn().mockResolvedValue(1),
  };
  const memoryVaultTag = {
    createMany: vi.fn().mockResolvedValue({ count: 0 }),
    findMany: vi.fn().mockResolvedValue([{ id: 't1' }, { id: 't2' }]),
  };
  const tx = { memoryVaultItem, memoryVaultTag };
  // Array form = the list's count + page; function form = interactive.
  const $transaction = vi.fn((arg: unknown) =>
    Array.isArray(arg)
      ? Promise.all(arg)
      : (arg as (t: typeof tx) => unknown)(tx),
  );
  const cleanup = {
    purge: vi.fn().mockResolvedValue({ purged: 0, failed: 0 }),
  };
  return {
    memoryVaultItem,
    memoryVaultTag,
    $transaction,
    cleanup,
    service: new MemoryVaultService(
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
const create = { title: 'My First Trip to Perth', category: 'TRAVEL' };

describe('CreateMemoryVaultItemDto', () => {
  it.each([
    create,
    { ...create, textContent: 'A fictional memory.' },
    { ...create, textContent: null },
    { ...create, category: 'LOVE_STORIES' },
    { ...create, tags: [] },
    { ...create, tags: ['Family', 'Road trips'] },
    { ...create, tags: Array.from({ length: 20 }, (_, i) => `t${i}`) },
  ])('accepts %o', async (body) => {
    expect(await errorsFor(CreateMemoryVaultItemDto, body)).toEqual([]);
  });

  it.each([
    ['title', { title: undefined }],
    ['title', { title: '   ' }],
    ['title', { title: 'x'.repeat(201) }],
    ['category', { category: undefined }],
    ['category', { category: 'PETS' }],
    ['category', { category: 'family' }],
    ['ownerUserId', { ownerUserId: 'owner-b' }],
    ['deletedAt', { deletedAt: null }],
    ['recipientIds', { recipientIds: [] }],
    ['status', { status: 'DRAFT' }],
    ['contentType', { contentType: 'TEXT' }],
    ['imageUrl', { imageUrl: 'https://example.test/a.jpg' }],
    ['tags', { tags: null }],
    ['tags', { tags: 'family' }],
    ['tags', { tags: ['   '] }],
    ['tags', { tags: [42] }],
    ['tags', { tags: ['x'.repeat(51)] }],
    ['tags', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }],
    ['tagIds', { tagIds: ['t1'] }],
  ])('rejects %s in %o', async (field, patch) => {
    expect(
      await errorsFor(CreateMemoryVaultItemDto, { ...create, ...patch }),
    ).toContain(field);
  });

  it('trims the title, stores blank text as null, tidies tag spacing', () => {
    const dto = plainToInstance(CreateMemoryVaultItemDto, {
      ...create,
      title: '  Perth  ',
      textContent: '   ',
      tags: ['  Road   trips '],
    });
    expect(dto.title).toBe('Perth');
    expect(dto.textContent).toBeNull();
    expect(dto.tags).toEqual(['Road trips']);
  });

  it('normalizes tag names to one logical tag', () => {
    expect(['Family', ' family ', 'FAMILY'].map(normalizeTag)).toEqual([
      'family',
      'family',
      'family',
    ]);
    expect(normalizeTag('Road   Trips')).toBe('road trips');
    expect(normalizeTag('families')).not.toBe(normalizeTag('family'));
  });
});

describe('UpdateMemoryVaultItemDto', () => {
  it.each([
    {},
    { textContent: null },
    { category: 'CHILDHOOD' },
    { tags: [] },
    { tags: ['Family'] },
  ])('accepts %o', async (body) => {
    expect(await errorsFor(UpdateMemoryVaultItemDto, body)).toEqual([]);
  });

  it.each([
    ['title', { title: null }],
    ['title', { title: ' ' }],
    ['category', { category: null }],
    ['category', { category: 'VIDEO' }],
    ['mediaAssets', { mediaAssets: [] }],
    ['storageKey', { storageKey: 'x' }],
    ['createdAt', { createdAt: '2020-01-01' }],
    ['tags', { tags: null }],
    ['tags', { tags: [''] }],
  ])('rejects %s in %o', async (field, body) => {
    expect(await errorsFor(UpdateMemoryVaultItemDto, body)).toContain(field);
  });
});

describe('MemoryVaultQueryDto', () => {
  it('defaults to page 1 of 25, like Recipients and Messages', () => {
    expect(query()).toMatchObject({ page: 1, limit: 25 });
    expect(query({ page: '3', limit: '10' })).toMatchObject({
      page: 3,
      limit: 10,
    });
  });

  it.each([
    {},
    { category: 'RECIPES' },
    { page: '2', limit: '100' },
    { search: 'holiday', tag: 'family' },
    { search: '   ', tag: '  ' },
  ])('accepts %o', async (q) => {
    expect(await errorsFor(MemoryVaultQueryDto, q)).toEqual([]);
  });

  it.each([
    ['category', { category: 'NOPE' }],
    ['page', { page: '0' }],
    ['page', { page: 'abc' }],
    ['page', { page: '1.5' }],
    ['limit', { limit: '101' }],
    ['limit', { limit: '0' }],
    ['search', { search: 'x'.repeat(201) }],
    ['tag', { tag: 'x'.repeat(51) }],
    ['ownerUserId', { ownerUserId: 'owner-b' }],
  ])('rejects %s in %o', async (field, q) => {
    expect(await errorsFor(MemoryVaultQueryDto, q)).toContain(field);
  });

  it('trims search and tag (blank = no filter)', () => {
    expect(query({ search: '  holiday ', tag: '   ' })).toMatchObject({
      search: 'holiday',
      tag: '',
    });
  });
});

describe('MemoryVaultService', () => {
  it('create: owner from the session, explicit fields only, safe select, tags flattened', async () => {
    const { memoryVaultItem, memoryVaultTag, service } = setup();
    memoryVaultTag.findMany.mockResolvedValue([]);
    const res = await service.create('owner-a', {
      ...create,
      textContent: null,
      ...({ ownerUserId: 'owner-b', deletedAt: new Date() } as object),
    } as CreateMemoryVaultItemDto);
    const { data, select } = memoryVaultItem.create.mock.calls[0][0];
    expect(data).toEqual({
      ownerUserId: 'owner-a',
      title: create.title,
      category: 'TRAVEL',
      textContent: null,
      tags: { create: [] },
    });
    expect(memoryVaultTag.createMany).not.toHaveBeenCalled();
    expect(select).not.toHaveProperty('ownerUserId');
    expect(select).not.toHaveProperty('deletedAt');
    expect(select.tags.select).toEqual({
      tag: { select: { id: true, name: true } },
    });
    expect(res).toEqual(response);
  });

  it('create with tags: same-name duplicates collapse, first spelling kept, owner-scoped lookup', async () => {
    const { memoryVaultItem, memoryVaultTag, service } = setup();
    await service.create('owner-a', {
      ...create,
      tags: ['Family', 'FAMILY', 'family', 'Road trips'],
    } as CreateMemoryVaultItemDto);
    expect(memoryVaultTag.createMany).toHaveBeenCalledWith({
      data: [
        { ownerUserId: 'owner-a', name: 'Family', normalizedName: 'family' },
        {
          ownerUserId: 'owner-a',
          name: 'Road trips',
          normalizedName: 'road trips',
        },
      ],
      skipDuplicates: true,
    });
    expect(memoryVaultTag.findMany.mock.calls[0][0].where).toEqual({
      ownerUserId: 'owner-a',
      normalizedName: { in: ['family', 'road trips'] },
    });
    expect(memoryVaultItem.create.mock.calls[0][0].data.tags).toEqual({
      create: [{ tagId: 't1' }, { tagId: 't2' }],
    });
  });

  describe('list', () => {
    it('default page: owner-scoped, live only, newest first with id tie-break, 25 per page', async () => {
      const { memoryVaultItem, service } = setup();
      const res = await service.findPageForOwner('owner-a', query());
      const args = memoryVaultItem.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        ownerUserId: 'owner-a',
        deletedAt: null,
        category: undefined,
        tags: undefined,
        OR: undefined,
      });
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args).toMatchObject({ skip: 0, take: 25 });
      // The count uses exactly the same filter.
      expect(memoryVaultItem.count.mock.calls[0][0].where).toBe(args.where);
      expect(res).toEqual({
        items: [response],
        pagination: { page: 1, limit: 25, total: 1, pages: 1 },
      });
    });

    it('custom page/limit and a page past the end (empty, real total)', async () => {
      const { memoryVaultItem, service } = setup();
      memoryVaultItem.count.mockResolvedValue(7);
      memoryVaultItem.findMany.mockResolvedValue([]);
      const res = await service.findPageForOwner(
        'owner-a',
        query({ page: '4', limit: '3' }),
      );
      expect(memoryVaultItem.findMany.mock.calls[0][0]).toMatchObject({
        skip: 9,
        take: 3,
      });
      expect(res).toEqual({
        items: [],
        pagination: { page: 4, limit: 3, total: 7, pages: 3 },
      });
    });

    it('search: title or text, case-insensitive; blank search is no filter', async () => {
      const { memoryVaultItem, service } = setup();
      await service.findPageForOwner('owner-a', query({ search: ' Italy ' }));
      await service.findPageForOwner('owner-a', query({ search: '   ' }));
      const [hit, blank] = memoryVaultItem.findMany.mock.calls.map(
        (c) => c[0].where,
      );
      expect(hit.OR).toEqual([
        { title: { contains: 'Italy', mode: 'insensitive' } },
        { textContent: { contains: 'Italy', mode: 'insensitive' } },
      ]);
      expect(hit.ownerUserId).toBe('owner-a');
      expect(blank.OR).toBeUndefined();
    });

    it('search: LIKE wildcards and the escape character are matched literally', async () => {
      const { memoryVaultItem, service } = setup();
      // Typed: 100%_a\b
      await service.findPageForOwner('owner-a', query({ search: '100%_a\\b' }));
      expect(memoryVaultItem.findMany.mock.calls[0][0].where.OR[0]).toEqual({
        title: { contains: '100\\%\\_a\\\\b', mode: 'insensitive' },
      });
    });

    it('tag: matched by normalized name among the owner’s own tags only', async () => {
      const { memoryVaultItem, service } = setup();
      await service.findPageForOwner('owner-a', query({ tag: ' FAMILY ' }));
      await service.findPageForOwner('owner-a', query({ tag: ' ' }));
      const [tagged, blank] = memoryVaultItem.findMany.mock.calls.map(
        (c) => c[0].where,
      );
      expect(tagged.tags).toEqual({
        some: { tag: { ownerUserId: 'owner-a', normalizedName: 'family' } },
      });
      expect(blank.tags).toBeUndefined();
    });

    it('category + search + tag + pagination compose into one WHERE (count included)', async () => {
      const { memoryVaultItem, service } = setup();
      await service.findPageForOwner(
        'owner-a',
        query({
          category: 'TRAVEL',
          search: 'italy',
          tag: 'Family',
          page: '2',
          limit: '10',
        }),
      );
      const args = memoryVaultItem.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        ownerUserId: 'owner-a',
        deletedAt: null,
        category: 'TRAVEL',
        tags: {
          some: { tag: { ownerUserId: 'owner-a', normalizedName: 'family' } },
        },
        OR: [
          { title: { contains: 'italy', mode: 'insensitive' } },
          { textContent: { contains: 'italy', mode: 'insensitive' } },
        ],
      });
      expect(args).toMatchObject({ skip: 10, take: 10 });
      expect(memoryVaultItem.count.mock.calls[0][0].where).toBe(args.where);
    });
  });

  it('tags: the owner’s own tags only, by name', async () => {
    const { memoryVaultTag, service } = setup();
    memoryVaultTag.findMany.mockResolvedValue([{ id: 't1', name: 'Family' }]);
    expect(await service.findTags('owner-a')).toEqual([
      { id: 't1', name: 'Family' },
    ]);
    expect(memoryVaultTag.findMany).toHaveBeenCalledWith({
      where: { ownerUserId: 'owner-a' },
      orderBy: { normalizedName: 'asc' },
      select: { id: true, name: true },
    });
  });

  it('get: owned + live, tags included, 404 otherwise (cross-user, deleted, missing)', async () => {
    const { memoryVaultItem, service } = setup();
    expect(await service.findOwnedById('owner-a', 'v1')).toEqual(response);
    expect(memoryVaultItem.findFirst.mock.calls[0][0].where).toEqual(owned);
    memoryVaultItem.findFirst.mockResolvedValue(null);
    await expect(service.findOwnedById('owner-b', 'v1')).rejects.toThrow(
      MEMORY_NOT_FOUND,
    );
  });

  it('PATCH: missing fields (tags included) stay unchanged, null clears text', async () => {
    const { memoryVaultItem, memoryVaultTag, service } = setup();
    await service.update('owner-a', 'v1', { category: 'CHILDHOOD' });
    await service.update('owner-a', 'v1', { textContent: null });
    const [first, second] = memoryVaultItem.update.mock.calls.map((c) => c[0]);
    expect(first.where).toEqual(owned);
    expect(first.data).toEqual({
      title: undefined,
      category: 'CHILDHOOD',
      textContent: undefined,
      tags: undefined,
    });
    expect(second.data.textContent).toBeNull();
    expect(memoryVaultTag.createMany).not.toHaveBeenCalled();
  });

  it('PATCH tags: replaces the whole set in the same transaction; [] removes all', async () => {
    const { memoryVaultItem, memoryVaultTag, $transaction, service } = setup();
    await service.update('owner-a', 'v1', { tags: ['Family', 'Childhood'] });
    memoryVaultTag.findMany.mockResolvedValue([]);
    await service.update('owner-a', 'v1', { tags: [] });
    const [replace, clear] = memoryVaultItem.update.mock.calls.map((c) => c[0]);
    expect(replace.data.tags).toEqual({
      deleteMany: {},
      create: [{ tagId: 't1' }, { tagId: 't2' }],
    });
    expect(clear.data.tags).toEqual({ deleteMany: {}, create: [] });
    expect($transaction).toHaveBeenCalledTimes(2);
  });

  it('DELETE soft-deletes the memory and its live media in one owner-scoped update, then purges them', async () => {
    const { memoryVaultItem, cleanup, service } = setup();
    const media = [{ id: 'a1', storageKey: 'k' }];
    memoryVaultItem.update.mockResolvedValue({ mediaAssets: media });
    await service.remove('owner-a', 'v1');
    const { where, data, select } = memoryVaultItem.update.mock.calls[0][0];
    expect(where).toEqual(owned);
    const deletedAt = data.deletedAt;
    expect(deletedAt).toBeInstanceOf(Date);
    expect(data.mediaAssets).toEqual({
      updateMany: { where: { deletedAt: null }, data: { deletedAt } },
    });
    expect(select.mediaAssets.where).toEqual({ deletedAt });
    expect(cleanup.purge).toHaveBeenCalledWith('memoryVaultMediaAsset', media);
  });

  it.each(['update', 'remove'] as const)(
    'cross-user %s → 404 (no matching row)',
    async (method) => {
      const { memoryVaultItem, service } = setup();
      memoryVaultItem.update.mockRejectedValue(noMatch());
      await expect(
        method === 'update'
          ? service.update('owner-b', 'v1', { title: 'x', tags: ['Family'] })
          : service.remove('owner-b', 'v1'),
      ).rejects.toThrow(NotFoundException);
      expect(memoryVaultItem.update.mock.calls[0][0].where.ownerUserId).toBe(
        'owner-b',
      );
    },
  );

  it('unexpected database errors are not turned into 404', async () => {
    const { memoryVaultItem, service } = setup();
    const boom = new Error('connection lost');
    memoryVaultItem.update.mockRejectedValue(boom);
    await expect(service.remove('owner-a', 'v1')).rejects.toBe(boom);
    await expect(service.update('owner-a', 'v1', {})).rejects.toBe(boom);
    memoryVaultItem.findFirst.mockRejectedValue(boom);
    await expect(service.findOwnedById('owner-a', 'v1')).rejects.toBe(boom);
  });
});

describe('MemoryVaultController guards', () => {
  it('requires a session and the CUSTOMER role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, MemoryVaultController)).toEqual(
      [SessionAuthGuard, CustomerGuard],
    );
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

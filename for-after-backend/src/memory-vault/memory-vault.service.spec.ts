import { type ExecutionContext, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomerGuard } from '../auth/guards/customer.guard.js';
import { SessionAuthGuard } from '../auth/guards/session-auth.guard.js';
import { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  CreateMemoryVaultItemDto,
  MemoryVaultQueryDto,
} from './dto/create-memory-vault-item.dto.js';
import { UpdateMemoryVaultItemDto } from './dto/update-memory-vault-item.dto.js';
import { MemoryVaultController } from './memory-vault.controller.js';
import {
  MEMORY_NOT_FOUND,
  MemoryVaultService,
} from './memory-vault.service.js';

const row = {
  id: 'v1',
  title: 'Christmas With My Family',
  category: 'FAMILY',
  textContent: 'A fictional memory.',
  createdAt: new Date(),
  updatedAt: new Date(),
};
const owned = { id: 'v1', ownerUserId: 'owner-a', deletedAt: null };

const noMatch = () =>
  new Prisma.PrismaClientKnownRequestError('No record found', {
    code: 'P2025',
    clientVersion: 'test',
  });

const setup = () => {
  const memoryVaultItem = {
    create: vi.fn().mockResolvedValue(row),
    findMany: vi.fn().mockResolvedValue([row]),
    findFirst: vi.fn().mockResolvedValue(row),
    update: vi.fn().mockResolvedValue(row),
  };
  return {
    memoryVaultItem,
    service: new MemoryVaultService({
      memoryVaultItem,
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
const create = { title: 'My First Trip to Perth', category: 'TRAVEL' };

describe('CreateMemoryVaultItemDto', () => {
  it.each([
    create,
    { ...create, textContent: 'A fictional memory.' },
    { ...create, textContent: null },
    { ...create, category: 'LOVE_STORIES' },
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
  ])('rejects %s in %o', async (field, patch) => {
    expect(
      await errorsFor(CreateMemoryVaultItemDto, { ...create, ...patch }),
    ).toContain(field);
  });

  it('trims the title and stores blank text as null', () => {
    const dto = plainToInstance(CreateMemoryVaultItemDto, {
      ...create,
      title: '  Perth  ',
      textContent: '   ',
    });
    expect(dto.title).toBe('Perth');
    expect(dto.textContent).toBeNull();
  });
});

describe('UpdateMemoryVaultItemDto', () => {
  it.each([{}, { textContent: null }, { category: 'CHILDHOOD' }])(
    'accepts %o',
    async (body) => {
      expect(await errorsFor(UpdateMemoryVaultItemDto, body)).toEqual([]);
    },
  );

  it.each([
    ['title', { title: null }],
    ['title', { title: ' ' }],
    ['category', { category: null }],
    ['category', { category: 'VIDEO' }],
    ['mediaAssets', { mediaAssets: [] }],
    ['storageKey', { storageKey: 'x' }],
    ['createdAt', { createdAt: '2020-01-01' }],
  ])('rejects %s in %o', async (field, body) => {
    expect(await errorsFor(UpdateMemoryVaultItemDto, body)).toContain(field);
  });
});

describe('MemoryVaultQueryDto', () => {
  it('accepts no filter or a known category, rejects others', async () => {
    expect(await errorsFor(MemoryVaultQueryDto, {})).toEqual([]);
    expect(
      await errorsFor(MemoryVaultQueryDto, { category: 'RECIPES' }),
    ).toEqual([]);
    expect(await errorsFor(MemoryVaultQueryDto, { category: 'NOPE' })).toEqual([
      'category',
    ]);
  });
});

describe('MemoryVaultService', () => {
  it('create: owner from the session, explicit fields only, safe select', async () => {
    const { memoryVaultItem, service } = setup();
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
    });
    expect(select).not.toHaveProperty('ownerUserId');
    expect(select).not.toHaveProperty('deletedAt');
    expect(res).toBe(row);
  });

  it('list: owner-scoped, live only, newest first, optional category', async () => {
    const { memoryVaultItem, service } = setup();
    await service.findAllForOwner('owner-a');
    await service.findAllForOwner('owner-a', 'FAMILY');
    const [all, family] = memoryVaultItem.findMany.mock.calls.map((c) => c[0]);
    expect(all.where).toEqual({
      ownerUserId: 'owner-a',
      deletedAt: null,
      category: undefined,
    });
    expect(all.orderBy).toEqual({ createdAt: 'desc' });
    expect(family.where.category).toBe('FAMILY');
  });

  it('get: owned + live, 404 otherwise (cross-user, deleted, missing)', async () => {
    const { memoryVaultItem, service } = setup();
    expect(await service.findOwnedById('owner-a', 'v1')).toBe(row);
    expect(memoryVaultItem.findFirst.mock.calls[0][0].where).toEqual(owned);
    memoryVaultItem.findFirst.mockResolvedValue(null);
    await expect(service.findOwnedById('owner-b', 'v1')).rejects.toThrow(
      MEMORY_NOT_FOUND,
    );
  });

  it('PATCH: missing text stays unchanged (undefined), null clears it', async () => {
    const { memoryVaultItem, service } = setup();
    await service.update('owner-a', 'v1', { category: 'CHILDHOOD' });
    await service.update('owner-a', 'v1', { textContent: null });
    const [first, second] = memoryVaultItem.update.mock.calls.map((c) => c[0]);
    expect(first.where).toEqual(owned);
    expect(first.data).toEqual({
      title: undefined,
      category: 'CHILDHOOD',
      textContent: undefined,
    });
    expect(second.data.textContent).toBeNull();
  });

  it('DELETE soft-deletes with one owner-scoped update', async () => {
    const { memoryVaultItem, service } = setup();
    await service.remove('owner-a', 'v1');
    const { where, data } = memoryVaultItem.update.mock.calls[0][0];
    expect(where).toEqual(owned);
    expect(data).toEqual({ deletedAt: expect.any(Date) });
  });

  it.each(['update', 'remove'] as const)(
    'cross-user %s → 404 (no matching row)',
    async (method) => {
      const { memoryVaultItem, service } = setup();
      memoryVaultItem.update.mockRejectedValue(noMatch());
      await expect(
        method === 'update'
          ? service.update('owner-b', 'v1', { title: 'x' })
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

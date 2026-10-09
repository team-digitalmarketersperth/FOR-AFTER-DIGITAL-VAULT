import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { FAKE_MALWARE, FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage, fileStart } from './fake-media-storage.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Real HTTP, validation, guards, sessions and PostgreSQL; object storage is a
// deterministic mock, so no bucket or credential is ever used here.
// Fictional data only; the test users are removed afterwards.
describe('Memory Vault (e2e, PostgreSQL, mocked storage)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  // ana: Phase 13A search, tags and pagination (john has look-alike data).
  const emails = ['lisa', 'john', 'admin', 'ana'].map(
    (name) => `memory.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();
  // The browser's direct upload, then complete with the provider's file id.
  const uploadAndComplete = async (
    agent: ReturnType<typeof request.agent>,
    url: string,
    res: { body: { mediaAssetId: string; upload: never } },
    file: { sizeBytes: number; contentType: string },
  ) =>
    agent
      .post(`${url}/${res.body.mediaAssetId}/complete`)
      .send({ providerFileId: storage.upload(res.body.upload, file) });

  type Agent = ReturnType<typeof request.agent>;
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  };

  let lisa: Agent;
  let john: Agent;
  let memoryId: string;
  let mediaId: string;
  let item: string;
  let media: string;
  const root = '/api/v1/memory-vault';
  const photo = {
    kind: 'PHOTO',
    originalFileName: 'family.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 100_000,
  };
  const noLeaks = (body: unknown) =>
    expect(JSON.stringify(body)).not.toMatch(
      /storageKey|storageProvider|providerFileId|ownerUserId|deletedAt|users\/|memory\.lisa|secret/i,
    );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        MemoryVaultModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(scanner)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);

    for (const email of emails) {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send({ email, password, firstName: 'Test', lastName: 'User' })
        .expect(201);
    }
    lisa = await signIn(emails[0]);
    john = await signIn(emails[1]);
  });

  afterAll(async () => {
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('requires a Customer session (401, admins included) and UUIDs (400)', async () => {
    await request(app.getHttpServer()).get(root).expect(401);
    await request(app.getHttpServer())
      .post(root)
      .send({ title: 'x', category: 'FAMILY' })
      .expect(401);
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      await prisma.user.update({ where: { email: emails[2] }, data: { role } });
      // Step 16: each role enrolls MFA afresh (test reset only). The admin
      // cookie is never read on Customer routes: 401.
      await prisma.adminMfaCredential.deleteMany({
        where: { user: { email: emails[2] } },
      });
      const { agent: admin } = await adminSignIn(app, emails[2], password);
      await admin.get(root).expect(401);
      await admin
        .post(root)
        .send({ title: 'x', category: 'FAMILY' })
        .expect(401);
    }
    const id = crypto.randomUUID();
    await lisa.get(`${root}/not-a-uuid`).expect(400);
    await lisa.patch(`${root}/not-a-uuid`).send({ title: 'x' }).expect(400);
    await lisa.delete(`${root}/not-a-uuid`).expect(400);
    await lisa.get(`${root}/not-a-uuid/media`).expect(400);
    await lisa
      .post(`${root}/not-a-uuid/media/upload-url`)
      .send(photo)
      .expect(400);
    await lisa
      .post(`${root}/${id}/media/not-a-uuid/complete`)
      .send({ providerFileId: 'f1' })
      .expect(400);
    await lisa.get(`${root}/${id}/media/not-a-uuid/access-url`).expect(400);
    await lisa.delete(`${root}/${id}/media/not-a-uuid`).expect(400);
  });

  it('rejects invalid memory bodies (400)', async () => {
    const ok = { title: 'x', category: 'FAMILY' };
    for (const body of [
      { category: 'FAMILY' },
      { ...ok, title: '   ' },
      { ...ok, category: 'PETS' },
      { title: 'x' },
      { ...ok, ownerUserId: crypto.randomUUID() },
      { ...ok, deletedAt: null },
      { ...ok, recipientIds: [] },
      { ...ok, status: 'DRAFT' },
      { ...ok, contentType: 'MIXED' },
      { ...ok, imageUrl: 'https://example.test/a.jpg' },
    ]) {
      await lisa.post(root).send(body).expect(400);
    }
    await lisa.get(`${root}?category=PETS`).expect(400);
    await lisa.get(`${root}?tagId=x`).expect(400);
  });

  it('creates, lists (newest first, by category), reads and updates', async () => {
    const created = await lisa
      .post(root)
      .send({
        title: '  Christmas With My Family  ',
        category: 'FAMILY',
        textContent: 'One of my favourite family memories.',
      })
      .expect(201);
    expect(Object.keys(created.body).sort()).toEqual([
      'category',
      'createdAt',
      'id',
      'tags',
      'textContent',
      'title',
      'updatedAt',
    ]);
    expect(created.body.tags).toEqual([]);
    expect(created.body.title).toBe('Christmas With My Family');
    memoryId = created.body.id;
    item = `${root}/${memoryId}`;
    media = `${item}/media`;

    const trip = await lisa
      .post(root)
      .send({ title: 'My First Trip to Perth', category: 'TRAVEL' })
      .expect(201);
    expect(trip.body.textContent).toBeNull();

    const list = await lisa.get(root).expect(200);
    expect(list.body.items.map((m: { id: string }) => m.id)).toEqual([
      trip.body.id,
      memoryId,
    ]);
    noLeaks(list.body);
    const family = await lisa.get(`${root}?category=FAMILY`).expect(200);
    expect(family.body.items.map((m: { id: string }) => m.id)).toEqual([
      memoryId,
    ]);

    noLeaks((await lisa.get(item).expect(200)).body);

    const patched = await lisa
      .patch(item)
      .send({ category: 'CHILDHOOD', textContent: 'Updated fictional memory.' })
      .expect(200);
    expect(patched.body).toMatchObject({
      title: 'Christmas With My Family',
      category: 'CHILDHOOD',
      textContent: 'Updated fictional memory.',
    });
    // Missing text is kept; null clears it.
    await lisa.patch(`${root}/${trip.body.id}`).send({ textContent: 'x' });
    const kept = await lisa
      .patch(`${root}/${trip.body.id}`)
      .send({ title: 'Perth, 1998' })
      .expect(200);
    expect(kept.body.textContent).toBe('x');
    const cleared = await lisa
      .patch(`${root}/${trip.body.id}`)
      .send({ textContent: null })
      .expect(200);
    expect(cleared.body.textContent).toBeNull();
    for (const body of [
      { ownerUserId: crypto.randomUUID() },
      { mediaAssets: [] },
      { storageKey: 'x' },
      { status: 'READY' },
      { title: null },
    ]) {
      await lisa.patch(item).send(body).expect(400);
    }
  });

  it('rejects invalid upload requests (400) without signing anything', async () => {
    for (const body of [
      { ...photo, kind: 'VIDEO', mimeType: 'video/mp4' },
      { ...photo, mimeType: 'image/svg+xml' },
      { ...photo, mimeType: 'audio/mpeg' },
      { ...photo, kind: 'AUDIO', mimeType: 'image/jpeg' },
      { ...photo, sizeBytes: 20 * 1024 * 1024 + 1 },
      {
        ...photo,
        kind: 'AUDIO',
        mimeType: 'audio/mpeg',
        sizeBytes: 25 * 1024 * 1024 + 1,
      },
      // Video is for messages only.
      { ...photo, kind: 'VIDEO', mimeType: 'video/webm' },
      { ...photo, sizeBytes: 0 },
      { ...photo, ownerUserId: crypto.randomUUID() },
      { ...photo, storageKey: 'users/someone/evil.jpg' },
      { ...photo, fileUrl: 'https://example.test/a.jpg' },
    ]) {
      await lisa.post(`${media}/upload-url`).send(body).expect(400);
    }
    expect(storage.createUpload).not.toHaveBeenCalled();
    expect(
      await prisma.memoryVaultMediaAsset.count({
        where: { memoryVaultItemId: memoryId },
      }),
    ).toBe(0);
  });

  it('PHOTO: upload auth → ImageKit upload → complete → READY → list → access URL', async () => {
    const res = await lisa.post(`${media}/upload-url`).send(photo).expect(201);
    expect(Object.keys(res.body).sort()).toEqual([
      'expiresAt',
      'mediaAssetId',
      'upload',
    ]);
    mediaId = res.body.mediaAssetId;
    const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(row.status).toBe('PENDING_UPLOAD');
    expect(row.storageKey).toMatch(
      new RegExp(
        `^/for-after/users/[0-9a-f-]+/memory-vault/${memoryId}/photo/${mediaId}\\.jpg$`,
      ),
    );

    // Not uploaded yet: 409, stays PENDING; no access URL.
    await lisa.get(`${media}/${mediaId}/access-url`).expect(409);
    await lisa
      .post(`${media}/${mediaId}/complete`)
      .send({ providerFileId: 'not-uploaded' })
      .expect(409);

    const fileId = storage.upload(res.body.upload, {
      sizeBytes: photo.sizeBytes,
      contentType: photo.mimeType,
    });
    const done = await lisa
      .post(`${media}/${mediaId}/complete`)
      .send({ providerFileId: fileId })
      .expect(200);
    expect(done.body).toMatchObject({ status: 'READY', kind: 'PHOTO' });
    expect(done.body.uploadedAt).toBeTruthy();
    noLeaks(done.body);
    const again = await lisa
      .post(`${media}/${mediaId}/complete`)
      .send({ providerFileId: fileId })
      .expect(200);
    expect(again.body.uploadedAt).toBe(done.body.uploadedAt);

    const list = await lisa.get(media).expect(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0]).toMatchObject({ id: mediaId, status: 'READY' });
    noLeaks(list.body);

    const access = await lisa.get(`${media}/${mediaId}/access-url`).expect(200);
    expect(access.body).toEqual({
      url: 'https://media.test/signed?expires=300',
      expiresAt: expect.any(String),
    });
  });

  it('AUDIO and a wrong-size upload: FAILED, never READY', async () => {
    const res = await lisa
      .post(`${media}/upload-url`)
      .send({
        ...photo,
        kind: 'AUDIO',
        mimeType: 'audio/mpeg',
        sizeBytes: 5_000,
      })
      .expect(201);
    const id = res.body.mediaAssetId;
    // The uploaded file is not the declared size.
    const failed = await uploadAndComplete(lisa, media, res, {
      sizeBytes: 4_000,
      contentType: 'audio/mpeg',
    });
    expect(failed.status).toBe(400);
    const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
      where: { id },
    });
    expect(row.status).toBe('FAILED');
    expect(row.storageDeletedAt).toBeInstanceOf(Date);
    await lisa.get(`${media}/${id}/access-url`).expect(409);
    await lisa.delete(`${media}/${id}`).expect(204);
  });

  // Phase 12B: Memory Vault media is malware-scanned before READY.
  it.each([
    ['PHOTO', 'image/jpeg'],
    ['AUDIO', 'audio/mpeg'],
  ])(
    'infected %s → 400 generic, FAILED, file deleted, no access',
    async (kind, mimeType) => {
      const res = await lisa
        .post(`${media}/upload-url`)
        .send({ ...photo, kind, mimeType, sizeBytes: 5_000 })
        .expect(201);
      const id = res.body.mediaAssetId;
      const fileId = storage.upload(res.body.upload, {
        sizeBytes: 5_000,
        contentType: mimeType,
        bytes: new Uint8Array([
          ...fileStart(mimeType),
          ...Buffer.from(FAKE_MALWARE),
        ]),
      });
      const rejected = await lisa
        .post(`${media}/${id}/complete`)
        .send({ providerFileId: fileId })
        .expect(400);
      expect(rejected.body.message).toMatch(/could not be accepted/);
      const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
        where: { id },
      });
      expect(row.status).toBe('FAILED');
      expect(row.storageDeletedAt).toBeInstanceOf(Date);
      expect(storage.files.has(fileId)).toBe(false);
      await lisa
        .post(`${media}/${id}/complete`)
        .send({ providerFileId: fileId })
        .expect(409);
      await lisa.get(`${media}/${id}/access-url`).expect(409);
      await lisa.delete(`${media}/${id}`).expect(204);
    },
  );

  it('isolates users: John gets a plain 404 for Lisa’s memory and media', async () => {
    const responses = [
      await john.get(item).expect(404),
      await john.patch(item).send({ title: 'Mine now' }).expect(404),
      await john.delete(item).expect(404),
      await john.post(`${media}/upload-url`).send(photo).expect(404),
      await john
        .post(`${media}/${mediaId}/complete`)
        .send({ providerFileId: 'f1' })
        .expect(404),
      await john.get(media).expect(404),
      await john.get(`${media}/${mediaId}/access-url`).expect(404),
      await john.delete(`${media}/${mediaId}`).expect(404),
    ];
    for (const res of responses) noLeaks(res.body);
    expect((await john.get(root).expect(200)).body.items).toEqual([]);
    const row = await prisma.memoryVaultItem.findUniqueOrThrow({
      where: { id: memoryId },
    });
    expect(row.deletedAt).toBeNull();
    expect(row.title).toBe('Christmas With My Family');
  });

  it('deletes media: soft delete, then the provider file is deleted', async () => {
    storage.deleteObject.mockClear();
    await lisa.delete(`${media}/${mediaId}`).expect(204);
    const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
      where: { id: mediaId },
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    expect(row.storageDeletedAt).toBeInstanceOf(Date);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: row.storageKey }),
    );
    expect((await lisa.get(media).expect(200)).body).toEqual([]);
    await lisa.get(`${media}/${mediaId}/access-url`).expect(404);
  });

  it('deleting the memory hides it and all its media at once, and deletes their files', async () => {
    const res = await lisa.post(`${media}/upload-url`).send(photo).expect(201);
    const id = res.body.mediaAssetId;
    expect(
      (
        await uploadAndComplete(lisa, media, res, {
          sizeBytes: photo.sizeBytes,
          contentType: photo.mimeType,
        })
      ).status,
    ).toBe(200);

    storage.deleteObject.mockClear();
    await lisa.delete(item).expect(204);
    const row = await prisma.memoryVaultItem.findUniqueOrThrow({
      where: { id: memoryId },
    });
    expect(row.deletedAt).toBeInstanceOf(Date);
    const asset = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({
      where: { id },
    });
    expect(asset.deletedAt).toBeInstanceOf(Date);
    expect(asset.storageDeletedAt).toBeInstanceOf(Date);
    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    await lisa.get(item).expect(404);
    await lisa.patch(item).send({ title: 'x' }).expect(404);
    await lisa.delete(item).expect(404);
    await lisa.get(media).expect(404);
    await lisa.get(`${media}/${id}/access-url`).expect(404);
    await lisa
      .post(`${media}/${id}/complete`)
      .send({ providerFileId: 'f1' })
      .expect(404);
    await lisa.post(`${media}/upload-url`).send(photo).expect(404);
    await lisa.delete(`${media}/${id}`).expect(404);
    const ids = (await lisa.get(root).expect(200)).body.items.map(
      (m: { id: string }) => m.id,
    );
    expect(ids).not.toContain(memoryId);
  });

  // Phase 13A: GET /memory-vault?page&limit&category&search&tag, tags on
  // create/update. Ben (john) has look-alike titles, text and tag names: none of his
  // data may ever reach Ana.
  describe('search, tags and pagination (Phase 13A)', () => {
    let ana: Agent;
    let ben: Agent;
    const ids: Record<string, string> = {};
    type Body = { items: { id: string; tags: { name: string }[] }[] };
    const listed = (res: { body: Body }) => res.body.items.map((m) => m.id);
    const names = (tags: { name: string }[]) => tags.map((t) => t.name);
    const make = async (agent: Agent, key: string, body: object) => {
      const res = await agent.post(root).send(body).expect(201);
      ids[key] = res.body.id;
      return res.body;
    };

    beforeAll(async () => {
      ana = await signIn(emails[3]);
      ben = john; // logins are limited to 5 a minute
      // Oldest first; lists are newest first.
      await make(ana, 'italy', {
        title: 'Italy road trip',
        category: 'TRAVEL',
        textContent: 'Gelato in Florence.',
        tags: ['Family', 'Road trips'],
      });
      await make(ana, 'perth', {
        title: 'Perth weekend',
        category: 'TRAVEL',
        textContent: 'A picnic with an ITALY theme.',
        tags: ['  family '],
      });
      await make(ana, 'nana', {
        title: 'Nana’s kitchen',
        category: 'FAMILY',
        tags: ['Recipes'],
      });
      await make(ana, 'pasta', {
        title: 'Pasta night',
        category: 'RECIPES',
        textContent: 'An italian recipe, 100% from scratch.',
      });
      await make(ana, 'gone', {
        title: 'Deleted Italy memory',
        category: 'TRAVEL',
        tags: ['Family'],
      });
      await ana.delete(`${root}/${ids.gone}`).expect(204);
      await make(ben, 'benItaly', {
        title: 'Italy road trip',
        category: 'TRAVEL',
        textContent: 'Gelato in Florence.',
        tags: ['Family', 'Road trips'],
      });
    });

    it('creates with tags: one logical tag per name, first spelling kept, { id, name } only', async () => {
      const detail = await ana.get(`${root}/${ids.perth}`).expect(200);
      expect(detail.body.tags).toEqual([
        { id: expect.any(String), name: 'Family' },
      ]);
      noLeaks(detail.body);
      const tags = await ana.get(`${root}/tags`).expect(200);
      expect(names(tags.body)).toEqual(['Family', 'Recipes', 'Road trips']);
      expect(Object.keys(tags.body[0]).sort()).toEqual(['id', 'name']);
      const benTags = await ben.get(`${root}/tags`).expect(200);
      expect(names(benTags.body)).toEqual(['Family', 'Road trips']);
      // Same names, different Customers: different tags.
      expect(benTags.body[0].id).not.toBe(tags.body[0].id);
      expect(
        await prisma.memoryVaultTag.count({
          where: { owner: { email: emails[3] }, normalizedName: 'family' },
        }),
      ).toBe(1);
    });

    it('paginates newest first, live items only, with owner-scoped totals', async () => {
      const all = await ana.get(root).expect(200);
      expect(listed(all)).toEqual([ids.pasta, ids.nana, ids.perth, ids.italy]);
      expect(all.body.pagination).toEqual({
        page: 1,
        limit: 25,
        total: 4,
        pages: 1,
      });
      const p2 = await ana.get(`${root}?page=2&limit=3`).expect(200);
      expect(listed(p2)).toEqual([ids.italy]);
      expect(p2.body.pagination).toEqual({
        page: 2,
        limit: 3,
        total: 4,
        pages: 2,
      });
      const past = await ana.get(`${root}?page=9&limit=3`).expect(200);
      expect(past.body.items).toEqual([]);
      expect(past.body.pagination.total).toBe(4);
      for (const q of ['page=0', 'page=x', 'limit=0', 'limit=101'])
        await ana.get(`${root}?${q}`).expect(400);
      const benAll = await ben.get(root).expect(200);
      expect(listed(benAll)).toEqual([ids.benItaly]);
      expect(benAll.body.pagination.total).toBe(1);
    });

    it('searches title and text case-insensitively, never deleted or other Customers’ items', async () => {
      const res = await ana.get(`${root}?search=ITALY`).expect(200);
      expect(listed(res)).toEqual([ids.perth, ids.italy]);
      expect(res.body.pagination.total).toBe(2);
      // Blank search = no filter.
      const blank = await ana.get(`${root}?search=%20%20`).expect(200);
      expect(blank.body.pagination.total).toBe(4);
      // LIKE wildcards are literal text, not patterns.
      const pct = await ana
        .get(`${root}?search=${encodeURIComponent('%')}`)
        .expect(200);
      expect(listed(pct)).toEqual([ids.pasta]);
      const underscore = await ana.get(`${root}?search=_`).expect(200);
      expect(underscore.body.items).toEqual([]);
      await ana.get(`${root}?search=${'x'.repeat(201)}`).expect(400);
    });

    it('filters by tag (normalized name), and composes category + search + tag + pagination', async () => {
      const family = await ana.get(`${root}?tag=FAMILY`).expect(200);
      expect(listed(family)).toEqual([ids.perth, ids.italy]);
      const road = await ana.get(`${root}?tag=road%20trips`).expect(200);
      expect(listed(road)).toEqual([ids.italy]);
      const unknown = await ana.get(`${root}?tag=nope`).expect(200);
      expect(unknown.body.pagination.total).toBe(0);

      const q = 'category=TRAVEL&search=italy&tag=Family';
      const page1 = await ana.get(`${root}?${q}&page=1&limit=1`).expect(200);
      expect(listed(page1)).toEqual([ids.perth]);
      expect(page1.body.pagination).toEqual({
        page: 1,
        limit: 1,
        total: 2,
        pages: 2,
      });
      const page2 = await ana.get(`${root}?${q}&page=2&limit=1`).expect(200);
      expect(listed(page2)).toEqual([ids.italy]);
      const none = await ana
        .get(`${root}?category=FAMILY&tag=family`)
        .expect(200);
      expect(none.body).toEqual({
        items: [],
        pagination: { page: 1, limit: 25, total: 0, pages: 0 },
      });
      const searchTag = await ana
        .get(`${root}?search=picnic&tag=family`)
        .expect(200);
      expect(listed(searchTag)).toEqual([ids.perth]);
      // Ben's tag of the same name only ever matches Ben's memory.
      const benFamily = await ben.get(`${root}?tag=family`).expect(200);
      expect(listed(benFamily)).toEqual([ids.benItaly]);
    });

    it('PATCH tags replaces the set (reusing existing tags); omitted keeps it; [] clears it', async () => {
      const item = `${root}/${ids.italy}`;
      const replaced = await ana
        .patch(item)
        .send({ tags: ['Childhood', ' road TRIPS '] })
        .expect(200);
      expect(names(replaced.body.tags)).toEqual(['Childhood', 'Road trips']);
      const kept = await ana
        .patch(item)
        .send({ title: 'Italy, 2019' })
        .expect(200);
      expect(kept.body.tags).toEqual(replaced.body.tags);
      const list = await ana.get(`${root}?tag=childhood`).expect(200);
      expect(list.body.items[0].tags).toEqual(replaced.body.tags);
      // "Family" is unused by this memory now but stays for reuse.
      const tags = await ana.get(`${root}/tags`).expect(200);
      expect(names(tags.body)).toEqual([
        'Childhood',
        'Family',
        'Recipes',
        'Road trips',
      ]);
      const cleared = await ana.patch(item).send({ tags: [] }).expect(200);
      expect(cleared.body.tags).toEqual([]);
      for (const bad of [null, 'Family', [''], ['x'.repeat(51)]])
        await ana.patch(item).send({ tags: bad }).expect(400);
      await ana
        .post(root)
        .send({ title: 'x', category: 'OTHER', tagIds: [] })
        .expect(400);
    });

    it('another Customer can neither tag, read nor find Ana’s memories', async () => {
      await ben
        .patch(`${root}/${ids.perth}`)
        .send({ tags: ['Ben was here'] })
        .expect(404);
      // The 404 rolled back: no tag was created for Ben either.
      expect(
        await prisma.memoryVaultTag.count({
          where: { normalizedName: 'ben was here' },
        }),
      ).toBe(0);
      await ben.get(`${root}/${ids.perth}`).expect(404);
      const search = await ben.get(`${root}?search=picnic`).expect(200);
      expect(search.body.pagination.total).toBe(0);
      const perth = await ana.get(`${root}/${ids.perth}`).expect(200);
      expect(names(perth.body.tags)).toEqual(['Family']);
    });
  });
});

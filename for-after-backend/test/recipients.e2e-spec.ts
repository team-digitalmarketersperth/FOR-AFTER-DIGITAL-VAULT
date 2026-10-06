import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';

// Real HTTP, validation, guards and PostgreSQL (DATABASE_URL from .env).
// Sessions use MemoryStore so Redis is not needed. Fictional data only; the
// test users are removed afterwards (cascade removes their recipients).
// Phase 09: object storage is an in-memory fake (deterministic); a test
// "browser upload" puts the object straight in. Real B2 runs in Playwright.
class FakeStorage {
  readonly objects = new Map<
    string,
    { sizeBytes: number; contentType: string }
  >();
  readonly signed: string[] = [];
  createUploadUrl(key: string) {
    const url = `https://storage.test/put/${key}?sig=fake`;
    this.signed.push(url);
    return Promise.resolve(url);
  }
  createAccessUrl(key: string) {
    const url = `https://storage.test/get/${key}?sig=fake`;
    this.signed.push(url);
    return Promise.resolve(url);
  }
  headObject(key: string) {
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  deleteObject(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }
  /** What the browser's PUT to the signed URL would store. */
  put(uploadUrl: string, sizeBytes: number, contentType: string) {
    const key = new URL(uploadUrl).pathname.replace('/put/', '');
    this.objects.set(key, { sizeBytes, contentType });
  }
}

describe('Recipients (e2e, PostgreSQL)', () => {
  const storage = new FakeStorage();
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';

  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  };

  let lisa: ReturnType<typeof request.agent>;
  let john: ReturnType<typeof request.agent>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        RecipientsModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
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

  const sofia = {
    firstName: '  Sofia ',
    lastName: 'Smith',
    relationship: 'Daughter',
    email: ' Sofia@Example.com ',
    mobile: '+61400000000',
    birthday: '2001-03-15',
    privateNote: 'Loves family travel memories.',
  };
  let sofiaId: string;

  it('requires a session (401)', async () => {
    const server = request(app.getHttpServer());
    await server.post('/api/v1/recipients').send(sofia).expect(401);
    await server.get('/api/v1/recipients').expect(401);
  });

  it('rejects ownerUserId, unknown fields and bad input (400)', async () => {
    for (const body of [
      { ...sofia, ownerUserId: crypto.randomUUID() },
      { ...sofia, isAdmin: true },
      { ...sofia, email: 'not-an-email' },
      { ...sofia, birthday: '2001-02-30' },
      { ...sofia, firstName: '   ' },
      { ...sofia, privateNote: 'x'.repeat(2001) },
    ]) {
      await lisa.post('/api/v1/recipients').send(body).expect(400);
    }
    await lisa.get('/api/v1/recipients/not-a-uuid').expect(400);
  });

  it('creates, lists, reads and updates own recipient', async () => {
    const created = await lisa
      .post('/api/v1/recipients')
      .send(sofia)
      .expect(201);
    sofiaId = created.body.id;
    expect(created.body).toMatchObject({
      firstName: 'Sofia',
      email: 'sofia@example.com',
      birthday: '2001-03-15',
    });
    expect(created.body).not.toHaveProperty('ownerUserId');
    expect(created.body).not.toHaveProperty('deletedAt');

    const list = await lisa.get('/api/v1/recipients').expect(200);
    expect(list.body.items.map((r: { id: string }) => r.id)).toEqual([sofiaId]);
    expect(list.body.items[0].photoId).toBeNull();

    await lisa.get(`/api/v1/recipients/${sofiaId}`).expect(200);

    const updated = await lisa
      .patch(`/api/v1/recipients/${sofiaId}`)
      .send({ relationship: 'Granddaughter', mobile: null })
      .expect(200);
    expect(updated.body).toMatchObject({
      relationship: 'Granddaughter',
      mobile: null,
      firstName: 'Sofia',
    });

    await lisa
      .patch(`/api/v1/recipients/${sofiaId}`)
      .send({ firstName: null })
      .expect(400);
    await lisa
      .patch(`/api/v1/recipients/${sofiaId}`)
      .send({ ownerUserId: crypto.randomUUID() })
      .expect(400);
  });

  it('isolates users: John gets a plain 404 for Lisa’s recipient', async () => {
    const url = `/api/v1/recipients/${sofiaId}`;
    const responses = [
      await john.get(url).expect(404),
      await john.patch(url).send({ firstName: 'Hacked' }).expect(404),
      await john.delete(url).expect(404),
    ];
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toMatch(/owner|belongs|Sofia/i);
    }
    expect((await john.get('/api/v1/recipients').expect(200)).body).toEqual({
      items: [],
      pagination: { page: 1, limit: 25, total: 0, pages: 0 },
    });
    // Untouched for Lisa.
    const still = await lisa.get(url).expect(200);
    expect(still.body.firstName).toBe('Sofia');
  });

  it('admin sessions are refused (401: the admin cookie is never read here)', async () => {
    await prisma.user.update({
      where: { email: emails[2] },
      data: { role: 'ADMIN' },
    });
    // Step 16: an admin session needs password + TOTP. Its own cookie is never
    // read on Customer routes, so it gets 401 like any other non-Customer.
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.get('/api/v1/recipients').expect(401);
  });

  it('soft-deletes: row stays in the database but disappears from the API', async () => {
    await lisa.delete(`/api/v1/recipients/${sofiaId}`).expect(204);
    await lisa.get(`/api/v1/recipients/${sofiaId}`).expect(404);
    await lisa.delete(`/api/v1/recipients/${sofiaId}`).expect(404);
    expect(
      (await lisa.get('/api/v1/recipients').expect(200)).body.items,
    ).toEqual([]);

    const row = await prisma.recipient.findUnique({ where: { id: sofiaId } });
    expect(row?.deletedAt).toBeInstanceOf(Date);
  });

  describe('pagination (Phase 09)', () => {
    type Page = {
      items: { id: string }[];
      pagination: { page: number; limit: number; total: number; pages: number };
    };
    const list = async (agent: typeof lisa, query = '') =>
      (await agent.get(`/api/v1/recipients${query}`).expect(200)).body as Page;
    let lisaIds: string[];

    beforeAll(async () => {
      for (let i = 0; i < 27; i++)
        await lisa
          .post('/api/v1/recipients')
          .send({ firstName: `Fictional ${i}` })
          .expect(201);
      for (let i = 0; i < 2; i++)
        await john
          .post('/api/v1/recipients')
          .send({ firstName: `John's ${i}` })
          .expect(201);
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: emails[0] },
      });
      lisaIds = (
        await prisma.recipient.findMany({
          where: { ownerUserId: owner.id, deletedAt: null },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        })
      ).map((r) => r.id);
    });

    it('defaults to 25 per page; pages cover every live recipient once, in a stable order', async () => {
      const first = await list(lisa);
      const second = await list(lisa, '?page=2');
      expect(first.pagination).toEqual({
        page: 1,
        limit: 25,
        total: 27,
        pages: 2,
      });
      expect(first.items).toHaveLength(25);
      expect(second.items).toHaveLength(2);
      const ids = [...first.items, ...second.items].map((r) => r.id);
      expect(new Set(ids).size).toBe(27);
      expect(ids).toEqual(lisaIds);
      expect(await list(lisa, '?page=1')).toEqual(first);
    });

    it('honours limit, and a page past the end is empty with the true total', async () => {
      const third = await list(lisa, '?page=3&limit=10');
      expect(third.items.map((r) => r.id)).toEqual(lisaIds.slice(20));
      expect(third.pagination).toEqual({
        page: 3,
        limit: 10,
        total: 27,
        pages: 3,
      });
      expect((await list(lisa, '?page=9&limit=10')).items).toEqual([]);
      expect((await list(lisa, '?limit=100')).items).toHaveLength(27);
    });

    it.each([
      '?page=0',
      '?limit=0',
      '?limit=101',
      '?page=abc',
      '?limit=',
      '?page=1.5',
      '?offset=5',
    ])('rejects %s with 400', async (query) => {
      await lisa.get(`/api/v1/recipients${query}`).expect(400);
    });

    it("counts only the owner's live recipients", async () => {
      expect((await list(john)).pagination.total).toBe(2);
      await lisa.delete(`/api/v1/recipients/${lisaIds[0]}`).expect(204);
      const after = await list(lisa);
      expect(after.pagination.total).toBe(26);
      expect(after.items.map((r) => r.id)).not.toContain(lisaIds[0]);
    });
  });

  describe('photo (Phase 09)', () => {
    const PNG = 'image/png';
    let rid: string;
    const photoUrl = (path = '') => `/api/v1/recipients/${rid}/photo${path}`;
    const uploadPhoto = async (sizeBytes = 1000, agent = lisa) => {
      const target = await agent
        .post(photoUrl('/upload-url'))
        .send({
          kind: 'PHOTO',
          originalFileName: 'mum.png',
          mimeType: PNG,
          sizeBytes,
        })
        .expect(201);
      storage.put(target.body.uploadUrl, sizeBytes, PNG);
      return target.body.mediaAssetId as string;
    };
    const current = async () =>
      (await lisa.get(`/api/v1/recipients/${rid}`).expect(200)).body.photoId as
        string | null;
    const keyOf = async (id: string) =>
      (await prisma.recipientPhoto.findUniqueOrThrow({ where: { id } }))
        .storageKey;

    beforeAll(async () => {
      rid = (
        await lisa
          .post('/api/v1/recipients')
          .send({ firstName: 'Mum', privateNote: 'Fictional private note' })
          .expect(201)
      ).body.id;
    });

    it('upload → verify → READY → the Recipient shows it; signed access only, no key in responses', async () => {
      const id = await uploadPhoto();
      expect(await current()).toBeNull();
      const done = await lisa.post(photoUrl(`/${id}/complete`)).expect(200);
      expect(done.body).toMatchObject({ id, kind: 'PHOTO', status: 'READY' });
      expect(await current()).toBe(id);
      const access = await lisa.get(photoUrl(`/${id}/access-url`)).expect(200);
      expect(access.body.url).toMatch(/^https:\/\/storage\.test\/get\//);
      const key = await keyOf(id);
      expect(key).toMatch(
        new RegExp(`^users/[0-9a-f-]+/recipients/${rid}/photo/${id}\\.png$`),
      );
      expect(key).not.toMatch(/Mum|note/i);
      const all = JSON.stringify([
        done.body,
        (await lisa.get(`/api/v1/recipients/${rid}`)).body,
        (await lisa.get('/api/v1/recipients')).body,
      ]);
      expect(all).not.toContain(key);
      expect(all).not.toContain('sig=fake');
    });

    it('an unfinished upload never replaces the current photo; completing it swaps and removes the old object', async () => {
      const old = (await current())!;
      const oldKey = await keyOf(old);
      const next = await uploadPhoto(2000);
      expect(await current()).toBe(old);
      await lisa.post(photoUrl(`/${next}/complete`)).expect(200);
      expect(await current()).toBe(next);
      expect(storage.objects.has(oldKey)).toBe(false);
      await lisa.get(photoUrl(`/${old}/access-url`)).expect(404);
    });

    it('two uploads completed at once leave exactly one current photo', async () => {
      const [a, b] = [await uploadPhoto(3000), await uploadPhoto(4000)];
      const results = await Promise.all([
        lisa.post(photoUrl(`/${a}/complete`)),
        lisa.post(photoUrl(`/${b}/complete`)),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const live = await prisma.recipientPhoto.findMany({
        where: { recipientId: rid, status: 'READY', deletedAt: null },
      });
      expect(live).toHaveLength(1);
      expect([a, b]).toContain(await current());
    });

    it('refuses audio, SVG, an oversized photo and a missing object; a size mismatch fails', async () => {
      const send = (body: object) =>
        lisa.post(photoUrl('/upload-url')).send({
          kind: 'PHOTO',
          originalFileName: 'x',
          mimeType: PNG,
          sizeBytes: 10,
          ...body,
        });
      await send({ kind: 'AUDIO', mimeType: 'audio/mpeg' }).expect(400);
      await send({ mimeType: 'image/svg+xml' }).expect(400);
      await send({ sizeBytes: 5 * 1024 * 1024 + 1 }).expect(400);
      const pending = (await send({}).expect(201)).body.mediaAssetId;
      await lisa.post(photoUrl(`/${pending}/complete`)).expect(409);
      const wrong = (await send({ sizeBytes: 50 }).expect(201)).body;
      storage.put(wrong.uploadUrl, 49, PNG);
      await lisa.post(photoUrl(`/${wrong.mediaAssetId}/complete`)).expect(400);
      await lisa.get(photoUrl(`/${pending}/access-url`)).expect(409);
    });

    it('another Customer gets 404 for every photo route', async () => {
      const id = (await current())!;
      await john
        .post(photoUrl('/upload-url'))
        .send({
          kind: 'PHOTO',
          originalFileName: 'x',
          mimeType: PNG,
          sizeBytes: 10,
        })
        .expect(404);
      await john.post(photoUrl(`/${id}/complete`)).expect(404);
      await john.get(photoUrl(`/${id}/access-url`)).expect(404);
      await john.delete(photoUrl(`/${id}`)).expect(404);
      expect(await current()).toBe(id);
    });

    it('remove: back to initials (photoId null), the object is deleted, the Recipient stays', async () => {
      const id = (await current())!;
      const key = await keyOf(id);
      await lisa.delete(photoUrl(`/${id}`)).expect(204);
      expect(await current()).toBeNull();
      expect(storage.objects.has(key)).toBe(false);
      await lisa.get(photoUrl(`/${id}/access-url`)).expect(404);
    });

    it('a deleted Recipient loses its photo and cannot be given one', async () => {
      const id = await uploadPhoto();
      await lisa.post(photoUrl(`/${id}/complete`)).expect(200);
      const key = await keyOf(id);
      const late = await uploadPhoto(1234);
      await lisa.delete(`/api/v1/recipients/${rid}`).expect(204);
      await lisa.get(photoUrl(`/${id}/access-url`)).expect(404);
      await lisa.post(photoUrl(`/${late}/complete`)).expect(404);
      expect(storage.objects.has(key)).toBe(false);
      expect(
        await prisma.recipientPhoto.count({
          where: { recipientId: rid, deletedAt: null },
        }),
      ).toBe(0);
    });
  });
});

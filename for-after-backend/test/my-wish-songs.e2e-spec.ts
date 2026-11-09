import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { SONGS_MAX } from '../src/my-wishes/dto/save-my-wish-song.dto.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

// Funeral songs in My Wishes: real HTTP, validation, guards, sessions and
// PostgreSQL. Fictional data and link ids only; nothing is ever fetched.
describe('My Wishes songs (e2e, PostgreSQL)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const emails = ['lisa', 'john', 'admin'].map(
    (name) => `songs.${name}.${run}@example.test`,
  );
  const password = 'StrongPassword123!';
  const root = '/api/v1/my-wishes/songs';
  const YT = 'AbCdEfGhIjK';
  const SP = 'A1b2C3d4E5f6G7h8I9j0K1';

  type Agent = ReturnType<typeof request.agent>;
  type Song = { id: string; title: string; position: number } & Record<
    string,
    unknown
  >;
  let lisa: Agent;
  let john: Agent;
  const signIn = async (email: string) => {
    const agent = request.agent(app.getHttpServer());
    await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    return agent;
  };
  const titles = async (agent: Agent) =>
    ((await agent.get(root).expect(200)).body as Song[]).map((s) => s.title);
  const lisaId = () =>
    prisma.user.findUniqueOrThrow({ where: { email: emails[0] } });
  // Everything saving a song must never touch.
  const sideEffects = async () => {
    const { id: userId } = await lisaId();
    const own = { ownerUserId: userId };
    return Promise.all([
      prisma.message.count({ where: own }),
      prisma.messageSchedule.count({ where: { message: own } }),
      prisma.messageRecipientRelease.count({ where: { message: own } }),
      prisma.releaseNotification.count({
        where: { occurrence: { message: own } },
      }),
      prisma.recipient.count({ where: own }),
      prisma.trustedContact.count({ where: own }),
      prisma.myWishResponse.count({ where: own }),
      prisma.draftRecovery.count({ where: { userId } }),
    ]);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AuthModule,
        MyWishesModule,
      ],
    }).compile();
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
    vi.restoreAllMocks();
    await prisma?.user.deleteMany({ where: { email: { in: emails } } });
    await app?.close();
  });

  it('requires a Customer session (anonymous and admins 401)', async () => {
    const anon = request(app.getHttpServer());
    await anon.get(root).expect(401);
    await anon.post(root).send({ title: 'x' }).expect(401);
    await prisma.user.update({
      where: { email: emails[2] },
      data: { role: 'ADMIN' },
    });
    const { agent: admin } = await adminSignIn(app, emails[2], password);
    await admin.get(root).expect(401);
    await admin.post(root).send({ title: 'x' }).expect(401);
  });

  it('saves a title alone with no recipient and no side effects, never fetching the link', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = await sideEffects();
    expect(before[4]).toBe(0); // no recipient exists, none needed
    await lisa.get(root).expect(200, []);

    const plain = await lisa
      .post(root)
      .send({ title: 'Amazing Grace' })
      .expect(201);
    expect(plain.body).toEqual({
      id: expect.any(String),
      title: 'Amazing Grace',
      link: null,
      moment: null,
      momentOther: null,
      note: null,
      position: 0,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const linked = await lisa
      .post(root)
      .send({
        title: 'Song two',
        link: `https://youtu.be/${YT}?si=tracking&t=30`,
        moment: 'FAREWELL',
        note: 'The live version, please.',
      })
      .expect(201);
    expect(linked.body).toMatchObject({
      link: `https://youtu.be/${YT}?t=30`,
      moment: 'FAREWELL',
      note: 'The live version, please.',
      position: 1,
    });
    // momentOther is kept only with OTHER.
    const other = await lisa
      .post(root)
      .send({
        title: 'Song three',
        link: `https://open.spotify.com/track/${SP}?si=x`,
        moment: 'OTHER',
        momentOther: 'At the wake',
      })
      .expect(201);
    expect(other.body).toMatchObject({
      link: `https://open.spotify.com/track/${SP}`,
      momentOther: 'At the wake',
      position: 2,
    });
    const ignored = await lisa
      .post(root)
      .send({ title: 'Song four', moment: 'ARRIVAL', momentOther: 'ignored' })
      .expect(201);
    expect(ignored.body.momentOther).toBeNull();

    expect(await sideEffects()).toEqual(before);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await titles(lisa)).toEqual([
      'Amazing Grace',
      'Song two',
      'Song three',
      'Song four',
    ]);
  });

  it('rejects unsafe links, unknown fields and blank titles (400), saving nothing', async () => {
    const count = (await titles(lisa)).length;
    for (const link of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      `http://www.youtube.com/watch?v=${YT}`,
      `https://youtube.com.evil.example/watch?v=${YT}`,
      `https://user:pass@youtu.be/${YT}`,
      'https://example.com/song.mp3',
    ]) {
      const res = await lisa.post(root).send({ title: 'Bad', link }).expect(400);
      expect(res.body.message).toMatch(/YouTube or Spotify/);
    }
    await lisa.post(root).send({ title: '  ' }).expect(400);
    await lisa.post(root).send({}).expect(400);
    await lisa.post(root).send({ title: 'x', artist: 'Someone' }).expect(400);
    await lisa
      .post(root)
      .send({ title: 'x', ownerUserId: (await lisaId()).id })
      .expect(400);
    await lisa.post(root).send({ title: 'x', moment: 'WAKE' }).expect(400);
    expect((await titles(lisa)).length).toBe(count);
  });

  it('stores text as plain text, as written', async () => {
    const title = '<img src=x onerror=alert(1)>';
    const res = await lisa.post(root).send({ title }).expect(201);
    expect(res.body.title).toBe(title);
    await lisa.delete(`${root}/${res.body.id}`).expect(204);
  });

  it('PATCH changes only what is sent; null clears; the title cannot be cleared', async () => {
    const [first, second] = (await lisa.get(root).expect(200)).body as Song[];
    const edited = await lisa
      .patch(`${root}/${second.id}`)
      .send({ note: 'Updated note' })
      .expect(200);
    expect(edited.body).toMatchObject({
      title: 'Song two',
      link: `https://youtu.be/${YT}?t=30`,
      moment: 'FAREWELL',
      note: 'Updated note',
      position: 1,
    });
    const cleared = await lisa
      .patch(`${root}/${second.id}`)
      .send({ link: null, moment: null, note: '  ' })
      .expect(200);
    expect(cleared.body).toMatchObject({ link: null, moment: null, note: null });
    await lisa.patch(`${root}/${second.id}`).send({ title: null }).expect(400);
    await lisa
      .patch(`${root}/${second.id}`)
      .send({ link: 'https://evil.example' })
      .expect(400);
    // The other song is untouched.
    const after = (await lisa.get(root).expect(200)).body as Song[];
    expect(after[0]).toEqual(first);
  });

  it('reorders atomically; stale, foreign or duplicate lists change nothing', async () => {
    const songs = (await lisa.get(root).expect(200)).body as Song[];
    const ids = songs.map((s) => s.id);
    const reversed = [...ids].reverse();
    const res = await lisa
      .put(`${root}/order`)
      .send({ songIds: reversed })
      .expect(200);
    expect(res.body.map((s: Song) => s.id)).toEqual(reversed);
    expect(res.body.map((s: Song) => s.position)).toEqual([0, 1, 2, 3]);
    // Persisted: a fresh read (as after a reload) has the new order.
    expect(((await lisa.get(root).expect(200)).body as Song[]).map((s) => s.id)).toEqual(
      reversed,
    );

    const johnSong = (
      await john.post(root).send({ title: 'John only' }).expect(201)
    ).body as Song;
    await lisa
      .put(`${root}/order`)
      .send({ songIds: [...reversed.slice(1), johnSong.id] })
      .expect(409);
    await lisa
      .put(`${root}/order`)
      .send({ songIds: reversed.slice(1) })
      .expect(409);
    await lisa
      .put(`${root}/order`)
      .send({ songIds: [...reversed, reversed[0]] })
      .expect(400);
    await lisa
      .put(`${root}/order`)
      .send({ songIds: [...reversed, johnSong.id] })
      .expect(409);
    expect(((await lisa.get(root).expect(200)).body as Song[]).map((s) => s.id)).toEqual(
      reversed,
    );
    // John's list and order are his own.
    expect(await titles(john)).toEqual(['John only']);
  });

  it('another Customer can neither read, edit, delete nor reorder the songs (404 / 409)', async () => {
    const [song] = (await lisa.get(root).expect(200)).body as Song[];
    expect(await titles(john)).toEqual(['John only']);
    await john.patch(`${root}/${song.id}`).send({ title: 'Hijacked' }).expect(404);
    await john.delete(`${root}/${song.id}`).expect(404);
    await john.put(`${root}/order`).send({ songIds: [song.id] }).expect(409);
    const still = (await lisa.get(root).expect(200)).body as Song[];
    expect(still[0]).toEqual(song);
    await lisa.patch(`${root}/not-a-uuid`).send({ title: 'x' }).expect(400);
  });

  it('DELETE removes only that song', async () => {
    const songs = (await lisa.get(root).expect(200)).body as Song[];
    await lisa.delete(`${root}/${songs[1].id}`).expect(204);
    await lisa.delete(`${root}/${songs[1].id}`).expect(404);
    const after = (await lisa.get(root).expect(200)).body as Song[];
    expect(after.map((s) => s.id)).toEqual(
      songs.filter((_, i) => i !== 1).map((s) => s.id),
    );
    // A new song still goes to the end.
    const added = await lisa.post(root).send({ title: 'Last' }).expect(201);
    expect((await titles(lisa)).at(-1)).toBe('Last');
    expect(added.body.position).toBeGreaterThan(after.at(-1)!.position);
  });

  it('concurrent adds at the cap: exactly one fits, positions stay unique and in order', async () => {
    const { id: ownerUserId } = await prisma.user.findUniqueOrThrow({ where: { email: emails[1] } });
    await prisma.myWishSong.deleteMany({ where: { ownerUserId } });
    await prisma.myWishSong.createMany({
      data: Array.from({ length: SONGS_MAX - 1 }, (_, i) => ({ ownerUserId, title: `Song ${i}`, position: i })),
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => john.post(root).send({ title: `Racer ${i}` })),
    );
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([201, 400, 400, 400, 400, 400]);
    const rows = await prisma.myWishSong.findMany({ where: { ownerUserId }, orderBy: { position: 'asc' } });
    expect(rows).toHaveLength(SONGS_MAX);
    expect(rows.map((r) => r.position)).toEqual(Array.from({ length: SONGS_MAX }, (_, i) => i));
  });

  it('concurrent adds below the cap never share a position; reorder racing delete or add is a clean outcome, never a 500', async () => {
    const { id: ownerUserId } = await prisma.user.findUniqueOrThrow({ where: { email: emails[1] } });
    await prisma.myWishSong.deleteMany({ where: { ownerUserId } });
    await Promise.all(Array.from({ length: 8 }, (_, i) => john.post(root).send({ title: `T${i}` }).expect(201)));
    const positions = (await prisma.myWishSong.findMany({ where: { ownerUserId } })).map((r) => r.position);
    expect(new Set(positions).size).toBe(8);

    const songs = (await john.get(root).expect(200)).body as Song[];
    const ids = songs.map((s) => s.id).reverse();
    const [reorder, gone, added] = await Promise.all([
      john.put(`${root}/order`).send({ songIds: ids }),
      john.delete(`${root}/${songs[0].id}`),
      john.post(root).send({ title: 'During' }),
    ]);
    expect([200, 409]).toContain(reorder.status); // 409: the list changed first, nothing moved
    expect(gone.status).toBe(204);
    expect(added.status).toBe(201);
    const after = (await john.get(root).expect(200)).body as Song[];
    expect(after).toHaveLength(8);
    expect(new Set(after.map((s) => s.position)).size).toBe(8);
  });
});

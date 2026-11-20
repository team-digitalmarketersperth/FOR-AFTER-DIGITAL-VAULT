import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { PAID_FEATURE, TIER_REQUIRED, VIDEO_REQUIRES_COMPLETE } from '../src/billing/billing-access.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { EmailProvider } from '../src/email/email-provider.js';
import type { MediaKind, PaidTier } from '../src/generated/prisma/client.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MessagesModule } from '../src/messages/messages.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RecipientsModule } from '../src/recipients/recipients.module.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { SmsSender } from '../src/sms/sms-sender.js';
import { SmsVerification } from '../src/sms/sms-verification.js';
import { UsersModule } from '../src/users/users.module.js';
import { FakeEmailProvider } from './fake-email.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Updated Plans Step 4: new content media by kind for an entitled, explicitly mapped tier (synthetic tiers set on
// BillingAccount rows; nothing maps real Stripe subscriptions yet). Premium adds photos and audio, never new video;
// Complete adds all three; existing files are untouched. Real PostgreSQL; fake ImageKit, scanner, email and SMS.
describe('Media capabilities by tier (e2e, PostgreSQL)', () => {
  const DAY = 86_400_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const storage = new FakeMediaStorage();
  const run = Date.now();
  // Five accounts: sign-in is limited to five per minute per IP.
  const names = ['prem', 'comp', 'unm', 'trial', 'lapsed'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `planmedia.${n}.${run}@example.test`])) as Record<Name, string>;
  const agents = {} as Record<Name, ReturnType<typeof request.agent>>;
  const ids = {} as Record<Name, string>;
  const people = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const STORY = 'childhood.earliest-memory';
  const WISH = 'ceremony.style';
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    THROTTLE_KEY_PREFIX: `for_after:test_plan_media_throttle:${run}:`,
  };
  const FILE = {
    PHOTO: { kind: 'PHOTO', mimeType: 'image/jpeg', originalFileName: 'synthetic.jpg' },
    AUDIO: { kind: 'AUDIO', mimeType: 'audio/mpeg', originalFileName: 'synthetic.mp3' },
    VIDEO: { kind: 'VIDEO', mimeType: 'video/mp4', originalFileName: 'synthetic.mp4' },
  } as const;
  const upload = (n: Name, path: string, kind: keyof typeof FILE, sizeBytes = 1000) =>
    agents[n].post(api(`${path}/upload-url`)).send({ ...FILE[kind], sizeBytes });
  const expectVideoRefused = (res: request.Response, label = '') => {
    expect([label, res.status]).toEqual([label, 409]);
    expect(res.body).toEqual({ statusCode: 409, error: 'Conflict', code: TIER_REQUIRED, requiredTier: 'COMPLETE', feature: 'VIDEO', message: VIDEO_REQUIRES_COMPLETE });
  };
  const usage = async (n: Name) => (await agents[n].get(api('/users/me/storage')).expect(200)).body;
  const newMessage = async (n: Name, contentType = 'TEXT', over: object = {}) =>
    (await agents[n].post(api('/messages')).send({ title: 'For Sofia', textContent: contentType === 'TEXT' || contentType === 'MIXED' ? 'Words.' : undefined, recipientIds: [people[n]], contentType, ...over }).expect(201)).body.id as string;
  // Files from a paid era, seeded directly (fake storage): READY, scanned, owned.
  const ready = (n: Name, kind: MediaKind) => ({ ownerUserId: ids[n], kind, status: 'READY' as const, storageKey: `test/plan-media/${run}/${randomUUID()}`, providerFileId: `fake_${randomUUID()}`, originalFileName: `synthetic.${kind}`, mimeType: FILE[kind].mimeType, sizeBytes: 1000, uploadedAt: new Date() });
  const setTier = (n: Name, tier: PaidTier | null) => prisma.billingAccount.update({ where: { userId: ids[n] }, data: { tier } });

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule, UsersModule, MediaModule,
        RecipientsModule, MessagesModule, MemoryVaultModule, MyStoryModule, MyWishesModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(storage)
      .overrideProvider(MalwareScanner)
      .useValue(new FakeMalwareScanner())
      .overrideProvider(EmailProvider)
      .useValue(new FakeEmailProvider())
      .overrideProvider(SmsSender)
      .useValue({ name: 'fake', send: () => Promise.resolve() })
      .overrideProvider(SmsVerification)
      .useValue({ name: 'fake', send: vi.fn(), check: vi.fn() })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    const passwordHash = await argon2.hash('StrongPassword123!', { type: argon2.argon2id });
    const tiers: Record<Name, PaidTier | null> = { prem: 'PREMIUM', comp: 'COMPLETE', unm: null, trial: null, lapsed: 'PREMIUM' };
    for (const n of names) {
      ids[n] = (await prisma.user.create({ data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } })).id;
      people[n] = (await prisma.recipient.create({ data: { ownerUserId: ids[n], firstName: 'Sofia' }, select: { id: true } })).id;
      if (n === 'trial') {
        await prisma.customerTrial.create({ data: { userId: ids[n], startedAt: new Date(run - DAY), endsAt: new Date(run + 6 * DAY) } });
        continue;
      }
      await prisma.billingAccount.create({
        data: {
          userId: ids[n], stripeCustomerId: `cus_fictional_media_${n}_${run}`, livemode: false, plan: 'monthly', tier: tiers[n],
          subscriptionStatus: n === 'lapsed' ? 'canceled' : 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(run + (n === 'lapsed' ? -DAY : 30 * DAY)),
        },
      });
    }
    for (const n of names) {
      const a = request.agent(app.getHttpServer());
      await a.post(api('/auth/login')).send({ email: emails[n], password: 'StrongPassword123!' }).expect(200);
      agents[n] = a;
    }
  });

  afterAll(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  it('GET /billing reports the allowed kinds (additive): Premium photo+audio, Complete and unmapped all, trial none', async () => {
    const kinds = async (n: Name) => (await agents[n].get(api('/billing')).expect(200)).body.features;
    expect(await kinds('prem')).toEqual({ media: true, memoryLinks: true, mediaKinds: ['PHOTO', 'AUDIO'] });
    expect((await kinds('comp')).mediaKinds).toEqual(['PHOTO', 'AUDIO', 'VIDEO']);
    expect((await kinds('unm')).mediaKinds).toEqual(['PHOTO', 'AUDIO', 'VIDEO']);
    expect(await kinds('trial')).toEqual({ media: false, memoryLinks: false, mediaKinds: [] });
  });

  it('Premium uploads: photo and audio accepted, video refused (TIER_REQUIRED) in every section, with nothing reserved', async () => {
    const message = await newMessage('prem', 'MIXED');
    const memory = (await agents.prem.post(api('/memory-vault')).send({ title: 'Beach', category: 'OTHER' }).expect(201)).body.id;
    await agents.prem.put(api(`/my-story/prompts/${STORY}/response`)).send({ textContent: 'A house.' }).expect(200);
    await agents.prem.put(api(`/my-wishes/prompts/${WISH}/response`)).send({ textContent: 'Small.' }).expect(200);
    // Video exists in messages, My Story and My Wishes. The Memory Vault never takes video for any plan (Phase 12 rule,
    // validation + a database constraint), so there it stays the existing 400, not a tier refusal.
    const sections = [`/messages/${message}/media`, `/my-story/prompts/${STORY}/response/media`, `/my-wishes/prompts/${WISH}/response/media`];
    for (const path of [...sections, `/memory-vault/${memory}/media`]) {
      const before = await usage('prem');
      const video = await upload('prem', path, 'VIDEO');
      if (sections.includes(path)) expectVideoRefused(video, path);
      else expect([path, video.status]).toEqual([path, 400]);
      expect((await usage('prem')).reservedBytes).toBe(before.reservedBytes);
      await upload('prem', path, 'PHOTO').expect(201);
      await upload('prem', path, 'AUDIO').expect(201);
    }
    // A MIXED message's photos and audio are fine; only the video was refused.
    expect(await prisma.mediaAsset.count({ where: { messageId: message, kind: 'VIDEO' } })).toBe(0);
    expect(await prisma.mediaAsset.count({ where: { messageId: message, deletedAt: null } })).toBe(2);
  });

  it('Complete and unmapped paid: video uploads accepted', async () => {
    for (const n of ['comp', 'unm'] as const) await upload(n, `/messages/${await newMessage(n, 'VIDEO')}/media`, 'VIDEO').expect(201);
  });

  it('message formats: Premium can create PHOTO/AUDIO/MIXED, not VIDEO; a refused create writes nothing', async () => {
    for (const f of ['PHOTO', 'AUDIO', 'MIXED']) await newMessage('prem', f);
    const before = await prisma.message.count({ where: { ownerUserId: ids.prem } });
    expectVideoRefused(await agents.prem.post(api('/messages')).send({ title: 'Video', recipientIds: [people.prem], contentType: 'VIDEO' }), 'create VIDEO');
    expect(await prisma.message.count({ where: { ownerUserId: ids.prem } })).toBe(before);
  });

  it('existing video: text edits keep it, removing it works; switching to VIDEO or adding video is refused atomically', async () => {
    // A VIDEO message from a Complete era, with its READY video.
    const old = await prisma.message.create({ data: { ownerUserId: ids.prem, title: 'From before', contentType: 'VIDEO', status: 'DRAFT', recipients: { create: [{ recipientId: people.prem }] } }, select: { id: true } });
    const video = await prisma.mediaAsset.create({ data: { ...ready('prem', 'VIDEO'), messageId: old.id }, select: { id: true } });
    await agents.prem.patch(api(`/messages/${old.id}`)).send({ title: 'Renamed, video kept' }).expect(200);
    await agents.prem.patch(api(`/messages/${old.id}`)).send({ contentType: 'MIXED', textContent: 'And words.' }).expect(200); // MIXED keeps the same video
    expect((await agents.prem.get(api(`/messages/${old.id}/media/${video.id}/access-url`)).expect(200)).body.url).toEqual(expect.any(String));
    // A photo message can't become VIDEO, and the title sent with it is not saved either.
    const photo = await newMessage('prem', 'PHOTO');
    expectVideoRefused(await agents.prem.patch(api(`/messages/${photo}`)).send({ contentType: 'VIDEO', title: 'Must not save' }), 'PHOTO→VIDEO');
    const after = (await agents.prem.get(api(`/messages/${photo}`)).expect(200)).body;
    expect([after.contentType, after.title]).toEqual(['PHOTO', 'For Sofia']);
    // Replacing: a new video into the old VIDEO message is refused; removing the existing one is allowed.
    expectVideoRefused(await upload('prem', `/messages/${old.id}/media`, 'VIDEO'), 'replace');
    await agents.prem.delete(api(`/messages/${old.id}/media/${video.id}`)).expect(204);
  });

  it('version restore: going back to a VIDEO version is refused and changes nothing (versions hold no files)', async () => {
    const m = await prisma.message.create({
      data: {
        ownerUserId: ids.prem, title: 'Now text', contentType: 'TEXT', textContent: 'Current.', status: 'DRAFT', recipients: { create: [{ recipientId: people.prem }] },
        versions: { create: [{ version: 1, title: 'Was video', contentType: 'VIDEO', textContent: null, reason: 'CREATED' }, { version: 2, title: 'Now text', contentType: 'TEXT', textContent: 'Current.', reason: 'EDITED' }] },
      },
      select: { id: true, versions: { where: { version: 1 }, select: { id: true } } },
    });
    expectVideoRefused(await agents.prem.post(api(`/messages/${m.id}/versions/${m.versions[0].id}/restore`)).send({}), 'restore');
    expect((await agents.prem.get(api(`/messages/${m.id}`)).expect(200)).body).toMatchObject({ contentType: 'TEXT', title: 'Now text' });
    expect(await prisma.messageVersion.count({ where: { messageId: m.id } })).toBe(2);
  });

  it('conversions: copying an existing My Story / My Wishes video into a new message is refused (no message created); photos copy fine', async () => {
    const base = { title: 'From my story', includeText: true, recipientIds: [people.prem] };
    const story = await prisma.myStoryResponse.findFirstOrThrow({ where: { ownerUserId: ids.prem, promptKey: STORY }, select: { id: true } });
    const [sv, sp] = [
      await prisma.myStoryMediaAsset.create({ data: { ...ready('prem', 'VIDEO'), myStoryResponseId: story.id }, select: { id: true } }),
      await prisma.myStoryMediaAsset.create({ data: { ...ready('prem', 'PHOTO'), myStoryResponseId: story.id }, select: { id: true } }),
    ];
    const wish = await prisma.myWishResponse.findFirstOrThrow({ where: { ownerUserId: ids.prem, promptKey: WISH }, select: { id: true } });
    const wv = await prisma.myWishMediaAsset.create({ data: { ...ready('prem', 'VIDEO'), myWishResponseId: wish.id }, select: { id: true } });
    const before = await prisma.message.count({ where: { ownerUserId: ids.prem } });
    const storyCopy = (body: object) => agents.prem.post(api(`/my-story/prompts/${STORY}/response/messages`)).send({ ...base, ...body });
    expectVideoRefused(await storyCopy({ contentType: 'MIXED', mediaAssetIds: [sv.id, sp.id] }), 'story MIXED with a video');
    expectVideoRefused(await storyCopy({ contentType: 'VIDEO', mediaAssetIds: [sv.id] }), 'story VIDEO');
    expectVideoRefused(await agents.prem.post(api(`/my-wishes/prompts/${WISH}/response/messages`)).send({ ...base, contentType: 'VIDEO', mediaAssetIds: [wv.id] }), 'wish VIDEO');
    expect(await prisma.message.count({ where: { ownerUserId: ids.prem } })).toBe(before);
    await storyCopy({ contentType: 'MIXED', mediaAssetIds: [sp.id] }).expect(201);
    // The original files are untouched.
    expect(await prisma.myStoryMediaAsset.count({ where: { id: { in: [sv.id, sp.id] }, deletedAt: null } })).toBe(2);
    expect(await prisma.myWishMediaAsset.count({ where: { id: wv.id, deletedAt: null } })).toBe(1);
  });

  it('memory links: memories can never hold video (any plan), and a link exposes only id, title and category', async () => {
    const memory = (await agents.comp.post(api('/memory-vault')).send({ title: 'Linked', category: 'OTHER' }).expect(201)).body.id;
    // Complete can't add video to the vault either: the vault has no video, so a link can't reveal one.
    expect((await upload('comp', `/memory-vault/${memory}/media`, 'VIDEO')).status).toBe(400);
    const photo = await prisma.memoryVaultMediaAsset.create({ data: { ...ready('comp', 'PHOTO'), memoryVaultItemId: memory }, select: { id: true } });
    await setTier('comp', 'PREMIUM');
    try {
      const saved = (await agents.comp.put(api(`/my-story/prompts/${STORY}/response`)).send({ textContent: 'Linked.', memoryVaultItemIds: [memory] }).expect(200)).body;
      expect(saved.memories).toEqual([{ id: memory, title: 'Linked', category: 'OTHER' }]);
      expect(JSON.stringify((await agents.comp.get(api('/my-story/book')).expect(200)).body)).not.toContain(photo.id);
      // A linked memory's file is not one of the answer's files, so it can't be copied through the answer.
      expect((await agents.comp.post(api(`/my-story/prompts/${STORY}/response/messages`)).send({ title: 'x', includeText: true, recipientIds: [people.comp], contentType: 'PHOTO', mediaAssetIds: [photo.id] })).status).toBe(400);
    } finally {
      await setTier('comp', 'COMPLETE');
    }
  });

  it('downgrade mid-upload: a video reserved under Complete and finished under Premium is removed once, never READY; storage released once', async () => {
    const message = await newMessage('comp', 'MIXED');
    const existing = await prisma.mediaAsset.create({ data: { ...ready('comp', 'VIDEO'), messageId: message }, select: { id: true } });
    const before = await usage('comp');
    const started = (await upload('comp', `/messages/${message}/media`, 'VIDEO', 4000).expect(201)).body;
    const photo = (await upload('comp', `/messages/${message}/media`, 'PHOTO', 2000).expect(201)).body;
    expect((await usage('comp')).reservedBytes).toBe(before.reservedBytes + 6000);
    const videoFile = storage.upload(started.upload, { sizeBytes: 4000, contentType: 'video/mp4' });
    const photoFile = storage.upload(photo.upload, { sizeBytes: 2000, contentType: 'image/jpeg' });
    await setTier('comp', 'PREMIUM');
    try {
      const done = `/messages/${message}/media/${started.mediaAssetId}/complete`;
      expectVideoRefused(await agents.comp.post(api(done)).send({ providerFileId: videoFile }), 'complete video');
      expect(await prisma.mediaAsset.findUniqueOrThrow({ where: { id: started.mediaAssetId }, select: { status: true, deletedAt: true } })).toMatchObject({ status: 'PENDING_UPLOAD', deletedAt: expect.any(Date) });
      // Repeating is harmless: no live row, nothing else changes.
      expect((await agents.comp.post(api(done)).send({ providerFileId: videoFile })).status).toBe(404);
      // The photo (allowed) completes and is charged once: 2,000 moves from reserved to used.
      await agents.comp.post(api(`/messages/${message}/media/${photo.mediaAssetId}/complete`)).send({ providerFileId: photoFile }).expect(200);
      const after = await usage('comp');
      expect(after.reservedBytes).toBe(before.reservedBytes);
      expect(after.usedBytes).toBe(before.usedBytes + 2000);
      // The pre-existing video is untouched.
      expect(await prisma.mediaAsset.count({ where: { id: existing.id, deletedAt: null, status: 'READY' } })).toBe(1);
    } finally {
      await setTier('comp', 'COMPLETE');
    }
  });

  it('downgrade mid-upload in My Story and My Wishes: the video is removed once at completion, storage released once', async () => {
    await agents.comp.put(api(`/my-wishes/prompts/${WISH}/response`)).send({ textContent: 'Small.' }).expect(200);
    await agents.comp.put(api(`/my-story/prompts/${STORY}/response`)).send({ textContent: 'A house.' }).expect(200);
    const before = await usage('comp');
    const paths = [`/my-story/prompts/${STORY}/response/media`, `/my-wishes/prompts/${WISH}/response/media`];
    const started = [];
    for (const path of paths) {
      const s = (await upload('comp', path, 'VIDEO', 3000).expect(201)).body;
      started.push({ path, id: s.mediaAssetId as string, file: storage.upload(s.upload, { sizeBytes: 3000, contentType: 'video/mp4' }) });
    }
    expect((await usage('comp')).reservedBytes).toBe(before.reservedBytes + 6000);
    await setTier('comp', 'PREMIUM');
    try {
      for (const s of started) {
        expectVideoRefused(await agents.comp.post(api(`${s.path}/${s.id}/complete`)).send({ providerFileId: s.file }), `complete ${s.path}`);
        expect((await agents.comp.post(api(`${s.path}/${s.id}/complete`)).send({ providerFileId: s.file })).status).toBe(404);
      }
      expect(await prisma.myStoryMediaAsset.count({ where: { id: started[0].id, deletedAt: null } })).toBe(0);
      expect(await prisma.myWishMediaAsset.count({ where: { id: started[1].id, deletedAt: null } })).toBe(0);
      expect(await usage('comp')).toMatchObject({ reservedBytes: before.reservedBytes, usedBytes: before.usedBytes });
    } finally {
      await setTier('comp', 'COMPLETE');
    }
  });

  it('access ended mid-upload: completing is refused by the gate (402); the file never becomes READY', async () => {
    const message = await newMessage('prem', 'PHOTO');
    const started = (await upload('prem', `/messages/${message}/media`, 'PHOTO').expect(201)).body;
    const file = storage.upload(started.upload, { sizeBytes: 1000, contentType: 'image/jpeg' });
    await prisma.billingAccount.update({ where: { userId: ids.prem }, data: { subscriptionStatus: 'canceled', currentPeriodEnd: new Date(Date.now() - DAY) } });
    try {
      expect((await agents.prem.post(api(`/messages/${message}/media/${started.mediaAssetId}/complete`)).send({ providerFileId: file })).status).toBe(402);
      expect((await prisma.mediaAsset.findUniqueOrThrow({ where: { id: started.mediaAssetId } })).status).toBe('PENDING_UPLOAD');
    } finally {
      await prisma.billingAccount.update({ where: { userId: ids.prem }, data: { subscriptionStatus: 'active', currentPeriodEnd: new Date(Date.now() + 30 * DAY) } });
    }
  });

  it('a stored Premium tier without access: no bypass (402 on writes); existing videos stay readable and deletable', async () => {
    const m = await prisma.message.create({ data: { ownerUserId: ids.lapsed, title: 'Old', contentType: 'VIDEO', status: 'DRAFT' }, select: { id: true } });
    const v = await prisma.mediaAsset.create({ data: { ...ready('lapsed', 'VIDEO'), messageId: m.id }, select: { id: true } });
    expect((await upload('lapsed', `/messages/${m.id}/media`, 'PHOTO')).status).toBe(402);
    await agents.lapsed.get(api(`/messages/${m.id}/media/${v.id}/access-url`)).expect(200);
    await agents.lapsed.delete(api(`/messages/${m.id}/media/${v.id}`)).expect(204);
  });

  it('trial: unchanged PAID_FEATURE for any kind, including video', async () => {
    const m = await newMessage('trial');
    for (const kind of ['PHOTO', 'VIDEO'] as const) {
      const res = await upload('trial', `/messages/${m}/media`, kind);
      expect([res.status, res.body.code]).toEqual([409, PAID_FEATURE]);
    }
  });
});

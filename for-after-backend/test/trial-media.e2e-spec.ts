import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import { PAID_FEATURE, PAID_FEATURE_MESSAGE, TRIAL_DAYS } from '../src/billing/billing-access.js';
import { BILLING_REQUIRED } from '../src/billing/billing-access.interceptor.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
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
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Trial restrictions Step 4: written text is open in an enforced active trial; photos, recordings and videos (message
// formats, message media, My Story / My Wishes / Memory Vault media, and copies into messages) are paid-only.
// Real PostgreSQL; fake ImageKit and scanner; Stripe unconfigured. Synthetic READY rows stand for paid-era files.
describe('Trial paid-only media (e2e, PostgreSQL)', () => {
  const DAY = 86_400_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  const names = ['tia', 'lap', 'paid', 'old', 'eve'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `trialmedia.${n}.${run}@example.test`])) as Record<Name, string>;
  const password = 'StrongPassword123!';
  const storage = new FakeMediaStorage();
  const scanner = new FakeMalwareScanner();
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<Name, Agent>;
  const ids = {} as Record<Name, string>;
  const people = {} as Record<Name, string>;
  const vault = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const STORY = 'childhood.earliest-memory';
  const WISH = 'ceremony.style';
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    THROTTLE_KEY_PREFIX: `for_after:test_trial_media_throttle:${run}:`,
  };

  const photo = (sizeBytes = 1000) => ({ kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes, originalFileName: 'synthetic.jpg' });
  const message = (n: Name, contentType?: string) =>
    agents[n].post(api('/messages')).send({ title: 'Fictional', textContent: 'Written words.', recipientIds: [people[n]], ...(contentType && { contentType }) });
  const expectPaidOnly = (res: request.Response) => {
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, error: 'Conflict', code: PAID_FEATURE, message: PAID_FEATURE_MESSAGE });
  };
  const usage = async (n: Name) => (await agents[n].get(api('/users/me/storage')).expect(200)).body;
  const pendingRows = (n: Name) =>
    Promise.all([
      prisma.mediaAsset.count({ where: { ownerUserId: ids[n], deletedAt: null } }),
      prisma.memoryVaultMediaAsset.count({ where: { ownerUserId: ids[n], deletedAt: null, status: 'PENDING_UPLOAD' } }),
      prisma.myStoryMediaAsset.count({ where: { ownerUserId: ids[n], deletedAt: null } }),
      prisma.myWishMediaAsset.count({ where: { ownerUserId: ids[n], deletedAt: null } }),
    ]);
  const trialRow = (n: Name, endsAt: Date) => prisma.customerTrial.create({ data: { userId: ids[n], startedAt: new Date(endsAt.getTime() - TRIAL_DAYS * DAY), endsAt } });
  const paidAccount = (n: Name) =>
    prisma.billingAccount.create({
      data: { userId: ids[n], stripeCustomerId: `cus_fictional_media_${n}_${run}`, livemode: false, plan: 'monthly', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
    });
  // A verified file from before (paid era): no provider object, the storage is fake.
  const seedVaultFile = async (n: Name) =>
    (
      await prisma.memoryVaultMediaAsset.create({
        data: {
          ownerUserId: ids[n], memoryVaultItemId: vault[n], kind: 'PHOTO', status: 'READY',
          storageKey: `test/trial-media/${run}/${randomUUID()}.jpg`, providerFileId: `fake_${randomUUID()}`,
          originalFileName: 'synthetic.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, uploadedAt: new Date(),
        },
        select: { id: true },
      })
    ).id;

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule,
        RecipientsModule, MessagesModule, MediaModule, MemoryVaultModule, MyStoryModule, MyWishesModule,
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
    // Synthetic verified Customers, seeded directly (the register route's per-IP limit is shared with other suites).
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    for (const n of names) {
      ids[n] = (await prisma.user.create({ data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } })).id;
      // Seeded directly: some of these accounts must not be able to create anything.
      people[n] = (await prisma.recipient.create({ data: { ownerUserId: ids[n], firstName: 'Sofia' }, select: { id: true } })).id;
      vault[n] = (await prisma.memoryVaultItem.create({ data: { ownerUserId: ids[n], title: 'Fictional', category: 'OTHER', textContent: 'A memory.' }, select: { id: true } })).id;
    }
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - DAY) } });
    for (const n of names) {
      const agent = request.agent(app.getHttpServer());
      await agent.post(api('/auth/login')).send({ email: emails[n], password }).expect(200);
      agents[n] = agent;
    }
  });

  afterAll(async () => {
    for (const k of Object.keys(ENV)) delete process.env[k];
    await prisma?.user.deleteMany({ where: { email: { in: Object.values(emails) } } });
    await app?.close();
  });

  it('not started: writes stay refused by the gate (402); then the trial exposes features.media = false', async () => {
    expect((await message('tia').expect(402)).body.message).toBe(BILLING_REQUIRED);
    await agents.tia.post(api(`/memory-vault/${vault.tia}/media/upload-url`)).send(photo()).expect(402);
    const status = (await agents.tia.post(api('/billing/trial')).send({}).expect(200)).body;
    expect(status.state).toBe('trial_active');
    expect(status.features).toEqual({ media: false, memoryLinks: false, mediaKinds: [] }); // mediaKinds: Updated Plans Step 4 (additive)
  });

  it('text messages: created and edited; no message-count limit', async () => {
    const first = (await message('tia').expect(201)).body;
    expect(first.contentType).toBe('TEXT');
    await message('tia', 'TEXT').expect(201);
    await message('tia').expect(201);
    const edited = (await agents.tia.patch(api(`/messages/${first.id}`)).send({ textContent: 'Changed words.', title: 'Renamed' }).expect(200)).body;
    expect(edited).toMatchObject({ textContent: 'Changed words.', title: 'Renamed', contentType: 'TEXT' });
  });

  it('every non-text format is refused on create and on a format change', async () => {
    for (const contentType of ['PHOTO', 'AUDIO', 'VIDEO', 'MIXED']) expectPaidOnly(await message('tia', contentType));
    const draft = (await message('tia').expect(201)).body;
    expectPaidOnly(await agents.tia.patch(api(`/messages/${draft.id}`)).send({ contentType: 'AUDIO' }));
    expect((await agents.tia.get(api(`/messages/${draft.id}`)).expect(200)).body.contentType).toBe('TEXT');
  });

  it('message and content uploads are refused before any reservation, row or signed upload', async () => {
    const draft = (await message('tia').expect(201)).body;
    const signed = storage.createUpload.mock.calls.length;
    expectPaidOnly(await agents.tia.post(api(`/messages/${draft.id}/media/upload-url`)).send(photo()));
    expectPaidOnly(await agents.tia.post(api(`/memory-vault/${vault.tia}/media/upload-url`)).send(photo()));
    expectPaidOnly(await agents.tia.post(api(`/my-story/prompts/${STORY}/response/media/upload-url`)).send(photo()));
    expectPaidOnly(await agents.tia.post(api(`/my-wishes/prompts/${WISH}/response/media/upload-url`)).send(photo()));
    expect(storage.createUpload.mock.calls.length).toBe(signed);
    expect(await pendingRows('tia')).toEqual([0, 0, 0, 0]);
    expect((await usage('tia')).reservedBytes).toBe(0);
    // No empty answer was created for the refused story/wish uploads.
    expect(await prisma.myStoryResponse.count({ where: { ownerUserId: ids.tia } })).toBe(0);
    expect(await prisma.myWishResponse.count({ where: { ownerUserId: ids.tia } })).toBe(0);
  });

  it('text in My Story, My Wishes and Memory Vault is open', async () => {
    await agents.tia.put(api(`/my-story/prompts/${STORY}/response`)).send({ textContent: 'Written answer.' }).expect(200);
    await agents.tia.put(api(`/my-wishes/prompts/${WISH}/response`)).send({ textContent: 'Written wish.' }).expect(200);
    // Step 7: tia's one trial memory exists already (vault.tia); editing its text is open, a second memory is the cap's 409.
    await agents.tia.patch(api(`/memory-vault/${vault.tia}`)).send({ textContent: 'More words.' }).expect(200);
    const second = await agents.tia.post(api('/memory-vault')).send({ title: 'Text only', category: 'OTHER', textContent: 'Words.' });
    expect([second.status, second.body.code]).toEqual([409, 'TRIAL_LIMIT']);
  });

  it('conversions cannot carry media in: files or a non-text format refused; a text copy is allowed', async () => {
    const file = await seedVaultFile('tia');
    const base = { title: 'From content', includeText: true, recipientIds: [people.tia] };
    const before = await prisma.message.count({ where: { ownerUserId: ids.tia } });
    expectPaidOnly(await agents.tia.post(api(`/memory-vault/${vault.tia}/messages`)).send({ ...base, contentType: 'PHOTO', mediaAssetIds: [file] }));
    expectPaidOnly(await agents.tia.post(api(`/memory-vault/${vault.tia}/messages`)).send({ ...base, contentType: 'TEXT', mediaAssetIds: [file] }));
    expectPaidOnly(await agents.tia.post(api(`/my-story/prompts/${STORY}/response/messages`)).send({ ...base, contentType: 'AUDIO', mediaAssetIds: [] }));
    expectPaidOnly(await agents.tia.post(api(`/my-wishes/prompts/${WISH}/response/messages`)).send({ ...base, contentType: 'VIDEO', mediaAssetIds: [] }));
    expect(await prisma.message.count({ where: { ownerUserId: ids.tia } })).toBe(before);
    expect(await prisma.mediaAsset.count({ where: { ownerUserId: ids.tia } })).toBe(0);
    const copy = (await agents.tia.post(api(`/my-story/prompts/${STORY}/response/messages`)).send({ ...base, contentType: 'TEXT', mediaAssetIds: [] }).expect(201)).body;
    expect(copy).toMatchObject({ contentType: 'TEXT', textContent: 'Written answer.' });
  });

  it('existing files stay viewable and deletable during the trial', async () => {
    const file = await seedVaultFile('tia');
    await agents.tia.get(api(`/memory-vault/${vault.tia}/media/${file}/access-url`)).expect(200);
    await agents.tia.delete(api(`/memory-vault/${vault.tia}/media/${file}`)).expect(204);
    expect((await prisma.memoryVaultMediaAsset.findUniqueOrThrow({ where: { id: file } })).deletedAt).not.toBeNull();
  });

  it('a paid-era photo message: text edits keep its format and files; a different format or version is refused', async () => {
    // As if made while paid: PHOTO, one READY file, and an older AUDIO version in its history.
    const m = await prisma.message.create({
      data: {
        ownerUserId: ids.tia, title: 'Old photo message', contentType: 'PHOTO', textContent: 'Caption.', status: 'DRAFT',
        recipients: { create: [{ recipientId: people.tia }] },
        versions: { create: [{ version: 1, reason: 'CREATED', title: 'Old', contentType: 'AUDIO', textContent: 'Old.' }, { version: 2, reason: 'EDITED', title: 'Old photo message', contentType: 'PHOTO', textContent: 'Caption.' }] },
        mediaAssets: { create: [{ ownerUserId: ids.tia, kind: 'PHOTO', status: 'READY', storageKey: `test/trial-media/${run}/${randomUUID()}.jpg`, providerFileId: `fake_${randomUUID()}`, originalFileName: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, uploadedAt: new Date() }] },
      },
      select: { id: true, versions: { select: { id: true, version: true } } },
    });
    const saved = (await agents.tia.patch(api(`/messages/${m.id}`)).send({ textContent: 'New caption.', contentType: 'PHOTO' }).expect(200)).body;
    expect(saved).toMatchObject({ contentType: 'PHOTO', textContent: 'New caption.' });
    const files = (await agents.tia.get(api(`/messages/${m.id}/media`)).expect(200)).body;
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('READY');
    expectPaidOnly(await agents.tia.patch(api(`/messages/${m.id}`)).send({ contentType: 'MIXED' }));
    const audioVersion = m.versions.find((v) => v.version === 1)!;
    expectPaidOnly(await agents.tia.post(api(`/messages/${m.id}/versions/${audioVersion.id}/restore`)));
    await agents.tia.get(api(`/messages/${m.id}/media/${files[0].id}/access-url`)).expect(200);
    expectPaidOnly(await agents.tia.post(api(`/messages/${m.id}/media/upload-url`)).send(photo()));
  });

  it('an upload signed while paid but completed after paid access lapsed (trial still running) is removed, never READY', async () => {
    await trialRow('lap', new Date(Date.now() + DAY));
    await paidAccount('lap');
    const up = (await agents.lap.post(api(`/memory-vault/${vault.lap}/media/upload-url`)).send(photo(2000)).expect(201)).body;
    expect((await usage('lap')).reservedBytes).toBe(2000);
    const providerFileId = storage.upload(up.upload, { sizeBytes: 2000, contentType: 'image/jpeg' });
    // The subscription ends; the trial dates still run, so the account is back in the trial.
    await prisma.billingAccount.update({ where: { userId: ids.lap }, data: { subscriptionStatus: 'canceled', currentPeriodEnd: new Date(Date.now() - 1000) } });
    const verified = storage.verifyUpload.mock.calls.length;
    expectPaidOnly(await agents.lap.post(api(`/memory-vault/${vault.lap}/media/${up.mediaAssetId}/complete`)).send({ providerFileId }));
    expect(storage.verifyUpload.mock.calls.length).toBe(verified); // never verified or scanned
    const row = await prisma.memoryVaultMediaAsset.findUniqueOrThrow({ where: { id: up.mediaAssetId } });
    expect(row.status).toBe('PENDING_UPLOAD');
    expect(row.deletedAt).not.toBeNull();
    expect((await usage('lap')).reservedBytes).toBe(0);
    // Retrying the completion now finds nothing to complete.
    await agents.lap.post(api(`/memory-vault/${vault.lap}/media/${up.mediaAssetId}/complete`)).send({ providerFileId }).expect(404);
  });

  it('paid (over active trial dates) and grandfathered accounts keep every format and upload', async () => {
    await trialRow('paid', new Date(Date.now() + DAY));
    await paidAccount('paid');
    for (const n of ['paid', 'old'] as const) {
      expect((await agents[n].get(api('/billing')).expect(200)).body.features).toEqual({ media: true, memoryLinks: true, mediaKinds: ['PHOTO', 'AUDIO', 'VIDEO'] });
      const m = (await message(n, 'PHOTO').expect(201)).body;
      await agents[n].post(api(`/messages/${m.id}/media/upload-url`)).send(photo()).expect(201);
      await agents[n].post(api(`/memory-vault/${vault[n]}/media/upload-url`)).send(photo()).expect(201);
      await agents[n].post(api(`/my-story/prompts/${STORY}/response/media/upload-url`)).send(photo()).expect(201);
      await agents[n].post(api(`/my-wishes/prompts/${WISH}/response/media/upload-url`)).send(photo()).expect(201);
    }
  });

  it('an expired trial: every write stays refused by the gate (402), reads still work', async () => {
    const file = await seedVaultFile('eve');
    await trialRow('eve', new Date(Date.now() - 1000));
    expect((await message('eve').expect(402)).body.message).toBe(BILLING_REQUIRED);
    await message('eve', 'PHOTO').expect(402);
    await agents.eve.post(api(`/memory-vault/${vault.eve}/media/upload-url`)).send(photo()).expect(402);
    await agents.eve.get(api(`/memory-vault/${vault.eve}/media/${file}/access-url`)).expect(200);
    await agents.eve.delete(api(`/memory-vault/${vault.eve}/media/${file}`)).expect(204);
  });
});

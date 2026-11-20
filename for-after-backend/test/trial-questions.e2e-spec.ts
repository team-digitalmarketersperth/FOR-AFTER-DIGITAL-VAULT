import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import session from 'express-session';
import request from 'supertest';
import { AuthModule } from '../src/auth/auth.module.js';
import {
  PAID_FEATURE,
  PAID_MEMORY_LINK_MESSAGE,
  TRIAL_DAYS,
  TRIAL_LIMIT,
  TRIAL_QUESTION_LIMIT,
} from '../src/billing/billing-access.js';
import { BILLING_REQUIRED } from '../src/billing/billing-access.interceptor.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { MediaModule } from '../src/media/media.module.js';
import { MalwareScanner } from '../src/media/scanner/malware-scanner.service.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { MemoryVaultModule } from '../src/memory-vault/memory-vault.module.js';
import { MyStoryModule } from '../src/my-story/my-story.module.js';
import { MyWishesModule } from '../src/my-wishes/my-wishes.module.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';
import { FakeMalwareScanner } from './fake-malware-scanner.js';
import { FakeMediaStorage } from './fake-media-storage.js';

// Trial restrictions Step 5: four questions with written answers, My Story and My Wishes combined, in an enforced
// active trial. Real PostgreSQL (row locks); fake ImageKit and scanner; Stripe unconfigured (never called).
describe('Trial question slots (e2e, PostgreSQL)', () => {
  const DAY = 86_400_000;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const run = Date.now();
  // Five accounts: sign-in is limited to five per minute per IP.
  const names = ['tia', 'con', 'big', 'paid', 'old'] as const;
  type Name = (typeof names)[number];
  const emails = Object.fromEntries(names.map((n) => [n, `trialquestions.${n}.${run}@example.test`])) as Record<Name, string>;
  const password = 'StrongPassword123!';
  type Agent = ReturnType<typeof request.agent>;
  const agents = {} as Record<Name, Agent>;
  const ids = {} as Record<Name, string>;
  const vault = {} as Record<Name, string>;
  const api = (p: string) => `/api/v1${p}`;
  const S = ['childhood.earliest-memory', 'childhood.home', 'childhood.school', 'family.influence', 'family.lesson-from-parents', 'family.tradition'];
  const W = ['ceremony.style', 'ceremony.setting', 'atmosphere.feeling', 'music-and-readings.music', 'music-and-readings.readings', 'people-and-traditions.involvement'];
  const ENV = {
    BILLING_ENABLED: 'true',
    BILLING_ENFORCE_FROM: new Date(run - 60_000).toISOString(),
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    THROTTLE_KEY_PREFIX: `for_after:test_trial_questions_throttle:${run}:`,
  };

  const story = (n: Name, key: string, body: object = { textContent: 'Written words.' }) =>
    agents[n].put(api(`/my-story/prompts/${key}/response`)).send(body);
  const wish = (n: Name, key: string, body: object = { textContent: 'Written words.' }) =>
    agents[n].put(api(`/my-wishes/prompts/${key}/response`)).send(body);
  const used = async (n: Name) => (await agents[n].get(api('/billing')).expect(200)).body.questionsAnswered as number;
  const expectLimit = (res: request.Response, message = TRIAL_QUESTION_LIMIT) => {
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, error: 'Conflict', code: TRIAL_LIMIT, message });
  };
  const trialRow = (n: Name, endsAt: Date) =>
    prisma.customerTrial.create({ data: { userId: ids[n], startedAt: new Date(endsAt.getTime() - TRIAL_DAYS * DAY), endsAt } });
  const seedAnswer = (n: Name, area: 'story' | 'wish', promptKey: string, textContent: string | null) => {
    const data = { ownerUserId: ids[n], promptKey, promptTextSnapshot: 'Fictional', promptVersion: 1, textContent };
    return area === 'story'
      ? prisma.myStoryResponse.create({ data, select: { id: true } })
      : prisma.myWishResponse.create({ data, select: { id: true } });
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, BillingModule,
        MediaModule, MemoryVaultModule, MyStoryModule, MyWishesModule,
      ],
    })
      .overrideProvider(MediaStorage)
      .useValue(new FakeMediaStorage())
      .overrideProvider(MalwareScanner)
      .useValue(new FakeMalwareScanner())
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
    prisma = app.get(PrismaService);
    // Synthetic verified Customers, seeded directly (the register route's per-IP limit is shared with other suites).
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    for (const n of names) {
      ids[n] = (await prisma.user.create({ data: { email: emails[n], passwordHash, firstName: n, lastName: 'Test', role: 'CUSTOMER', emailVerifiedAt: new Date() }, select: { id: true } })).id;
      vault[n] = (await prisma.memoryVaultItem.create({ data: { ownerUserId: ids[n], title: 'Fictional', category: 'OTHER', textContent: 'A memory.' }, select: { id: true } })).id;
    }
    await prisma.user.update({ where: { id: ids.old }, data: { createdAt: new Date(run - DAY) } });
    const later = new Date(Date.now() + 3 * DAY);
    for (const n of ['con', 'big', 'old'] as const) await trialRow(n, later);
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

  it('not started and expired: saves stay refused by the gate (402); expired keeps read and delete', async () => {
    expect((await story('paid', S[0])).status).toBe(402);
    expect((await wish('paid', W[0])).body.message).toBe(BILLING_REQUIRED);
    await trialRow('paid', new Date(Date.now() - DAY));
    await seedAnswer('paid', 'story', S[0], 'From before.');
    expect((await story('paid', S[0], { textContent: 'Changed.' })).status).toBe(402);
    expect((await story('paid', S[1])).status).toBe(402);
    await agents.paid.get(api(`/my-story/prompts/${S[0]}/response`)).expect(200);
    await agents.paid.delete(api(`/my-story/prompts/${S[0]}/response`)).expect(204);
    // Then paid, with trial dates that are still running: paid wins (used below).
    await prisma.customerTrial.update({ where: { userId: ids.paid }, data: { endsAt: new Date(Date.now() + 3 * DAY) } });
    await prisma.billingAccount.create({
      data: { userId: ids.paid, stripeCustomerId: `cus_fictional_questions_${run}`, livemode: false, plan: 'monthly', subscriptionStatus: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: new Date(Date.now() + 30 * DAY) },
    });
  });

  it('four answers split across both sections succeed; a fifth in either section is refused with nothing saved', async () => {
    const status = (await agents.tia.post(api('/billing/trial')).send({}).expect(200)).body;
    expect(status).toMatchObject({ state: 'trial_active', questionsAnswered: 0 });
    expect(status.trialCaps.questions).toBe(4);
    await story('tia', S[0]).expect(200);
    await wish('tia', W[0]).expect(200);
    await story('tia', S[1]).expect(200);
    await wish('tia', W[1]).expect(200);
    expect(await used('tia')).toBe(4);
    expectLimit(await story('tia', S[2]));
    expectLimit(await wish('tia', W[2]));
    expect(await prisma.myStoryResponse.count({ where: { ownerUserId: ids.tia, promptKey: S[2] } })).toBe(0);
    expect(await prisma.myWishResponse.count({ where: { ownerUserId: ids.tia, promptKey: W[2] } })).toBe(0);
    // The list still shows the unanswered questions (the app marks them Pro).
    const list = (await agents.tia.get(api('/my-wishes/prompts')).expect(200)).body as { key: string; answered: boolean }[];
    expect(list.find((p) => p.key === W[2])).toMatchObject({ answered: false });
  });

  it('at the cap: edits, repeated saves and private notes on answered questions never take a slot', async () => {
    await story('tia', S[0], { textContent: 'Edited words.' }).expect(200);
    await wish('tia', W[0], { textContent: 'Written words.' }).expect(200);
    await wish('tia', W[0], { textContent: 'Written words.' }).expect(200);
    await story('tia', S[1], { privateNote: 'A reminder.' }).expect(200);
    await story('tia', S[1], {}).expect(200);
    expect(await used('tia')).toBe(4);
  });

  it('empty and whitespace answers never take a slot', async () => {
    for (const textContent of ['', '   ', '\n\t ']) {
      expect((await story('tia', S[3], { textContent })).status).toBe(400);
      expect((await wish('tia', W[3], { textContent })).status).toBe(400);
    }
    // Null text on an unanswered question is an empty answer (400), not a slot refusal.
    expect((await story('tia', S[3], { textContent: null })).status).toBe(400);
    expect((await wish('tia', W[3], { privateNote: 'Only a note.' })).status).toBe(400);
    expect(await used('tia')).toBe(4);
  });

  it('deleting an answer frees its slot for any question in either section; re-answering respects the cap', async () => {
    await agents.tia.delete(api(`/my-wishes/prompts/${W[1]}/response`)).expect(204);
    expect(await used('tia')).toBe(3);
    await story('tia', S[2]).expect(200);
    expect(await used('tia')).toBe(4);
    expectLimit(await wish('tia', W[1])); // re-answering the deleted one now needs a slot again
    await agents.tia.delete(api(`/my-story/prompts/${S[2]}/response`)).expect(204);
    await wish('tia', W[1], { textContent: 'Written again.' }).expect(200);
    expect(await used('tia')).toBe(4);
  });

  it('clearing the words releases the slot and keeps the linked memory; re-adding words needs a slot', async () => {
    // A link from before the trial (paid era) on an answered question.
    const { id } = (await prisma.myStoryResponse.findUnique({ where: { ownerUserId_promptKey: { ownerUserId: ids.tia, promptKey: S[1] } }, select: { id: true } }))!;
    await prisma.myStoryMemoryLink.create({ data: { myStoryResponseId: id, memoryVaultItemId: vault.tia } });
    const cleared = (await story('tia', S[1], { textContent: null }).expect(200)).body;
    expect(cleared).toMatchObject({ textContent: null, memories: [{ id: vault.tia }] });
    expect(await used('tia')).toBe(3);
    await wish('tia', W[2]).expect(200);
    expectLimit(await story('tia', S[1], { textContent: 'Words again.' }));
    // Its memory is untouched, and the memory-only answer stays readable and deletable.
    expect(await prisma.memoryVaultItem.count({ where: { id: vault.tia, deletedAt: null } })).toBe(1);
    await agents.tia.get(api(`/my-story/prompts/${S[1]}/response`)).expect(200);
    await story('tia', S[1], { memoryVaultItemIds: [vault.tia] }).expect(200); // same set: no change
  });

  it('memory links in the trial: no new or replacement links; unchanged links kept; unlinking open; nothing deleted', async () => {
    const other = (await prisma.memoryVaultItem.create({ data: { ownerUserId: ids.tia, title: 'Another', category: 'OTHER' }, select: { id: true } })).id;
    // S[0] has words; give it a paid-era link and a READY file, both seeded directly.
    const s0 = (await prisma.myStoryResponse.findUnique({ where: { ownerUserId_promptKey: { ownerUserId: ids.tia, promptKey: S[0] } }, select: { id: true } }))!.id;
    await prisma.myStoryMemoryLink.create({ data: { myStoryResponseId: s0, memoryVaultItemId: vault.tia } });
    await prisma.myStoryMediaAsset.create({
      data: { ownerUserId: ids.tia, myStoryResponseId: s0, kind: 'PHOTO', status: 'READY', storageKey: `test/trial-questions/${run}/s0.jpg`, providerFileId: `fake_s0_${run}`, originalFileName: 'synthetic.jpg', mimeType: 'image/jpeg', sizeBytes: 1000, uploadedAt: new Date() },
    });
    const read = async (key: string) => (await agents.tia.get(api(`/my-story/prompts/${key}/response`)).expect(200)).body;
    const expectLinkRefused = (res: request.Response) => {
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ statusCode: 409, error: 'Conflict', code: PAID_FEATURE, message: PAID_MEMORY_LINK_MESSAGE });
    };
    const before = await read(S[0]);

    // New link added to a written answer, with a text change in the same request: refused, nothing saved.
    expectLinkRefused(await story('tia', S[0], { textContent: 'Not saved.', memoryVaultItemIds: [vault.tia, other] }));
    // Replacement set, and a new id in another letter case: refused.
    expectLinkRefused(await story('tia', S[0], { memoryVaultItemIds: [other] }));
    expectLinkRefused(await story('tia', S[0], { memoryVaultItemIds: [vault.tia, other.toUpperCase()] }));
    // A link-only first answer, and a new link on the memory-only answer S[1]: refused, no row created.
    expectLinkRefused(await story('tia', S[4], { memoryVaultItemIds: [other] }));
    expect(await prisma.myStoryResponse.count({ where: { ownerUserId: ids.tia, promptKey: S[4] } })).toBe(0);
    expectLinkRefused(await story('tia', S[1], { memoryVaultItemIds: [vault.tia, other] }));
    const after = await read(S[0]);
    expect(after).toMatchObject({ textContent: before.textContent, mediaCount: 1, memories: [expect.objectContaining({ id: vault.tia })] });
    expect(await used('tia')).toBe(4);

    // Unchanged links with a text save (also as upper-case ids): allowed, links kept.
    const kept = (await story('tia', S[0], { textContent: 'Edited with links.', memoryVaultItemIds: [vault.tia.toUpperCase()] }).expect(200)).body;
    expect(kept).toMatchObject({ textContent: 'Edited with links.', memories: [expect.objectContaining({ id: vault.tia })] });
    // A text-only save (links omitted, as the app sends it): links and the file kept.
    expect((await story('tia', S[0], { textContent: 'Edited again.' }).expect(200)).body).toMatchObject({ mediaCount: 1, memories: [expect.objectContaining({ id: vault.tia })] });

    // Removing links: allowed; the memories and the answer's file are untouched.
    expect((await story('tia', S[0], { memoryVaultItemIds: [] }).expect(200)).body.memories).toEqual([]);
    expect(await prisma.memoryVaultItem.count({ where: { id: { in: [vault.tia, other] }, deletedAt: null } })).toBe(2);
    expect(await prisma.myStoryMediaAsset.count({ where: { myStoryResponseId: s0, deletedAt: null } })).toBe(1);
    // Re-adding the link just removed is a new link: refused.
    expectLinkRefused(await story('tia', S[0], { memoryVaultItemIds: [vault.tia] }));
    // Deleting the memory-only answer: allowed; its memory stays.
    await agents.tia.delete(api(`/my-story/prompts/${S[1]}/response`)).expect(204);
    expect(await prisma.memoryVaultItem.count({ where: { id: vault.tia, deletedAt: null } })).toBe(1);
    expect(await used('tia')).toBe(4);
  });

  it('Memory Vault entries are not questions; Step 4 media stays paid-only', async () => {
    const before = await used('tia');
    // Step 7: the trial's one memory is already used (seeded), so a new one is refused by its own cap, never as a question.
    const create = await agents.tia.post(api('/memory-vault')).send({ title: 'Fictional', category: 'OTHER', textContent: 'Words.' });
    expect([create.status, create.body.code]).toEqual([409, 'TRIAL_LIMIT']);
    await agents.tia.patch(api(`/memory-vault/${vault.tia}`)).send({ textContent: 'Edited words.' }).expect(200);
    expect(await used('tia')).toBe(before);
    const res = await agents.tia
      .post(api(`/my-story/prompts/${S[5]}/response/media/upload-url`))
      .send({ kind: 'PHOTO', mimeType: 'image/jpeg', sizeBytes: 1000, originalFileName: 'synthetic.jpg' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe(PAID_FEATURE);
  });

  it('concurrent saves across both sections at the boundary never pass four', async () => {
    await story('con', S[0]).expect(200);
    await story('con', S[1]).expect(200);
    await wish('con', W[0]).expect(200);
    const results = await Promise.all([story('con', S[2]), wish('con', W[1]), story('con', S[3]), wish('con', W[2]), wish('con', W[3])]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 200)) expectLimit(r);
    expect(await used('con')).toBe(4);
    // From zero (synthetic rows reset), eight parallel first answers: exactly four land.
    const reset = () => Promise.all([prisma.myStoryResponse.deleteMany({ where: { ownerUserId: ids.con } }), prisma.myWishResponse.deleteMany({ where: { ownerUserId: ids.con } })]);
    await reset();
    const burst = await Promise.all([...S.slice(0, 4).map((k) => story('con', k)), ...W.slice(0, 4).map((k) => wish('con', k))]);
    expect(burst.filter((r) => r.status === 200)).toHaveLength(4);
    expect(await used('con')).toBe(4);
    // The same new question saved twice at once uses one slot.
    await reset();
    const twice = await Promise.all([wish('con', W[5]), wish('con', W[5])]);
    expect(twice.map((r) => r.status)).toEqual([200, 200]);
    expect(await used('con')).toBe(1);
  });

  it('accounts already above four keep, edit, clear-to-delete and read their answers; new questions are refused', async () => {
    for (const k of S.slice(0, 3)) await seedAnswer('big', 'story', k, 'From before.');
    for (const k of W.slice(0, 3)) await seedAnswer('big', 'wish', k, 'From before.');
    expect(await used('big')).toBe(6);
    await story('big', S[0], { textContent: 'Edited in the trial.' }).expect(200);
    await wish('big', W[2], { textContent: 'Edited in the trial.' }).expect(200);
    expectLimit(await story('big', S[3]));
    expectLimit(await wish('big', W[3]));
    await agents.big.delete(api(`/my-story/prompts/${S[1]}/response`)).expect(204);
    await agents.big.delete(api(`/my-wishes/prompts/${W[1]}/response`)).expect(204);
    expect(await used('big')).toBe(4);
    expectLimit(await story('big', S[3])); // still at the cap
    const list = (await agents.big.get(api('/my-story/prompts')).expect(200)).body as { key: string; answered: boolean }[];
    expect(list.filter((p) => p.answered).map((p) => p.key).sort()).toEqual([S[0], S[2]].sort());
  });

  it('paid wins over trial dates; grandfathered accounts are unchanged', async () => {
    for (const n of ['paid', 'old'] as const) {
      for (const k of S.slice(0, 3)) await story(n, k).expect(200);
      for (const k of W.slice(0, 3)) await wish(n, k).expect(200);
      // Memory links stay open: add, replace and unlink.
      const memo = (await prisma.memoryVaultItem.create({ data: { ownerUserId: ids[n], title: 'Fictional', category: 'OTHER' }, select: { id: true } })).id;
      expect((await story(n, S[0], { memoryVaultItemIds: [memo] }).expect(200)).body.memories).toEqual([expect.objectContaining({ id: memo })]);
      expect((await story(n, S[3], { memoryVaultItemIds: [memo] }).expect(200)).body.textContent).toBeNull(); // memory-only answer
      await story(n, S[0], { memoryVaultItemIds: [] }).expect(200);
      const status = (await agents[n].get(api('/billing')).expect(200)).body;
      expect(status.features).toEqual({ media: true, memoryLinks: true, mediaKinds: ['PHOTO', 'AUDIO', 'VIDEO'] });
      expect(status.trialCaps.questions).toBeNull();
      expect(status.questionsAnswered).toBe(6);
    }
  });

  it('ownership: another Customer’s answers never count, and forged fields are rejected', async () => {
    // tia is at four; con (one answer) still has its own three slots.
    expect(await used('tia')).toBe(4);
    await story('con', S[0]).expect(200);
    await story('con', S[1]).expect(200);
    await wish('con', W[0]).expect(200);
    expect(await used('con')).toBe(4);
    expect(await used('tia')).toBe(4);
    expect((await story('tia', S[0], { textContent: 'x', ownerUserId: ids.con })).status).toBe(400);
    expect((await wish('tia', W[0], { textContent: 'x', promptKey: W[3] })).status).toBe(400);
    // con cannot link tia's memory (400, same as a missing one), even to its own written answer.
    expect((await story('con', S[0], { memoryVaultItemIds: [vault.tia] })).status).toBe(400);
    expect(await used('con')).toBe(4);
  });
});

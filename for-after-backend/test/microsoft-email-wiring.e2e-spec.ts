import { ConfidentialClientApplication } from '@azure/msal-node';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { DeadLetterService } from '../src/dead-letters/dead-letter.service.js';
import { EmailProvider } from '../src/email/email-provider.js';
import { MicrosoftGraphEmailProvider } from '../src/email/microsoft-email-provider.js';
import { MediaStorage } from '../src/media/storage/media-storage.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { WorkerModule } from '../src/worker.module.js';

// EMAIL_PROVIDER=microsoft through the production composition roots (API:
// AppModule, worker: WorkerModule), with NO real Microsoft access: fictional
// credentials, MSAL's token call stubbed, and every request to Graph answered
// by a local stub. Proves API emails, worker emails and ops alerts all go
// through Microsoft Graph, and that Graph failures use the existing retries.
describe('Microsoft Graph email in the API and the worker (e2e)', () => {
  const run = Date.now();
  const MAILBOX = 'notifications@forafter.test';
  const OPS = `ops.${run}@forafter.test`;
  const owner = `msgraph.owner.${run}@forafter.test`;
  const sofia = `msgraph.sofia.${run}@forafter.test`;
  const password = 'StrongPassword123!';
  const SEND_URL = 'https://graph.microsoft.com/v1.0/users/notifications%40forafter.test/sendMail';

  type Sent = { to: string; subject: string; auth: string | null };
  const graph: Sent[] = [];
  // Queue of non-default answers for the next Graph calls (e.g. one 429).
  const answers: Array<() => Response> = [];
  const realFetch = globalThis.fetch;
  const urlOf = (input: string | URL | Request) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const fetchStub = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.startsWith('https://graph.microsoft.com/')) {
      expect(url).toBe(SEND_URL);
      const body = JSON.parse(init?.body as string) as { message: { subject: string; toRecipients: { emailAddress: { address: string } }[] } };
      graph.push({
        to: body.message.toRecipients[0].emailAddress.address,
        subject: body.message.subject,
        auth: new Headers(init?.headers).get('authorization'),
      });
      const next = answers.shift();
      return next ? next() : new Response(null, { status: 202, headers: { 'request-id': `req-${graph.length}` } });
    }
    if (/login\.microsoftonline\.com|graph\.microsoft\.com/.test(url)) throw new Error(`unexpected Microsoft call: ${url}`);
    return realFetch(input, init);
  });

  let api: NestExpressApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (check: () => Promise<boolean> | boolean, ms = 20_000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await check()) return;
    throw new Error('condition not met in time');
  };

  beforeAll(async () => {
    // Fictional app registration; process.env wins over any value in .env.
    Object.assign(process.env, {
      EMAIL_PROVIDER: 'microsoft',
      MS_TENANT_ID: '7f3c2a10-5b4d-4e6f-8a9b-0c1d2e3f4a5b',
      MS_CLIENT_ID: '2b9e4d71-6c3a-4f8e-9d1b-5a7c3e2f1d0a',
      MS_CLIENT_SECRET: 'Fq8~wiring.Test-NotReal_9xY2zW4vU6tS8rQ0',
      MS_SENDER_MAILBOX: MAILBOX,
      EMAIL_FROM: MAILBOX,
      APP_BASE_URL: 'http://localhost:3000',
      OPS_ALERT_EMAIL: OPS,
      OPS_ALERT_RECONCILE_INTERVAL_SECONDS: '0',
      RELEASE_QUEUE_NAME: `test-msgraph-release-${run}`,
      EMAIL_QUEUE_NAME: `test-msgraph-email-${run}`,
      DEATH_VERIFICATION_QUEUE_NAME: `test-msgraph-death-${run}`,
      // Test-only: retry a throttled email after 0.5 s instead of 30 s.
      EMAIL_JOB_BACKOFF_MS: '500',
    });
    vi.spyOn(ConfidentialClientApplication.prototype, 'acquireTokenByClientCredential').mockResolvedValue({
      accessToken: 'fake-graph-token',
    } as never);
    vi.stubGlobal('fetch', fetchStub);

    const apiRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(MediaStorage).useValue({}).compile();
    api = apiRef.createNestApplication<NestExpressApplication>({ logger: false });
    configureApp(api, new session.MemoryStore());
    await api.init();
    prisma = api.get(PrismaService);
    worker = await (await Test.createTestingModule({ imports: [WorkerModule] }).compile()).init();
  });

  afterAll(async () => {
    await worker?.close();
    await prisma?.user.deleteMany({ where: { email: owner } });
    await api?.close();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the API and the worker each build the Microsoft Graph provider', () => {
    expect(api.get(EmailProvider)).toBeInstanceOf(MicrosoftGraphEmailProvider);
    expect(worker.get(EmailProvider)).toBeInstanceOf(MicrosoftGraphEmailProvider);
    expect(api.get(EmailProvider).name).toBe('microsoft');
  });

  it('API-originated: registration sends the verification email through Graph, with the app-only token', async () => {
    await request(api.getHttpServer()).post('/api/v1/auth/register').send({ email: owner, password, firstName: 'Lisa', lastName: 'Test' }).expect(201);
    await until(() => graph.some((g) => g.to === owner));
    expect(graph.find((g) => g.to === owner)).toMatchObject({ auth: 'Bearer fake-graph-token' });
  });

  it('worker-originated: a release emails the Recipient through Graph; a 429 is retried by the queue, then SENT', async () => {
    const lisa = request.agent(api.getHttpServer());
    await lisa.post('/api/v1/auth/login').send({ email: owner, password }).expect(200);
    const recipientId = (await lisa.post('/api/v1/recipients').send({ firstName: 'Sofia', email: sofia }).expect(201)).body.id as string;
    const messageId = (
      await lisa
        .post('/api/v1/messages')
        .send({ title: 'Graph wiring', contentType: 'TEXT', textContent: 'Fictional text.', recipientIds: [recipientId] })
        .expect(201)
    ).body.id as string;
    // The first Graph answer for this email is a throttle.
    answers.push(() => new Response(JSON.stringify({ error: { code: 'ApplicationThrottled' } }), { status: 429, headers: { 'retry-after': '1' } }));
    await lisa.post(`/api/v1/messages/${messageId}/schedule`).send({ triggerType: 'NOW' }).expect(201);

    const row = () => prisma.releaseNotification.findFirst({ where: { grant: { messageId } } });
    await until(async () => (await row())?.status === 'SENT', 30_000);
    const sent = await row();
    expect(sent).toMatchObject({ status: 'SENT', attemptCount: 2, lastErrorCode: null });
    // The Graph request id of the accepted (202) attempt; acceptance, not delivery.
    expect(sent?.providerMessageId).toMatch(/^req-\d+$/);
    const toSofia = graph.filter((g) => g.to === sofia);
    expect(toSofia).toHaveLength(2);
    expect(toSofia.every((g) => g.subject === 'A message is waiting for you')).toBe(true);
  });

  it('ops alerts from the worker go straight through Graph (never a queue)', async () => {
    const before = graph.length;
    const job = { id: `msgraph-alert-${run}`, name: 'message-released', attemptsMade: 5, finishedOn: Date.now(), data: { notificationId: randomUUID() } } as unknown as Job;
    expect(await worker.get(DeadLetterService).record('email-delivery', job, Object.assign(new Error('email_send_failed: forbidden'), { code: 'forbidden_ErrorAccessDenied' }))).not.toBeNull();
    const alerts = graph.slice(before).filter((g) => g.to === OPS);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].subject).toBe('For After queue failure requires attention');
  });

  it('nothing reached Microsoft for real: no token endpoint call, only the stubbed Graph endpoint', () => {
    const urls = fetchStub.mock.calls.map(([u]) => urlOf(u));
    expect(urls.filter((u) => u.includes('microsoft')).every((u) => u === SEND_URL)).toBe(true);
  });
});

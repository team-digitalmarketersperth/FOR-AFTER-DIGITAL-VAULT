import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import { randomUUID } from 'node:crypto';
import session from 'express-session';
import request from 'supertest';
import { adminSignIn } from './admin-sign-in.js';
import { AdminModule } from '../src/admin/admin.module.js';
import { AuthModule } from '../src/auth/auth.module.js';
import { BillingModule } from '../src/billing/billing.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { IpBlockService } from '../src/ip-blocks/ip-block.service.js';
import { PrismaModule } from '../src/prisma/prisma.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { RedisModule } from '../src/redis/redis.module.js';

// Real HTTP, guards, middleware and PostgreSQL. Every address is from a reserved
// documentation range, so no real client can ever be affected. "The load balancer"
// is X-Forwarded-For plus `trust proxy = 1`, the documented production setting.
const BLOCKED_MESSAGE = 'Access from this network is temporarily unavailable.';
const api = (path: string) => `/api/v1${path}`;
// Unique per run: rows outlive a run in the isolated DB, and files run in parallel.
let next = 1 + Math.floor(Math.random() * 180);
const uniqueIp = () => `203.0.113.${next++}`;

describe('Temporary IP blocks and Security activity aggregates (e2e)', () => {
  const tag = randomUUID().slice(0, 8);
  const at = (name: string) => `ipb.${name}.${tag}@example.test`;
  const password = 'StrongPassword123!';
  const apps: NestExpressApplication[] = [];
  let a: NestExpressApplication; // verified attribution, trust proxy = 1 hop
  let b: NestExpressApplication; // a second instance on the same database
  let off: NestExpressApplication; // attribution not verified (the default)
  let prisma: PrismaService;
  let root: ReturnType<typeof request.agent>;
  let plainAdmin: ReturnType<typeof request.agent>;
  let customerEmail: string;

  const boot = async (trustProxy: boolean) => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RedisModule, AuthModule, AdminModule, BillingModule],
    })
      .overrideGuard(ThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true });
    configureApp(app, new session.MemoryStore(), new session.MemoryStore());
    if (trustProxy) app.set('trust proxy', 1);
    await app.init();
    apps.push(app);
    return app;
  };
  const makeBlock = (ip: string, durationMinutes = 60) =>
    root.post(api('/admin/security/ip-blocks')).send({ ip, durationMinutes, reason: 'Fictional e2e reason' });
  const from = (app: NestExpressApplication, ip: string) => request(app.getHttpServer()).get(api('/auth/me')).set('X-Forwarded-For', ip);
  const isBlockedResponse = (r: { status: number; body: { message?: string } }) => r.status === 403 && r.body.message === BLOCKED_MESSAGE;

  beforeAll(async () => {
    process.env.IP_ATTRIBUTION_VERIFIED_AT = '2026-01-01T00:00:00Z';
    process.env.IP_BLOCK_PROTECTED_IPS = '198.51.100.250';
    a = await boot(true);
    b = await boot(true);
    delete process.env.IP_ATTRIBUTION_VERIFIED_AT;
    delete process.env.IP_BLOCK_PROTECTED_IPS;
    off = await boot(true);
    prisma = a.get(PrismaService);

    for (const name of ['root', 'admin', 'customer']) {
      await request(a.getHttpServer())
        .post(api('/auth/register'))
        .send({ email: at(name), password, firstName: name, lastName: 'Test' })
        .expect(201);
    }
    customerEmail = at('customer');
    await prisma.user.update({ where: { email: at('root') }, data: { role: 'SUPER_ADMIN' } });
    await prisma.user.update({ where: { email: at('admin') }, data: { role: 'ADMIN' } });
    root = (await adminSignIn(a, at('root'), password)).agent;
    plainAdmin = (await adminSignIn(a, at('admin'), password)).agent;
  });

  afterAll(async () => {
    await prisma.ipBlock.deleteMany({ where: { reason: 'Fictional e2e reason' } });
    await prisma.user.deleteMany({ where: { email: { contains: tag } } });
    for (const app of apps) await app.close();
  });

  describe('source attribution', () => {
    it('blocks the address the load balancer appends; forged left-hand entries change nothing', async () => {
      const ip = uniqueIp();
      await makeBlock(ip).expect(201);
      expect(isBlockedResponse(await from(a, ip))).toBe(true);
      expect(isBlockedResponse(await from(a, `198.51.100.7, ${ip}`))).toBe(true);
      // A client can't frame an address by forging it, or escape by forging another.
      expect(isBlockedResponse(await from(a, `${ip}, 198.51.100.7`))).toBe(false);
    });

    it('an IPv4-mapped forwarded address matches the IPv4 block', async () => {
      const ip = uniqueIp();
      await makeBlock(ip).expect(201);
      expect(isBlockedResponse(await from(a, `::ffff:${ip}`))).toBe(true);
    });

    it('attribution not verified: create is refused with the required text and nothing is enforced', async () => {
      const ip = uniqueIp();
      await makeBlock(ip).expect(201);
      expect(isBlockedResponse(await from(off, ip))).toBe(false);
      const signedIn = (await adminSignInExisting(off)).agent;
      const refused = await signedIn
        .post(api('/admin/security/ip-blocks'))
        .send({ ip: uniqueIp(), durationMinutes: 60, reason: 'Fictional e2e reason' })
        .expect(409);
      expect(refused.body.message).toBe('IP blocking is unavailable for this source.');
      const view = await signedIn.get(api('/admin/security/ip-blocks')).expect(200);
      expect(view.body.controls).toMatchObject({ available: false, superAdmin: true, recentAuth: true });
    });

    // The TOTP secret is per user, so this instance gets its own enrolled super admin.
    const adminSignInExisting = async (app: NestExpressApplication) => {
      const email = at(`offroot${randomUUID().slice(0, 4)}`);
      await request(app.getHttpServer()).post(api('/auth/register')).send({ email, password, firstName: 'Off', lastName: 'Root' }).expect(201);
      await prisma.user.update({ where: { email }, data: { role: 'SUPER_ADMIN' } });
      return adminSignIn(app, email, password);
    };
  });

  describe('authorization and validation', () => {
    it('anonymous 401, Customer 401, plain admin 403 on changes; plain admin reads masked only', async () => {
      const target = uniqueIp();
      const body = { ip: target, durationMinutes: 60, reason: 'Fictional e2e reason' };
      await request(a.getHttpServer()).post(api('/admin/security/ip-blocks')).send(body).expect(401);
      const customer = request.agent(a.getHttpServer());
      await customer.post(api('/auth/login')).send({ email: customerEmail, password }).expect(200);
      await customer.post(api('/admin/security/ip-blocks')).send(body).expect(401);
      const refused = await plainAdmin.post(api('/admin/security/ip-blocks')).send(body).expect(403);
      expect(refused.body.message).toMatch(/super admin/);
      expect(await prisma.ipBlock.count({ where: { ip: target } })).toBe(0);

      const made = (await makeBlock(target).expect(201)).body as { id: string };
      await plainAdmin.post(api(`/admin/security/ip-blocks/${made.id}/revoke`)).expect(403);
      const read = await plainAdmin.get(api('/admin/security/ip-blocks')).query({ status: 'active' }).expect(200);
      expect(read.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(read.body)).not.toContain(target);
      expect(JSON.stringify(read.body)).not.toContain('Fictional e2e reason');
      expect(read.body.controls.superAdmin).toBe(false);
    });

    it('a cross-site Origin is refused; unknown fields and bad durations are refused', async () => {
      await makeBlock(uniqueIp()).set('Origin', 'https://evil.example').expect(403);
      await root.post(api('/admin/security/ip-blocks')).send({ ip: uniqueIp(), durationMinutes: 60, reason: 'r', createdById: 'x' }).expect(400);
      await makeBlock(uniqueIp(), 90).expect(400);
      await root.post(api('/admin/security/ip-blocks')).send({ ip: uniqueIp(), durationMinutes: 60, reason: '  ' }).expect(400);
    });

    it('masked prefixes, private and infrastructure targets and the operator’s own address are refused', async () => {
      for (const ip of ['203.0.113.0/24', '0:0:0::/48', '127.0.0.1', '10.1.2.3', '::1', '198.51.100.250']) {
        await makeBlock(ip).expect(400);
      }
      const own = uniqueIp();
      const refused = await makeBlock(own).set('X-Forwarded-For', own).expect(400);
      expect(refused.body.message).toMatch(/your current address/);
      expect(await prisma.ipBlock.count({ where: { ip: own } })).toBe(0);
    });
  });

  describe('lifecycle', () => {
    it('concurrent duplicate requests create exactly one block and one audit row', async () => {
      const ip = uniqueIp();
      const results = await Promise.all(Array.from({ length: 5 }, () => makeBlock(ip)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
      const rows = await prisma.ipBlock.findMany({ where: { ip } });
      expect(rows).toHaveLength(1);
      expect(await prisma.auditLog.count({ where: { eventType: 'IP_BLOCK_CREATED', subjectId: rows[0]!.id } })).toBe(1);
    });

    it('propagates to another instance on its next poll; revocation likewise; audit trail and row remain', async () => {
      const ip = uniqueIp();
      const made = (await makeBlock(ip).expect(201)).body as { id: string; status: string; ip: string };
      expect(made).toMatchObject({ ip, status: 'active' });
      expect(isBlockedResponse(await from(b, ip))).toBe(false);
      await b.get(IpBlockService).refresh();
      expect(isBlockedResponse(await from(b, ip))).toBe(true);

      const revoked = await root.post(api(`/admin/security/ip-blocks/${made.id}/revoke`)).expect(200);
      expect(revoked.body.status).toBe('revoked');
      expect(isBlockedResponse(await from(a, ip))).toBe(false);
      await b.get(IpBlockService).refresh();
      expect(isBlockedResponse(await from(b, ip))).toBe(false);
      await root.post(api(`/admin/security/ip-blocks/${made.id}/revoke`)).expect(409);

      const listed = await root.get(api('/admin/security/ip-blocks')).query({ status: 'revoked', limit: 100 }).expect(200);
      expect(listed.body.items.find((i: { id: string }) => i.id === made.id)).toMatchObject({ ip, status: 'revoked', reason: 'Fictional e2e reason' });
      const audit = await prisma.auditLog.findMany({ where: { subjectId: made.id } });
      expect(audit.map((e) => e.eventType).sort()).toEqual(['IP_BLOCK_CREATED', 'IP_BLOCK_REVOKED']);
      expect(JSON.stringify(audit)).not.toContain(ip);
    });

    it('expiry ends enforcement and shows as expired, and the address can be blocked again', async () => {
      const ip = uniqueIp();
      const made = (await makeBlock(ip).expect(201)).body as { id: string };
      await prisma.ipBlock.update({ where: { id: made.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      await a.get(IpBlockService).refresh();
      expect(isBlockedResponse(await from(a, ip))).toBe(false);
      const listed = await root.get(api('/admin/security/ip-blocks')).query({ status: 'expired', limit: 100 }).expect(200);
      expect(listed.body.items.map((i: { id: string }) => i.id)).toContain(made.id);
      await makeBlock(ip).expect(201);
    });
  });

  describe('enforcement scope', () => {
    it('API routes in any case are blocked; health and the Stripe webhook keep their own controls; no audit rows', async () => {
      const ip = uniqueIp();
      await makeBlock(ip).expect(201);
      const since = new Date();
      const http = () => request(a.getHttpServer());
      const xff = (r: request.Test) => r.set('X-Forwarded-For', ip);
      for (let i = 0; i < 20; i++) expect(isBlockedResponse(await xff(http().post(api('/auth/login')).send({ email: customerEmail, password })))).toBe(true);
      expect(isBlockedResponse(await xff(http().get('/API/V1/RECIPIENTS')))).toBe(true);
      expect(isBlockedResponse(await xff(http().get(api('/admin/users'))))).toBe(true);

      expect((await xff(http().get('/health/database'))).status).toBe(200);
      const webhook = await xff(http().post(api('/webhooks/stripe')).set('stripe-signature', 'bad').send({}));
      expect(isBlockedResponse(webhook)).toBe(false);
      expect(webhook.status).toBeGreaterThanOrEqual(400);

      const network = `${ip.split('.').slice(0, 3).join('.')}.0/24`;
      expect(await prisma.auditLog.count({ where: { ipPrefix: network, createdAt: { gte: since } } })).toBe(0);
    });

    it('a browser on a blocked address gets a readable 403 (CORS still answers)', async () => {
      const ip = uniqueIp();
      await makeBlock(ip).expect(201);
      const origin = process.env.FRONTEND_URL!.split(',')[0]!;
      const res = await from(a, ip).set('Origin', origin);
      expect(isBlockedResponse(res)).toBe(true);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    });
  });

  describe('Security activity aggregates', () => {
    const query = { from: '2001-03-01T00:00:00+08:00', to: '2001-03-03T23:59:59.999+08:00', tz: 'Australia/Perth', limit: 1 };
    const events = async (over: object = {}) =>
      (await root.get(api('/admin/security/events')).query({ ...query, ...over }).expect(200)).body as {
        series: { unit: string; bins: { bin: string; signIn: number; mfaFailure: number }[] };
        counts: Record<string, number>;
        pagination: { total: number };
      };
    const insert = (eventType: 'ADMIN_LOGIN' | 'ADMIN_MFA_FAILED', createdAt: string) =>
      prisma.auditLog.create({ data: { eventType, actorType: 'ADMIN', createdAt: new Date(createdAt) } });

    it('bins real rows on the viewer’s local day boundaries, zero-filled; cards and chart ignore other filters', async () => {
      // Differences, not totals: AuditLog rows can't be deleted, so a rerun sees earlier ones.
      const before = await events();
      expect(before.series.unit).toBe('day');
      expect(before.series.bins.map((x) => x.bin)).toEqual(['2001-03-01T00:00', '2001-03-02T00:00', '2001-03-03T00:00']);
      await insert('ADMIN_LOGIN', '2001-03-01T15:59:59.999Z'); // 23:59:59.999 on 1 Mar in Perth
      await insert('ADMIN_LOGIN', '2001-03-01T16:00:00.000Z'); // 00:00 on 2 Mar in Perth
      await insert('ADMIN_MFA_FAILED', '2001-03-03T15:59:59.999Z'); // last instant of the window
      await insert('ADMIN_MFA_FAILED', '2001-03-03T16:00:00.000Z'); // just outside it
      const after = await events();
      const diff = after.series.bins.map((x, i) => [x.signIn - before.series.bins[i]!.signIn, x.mfaFailure - before.series.bins[i]!.mfaFailure]);
      expect(diff).toEqual([[1, 0], [1, 0], [0, 1]]);
      // Same rows behind the chart and the cards.
      const sum = (key: 'signIn' | 'mfaFailure') => after.series.bins.reduce((n, x) => n + x[key], 0);
      expect(sum('signIn')).toBe(after.counts.admin_sign_in);
      expect(sum('mfaFailure')).toBe(after.counts.mfa_failure);

      const filtered = await events({ outcome: 'failed' });
      expect(filtered.counts).toEqual(after.counts);
      expect(filtered.series).toEqual(after.series);
      expect(filtered.pagination.total).toBe(after.counts.mfa_failure);
    });

    it('a short range is hourly in the viewer’s zone; a quiet period is confirmed zeros, not missing bins', async () => {
      const day = await events({ from: '1999-06-15T00:00:00+08:00', to: '1999-06-15T23:59:59.999+08:00' });
      expect(day.series.unit).toBe('hour');
      expect(day.series.bins).toHaveLength(24);
      expect(day.series.bins[0]!.bin).toBe('1999-06-15T00:00');
      expect(day.series.bins.every((x) => x.signIn === 0 && x.mfaFailure === 0)).toBe(true);
    });

    it('source lists hold masked networks; blocking one is impossible', async () => {
      const res = (await root.get(api('/admin/security/events')).query({ limit: 1 }).expect(200)).body as { sources: { network: string }[] };
      for (const s of res.sources) {
        expect(s.network).toMatch(/\/(24|48)$/);
        await makeBlock(s.network).expect(400);
      }
    });

    it('block events appear in Security activity without the exact address', async () => {
      const ip = uniqueIp();
      await makeBlock(ip).expect(201);
      const res = await root.get(api('/admin/security/events')).query({ category: 'ip_controls', limit: 100 }).expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
      expect(res.body.items[0].sourceTrusted).toBe(true);
      expect(JSON.stringify(res.body.items)).not.toContain(ip);
    });
  });
});

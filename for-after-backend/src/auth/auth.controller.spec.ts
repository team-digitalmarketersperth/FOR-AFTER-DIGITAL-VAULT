import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { AdminMfaService } from '../admin-auth/admin-mfa.service.js';
import { configureApp } from '../config/app.setup.js';
import { UserRole, UserStatus } from '../generated/prisma/client.js';
import {
  type CreateUserInput,
  type SafeUser,
  UsersService,
} from '../users/users.service.js';
import { RedisService } from '../redis/redis.service.js';
import { AuthModule } from './auth.module.js';

// In-memory stand-in for the database; the HTTP, validation, session and
// Argon2 layers under test are all real. MemoryStore is test-only.
class FakeUsersService {
  private rows = new Map<string, SafeUser & { passwordHash: string }>();

  findById(id: string) {
    const row = this.rows.get(id);
    if (!row) return Promise.resolve(null);
    const { passwordHash: _omit, ...safe } = row;
    return Promise.resolve(safe);
  }

  findPasswordHash(id: string) {
    return Promise.resolve(this.rows.get(id)?.passwordHash ?? null);
  }

  updatePassword(id: string, passwordHash: string) {
    this.rows.get(id)!.passwordHash = passwordHash;
    return Promise.resolve();
  }

  findByEmail(email: string) {
    return Promise.resolve(
      [...this.rows.values()].find((u) => u.email === email) ?? null,
    );
  }

  setRole(email: string, role: UserRole) {
    const row = [...this.rows.values()].find((u) => u.email === email)!;
    row.role = role;
  }

  createUser(input: CreateUserInput) {
    const id = crypto.randomUUID();
    this.rows.set(id, {
      id,
      ...input,
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: null,
      twoFactorEnabled: false,
      createdAt: new Date(),
    });
    return this.findById(id) as Promise<SafeUser>;
  }
}

describe('Auth HTTP flow', () => {
  let app: NestExpressApplication;
  let users: FakeUsersService;
  // The MFA flow itself is covered in admin-mfa.service.spec.ts and the
  // admin e2e test; here only the login branch and session rules matter.
  const adminMfa = {
    startChallenge: vi.fn(async () => ({
      mfaRequired: true,
      mfaSetupRequired: true,
      challengeId: 'c'.repeat(43),
      expiresInSeconds: 300,
    })),
    recordLogout: vi.fn(async () => undefined),
  };
  const lisa = {
    email: '  Lisa@Example.com ',
    password: 'StrongPassword123!',
    firstName: 'Lisa',
    lastName: 'Smith',
  };

  // A fresh app also means a fresh 5/min login throttle window.
  const boot = async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ SESSION_SECRET: 'x'.repeat(32) })],
        }),
        AuthModule,
      ],
    })
      .overrideProvider(UsersService)
      .useClass(FakeUsersService)
      .overrideProvider(AdminMfaService)
      .useValue(adminMfa)
      .overrideProvider(RedisService)
      .useValue({})
      .compile();
    users = moduleRef.get(UsersService);
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
  };

  beforeAll(boot);

  afterAll(() => app.close());

  it('registers a CUSTOMER with a normalized email and no passwordHash', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(lisa)
      .expect(201);
    expect(res.body).toMatchObject({
      email: 'lisa@example.com',
      role: 'CUSTOMER',
      status: 'ACTIVE',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
  });

  it('rejects client-supplied role/status and duplicates', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ ...lisa, email: 'eve@example.com', role: 'SUPER_ADMIN' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send(lisa)
      .expect(409);
  });

  it('returns 401 on /me without a session', () =>
    request(app.getHttpServer()).get('/api/v1/auth/me').expect(401));

  it('returns a generic 401 for a wrong password', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: lisa.email, password: 'wrong-password-123' })
      .expect(401);
    expect(res.body.message).toBe('Invalid email or password.');
  });

  it('login sets an HttpOnly cookie, /me works, logout kills the session', async () => {
    const agent = request.agent(app.getHttpServer());

    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email: lisa.email, password: lisa.password })
      .expect(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/^for_after_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(JSON.stringify(login.body)).not.toMatch(/passwordHash|sid/);

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body).toMatchObject({ email: 'lisa@example.com' });
    expect(me.body).not.toHaveProperty('passwordHash');

    const logout = await agent.post('/api/v1/auth/logout').expect(200);
    expect(logout.body).toEqual({ success: true });

    // Replay the old cookie explicitly: the server-side session must be gone.
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Cookie', cookie.split(';')[0])
      .expect(401);
  });

  it('logout is safe without a session', () =>
    request(app.getHttpServer()).post('/api/v1/auth/logout').expect(200));

  describe('Step 16: admins', () => {
    beforeAll(async () => {
      await app.close();
      await boot();
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(lisa)
        .expect(201);
    });

    const ada = {
      email: 'ada@example.com',
      password: 'StrongPassword123!',
      firstName: 'Ada',
      lastName: 'Admin',
    };

    it('Customer login is unchanged: session + user, no MFA fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: lisa.email, password: lisa.password })
        .expect(200);
      expect(String(res.headers['set-cookie'])).toMatch(/for_after_session=/);
      expect(res.body).toMatchObject({
        email: 'lisa@example.com',
        role: 'CUSTOMER',
      });
      expect(res.body).not.toHaveProperty('mfaRequired');
      expect(adminMfa.startChallenge).not.toHaveBeenCalled();
    });

    it('a correct admin password returns an MFA challenge and no session', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(ada)
        .expect(201);
      for (const role of [UserRole.ADMIN, UserRole.SUPER_ADMIN]) {
        users.setRole(ada.email, role);
        const agent = request.agent(app.getHttpServer());
        const res = await agent
          .post('/api/v1/auth/login')
          .send({ email: ada.email, password: ada.password })
          .expect(200);
        expect(res.body).toEqual({
          mfaRequired: true,
          mfaSetupRequired: true,
          challengeId: expect.any(String),
          expiresInSeconds: 300,
        });
        expect(res.headers['set-cookie']).toBeUndefined();
        await agent.get('/api/v1/auth/me').expect(401);
      }
    });

    it('a wrong admin password is the same generic 401 (no MFA hint)', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: ada.email, password: 'wrong-password-123' })
        .expect(401);
      expect(res.body.message).toBe('Invalid email or password.');
      expect(res.body).not.toHaveProperty('challengeId');
    });

    it('a Customer session promoted to admin (no MFA) is destroyed, not upgraded', async () => {
      const bob = { ...ada, email: 'bob@example.com' };
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(bob)
        .expect(201);
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/api/v1/auth/login')
        .send({ email: bob.email, password: bob.password })
        .expect(200);
      await agent.get('/api/v1/auth/me').expect(200);
      users.setRole(bob.email, UserRole.ADMIN);
      await agent.get('/api/v1/auth/me').expect(401);
      users.setRole(bob.email, UserRole.CUSTOMER);
      // Destroyed: demoting again does not bring the session back.
      await agent.get('/api/v1/auth/me').expect(401);
    });

    it('password login (admin included) is limited to 5 per minute', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: ada.email, password: ada.password })
        .expect(429);
    });
  });

  describe('Step 22: change password', () => {
    beforeAll(async () => {
      await app.close();
      await boot();
      await request(app.getHttpServer())
        .post('/api/v1/auth/register')
        .send(lisa)
        .expect(201);
    });

    it('is limited to 5 attempts per minute (wrong current password included)', async () => {
      const agent = request.agent(app.getHttpServer());
      await agent
        .post('/api/v1/auth/login')
        .send({ email: lisa.email, password: lisa.password })
        .expect(200);
      const attempt = () =>
        agent.post('/api/v1/auth/change-password').send({
          currentPassword: 'not-my-password',
          newPassword: 'A new long passphrase',
        });
      for (let i = 0; i < 5; i++) await attempt().expect(400);
      await attempt().expect(429);
      // Throttled, not signed out.
      await agent.get('/api/v1/auth/me').expect(200);
    });
  });
});

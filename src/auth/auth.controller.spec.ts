import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import session from 'express-session';
import request from 'supertest';
import { configureApp } from '../config/app.setup.js';
import { UserRole, UserStatus } from '../generated/prisma/client.js';
import {
  type CreateUserInput,
  type SafeUser,
  UsersService,
} from '../users/users.service.js';
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

  findByEmail(email: string) {
    return Promise.resolve(
      [...this.rows.values()].find((u) => u.email === email) ?? null,
    );
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
  const lisa = {
    email: '  Lisa@Example.com ',
    password: 'StrongPassword123!',
    firstName: 'Lisa',
    lastName: 'Smith',
  };

  beforeAll(async () => {
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
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(app, new session.MemoryStore());
    await app.init();
  });

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
});

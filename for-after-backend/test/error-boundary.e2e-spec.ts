import { Body, Controller, Get, Module, Post } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsEmail } from 'class-validator';
import session from 'express-session';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/config/app.setup.js';
import { Prisma } from '../src/generated/prisma/client.js';

// Phase 03: the HTTP error boundary and the Swagger gate, through the real
// configureApp (Helmet, CORS, Origin check, ValidationPipe, global filter).
// Every error below carries fictional secret-looking values only.
const FAKE =
  'DATABASE_URL=postgres://fake-user:fake-password@example.invalid:5432/db';
const LEAKS =
  /DATABASE_URL|fake-user|fake-password|postgres:|example\.invalid|redis:\/\/|6379|stack|\.ts\b|\.js\b|node_modules|[A-Z]:\\|xkeysib|\$metadata|SignatureDoesNotMatch|P10\d\d|ECONNREFUSED/;

class EmailDto {
  @IsEmail()
  email!: string;
}

@Controller('boom')
class BoomController {
  @Get('error')
  error() {
    throw new Error(FAKE);
  }
  @Get('async')
  async async() {
    await Promise.resolve();
    throw new TypeError(`Cannot read properties of undefined (${FAKE})`);
  }
  @Get('non-error')
  nonError() {
    throw FAKE as unknown as Error;
  }
  @Get('prisma')
  prisma() {
    throw new Prisma.PrismaClientInitializationError(
      `Can't reach database server at example.invalid:5432 (${FAKE})`,
      'test',
      'P1001',
    );
  }
  @Get('redis')
  redis() {
    throw Object.assign(
      new Error(
        'connect ECONNREFUSED redis://:fake-password@example.invalid:6379',
      ),
      { code: 'ECONNREFUSED', address: 'example.invalid', port: 6379 },
    );
  }
  @Get('s3')
  s3() {
    throw Object.assign(new Error('SignatureDoesNotMatch for key fake-key'), {
      name: 'SignatureDoesNotMatch',
      $metadata: { httpStatusCode: 403, requestId: 'fake' },
    });
  }
  @Get('brevo')
  brevo() {
    throw new Error('Brevo 401 {"code":"unauthorized","key":"xkeysib-fake"}');
  }
  @Post('validate')
  validate(@Body() dto: EmailDto) {
    return dto;
  }
}

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  controllers: [BoomController],
})
class BoomModule {}

const boot = async (module: unknown, swagger: string) => {
  process.env.SWAGGER_ENABLED = swagger;
  const ref = await Test.createTestingModule({
    imports: [module as typeof BoomModule],
  }).compile();
  const app = ref.createNestApplication<NestExpressApplication>({
    logger: ['fatal'],
  });
  configureApp(app, new session.MemoryStore());
  await app.init();
  return app;
};

describe('Error boundary (e2e)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await boot(BoomModule, 'false');
  });
  afterAll(async () => {
    await app?.close();
    delete process.env.SWAGGER_ENABLED;
  });

  it.each(['error', 'async', 'non-error', 'prisma', 'redis', 's3', 'brevo'])(
    'an unexpected %s failure is a bare 500 that leaks nothing',
    async (path) => {
      const res = await http().get(`/api/v1/boom/${path}`).expect(500);
      // No Observe keys in tests, so no trace id.
      expect(res.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
      });
      expect(res.text).not.toMatch(LEAKS);
    },
  );

  it('validation stays 400 with the usual message list', async () => {
    const res = await http()
      .post('/api/v1/boom/validate')
      .send({ email: 'not-an-email', extra: 1 })
      .expect(400);
    expect(res.body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: ['property extra should not exist', 'email must be an email'],
    });
  });

  it('a malformed JSON body stays 400 (not 500)', async () => {
    const res = await http()
      .post('/api/v1/boom/validate')
      .set('content-type', 'application/json')
      .send('{"email":')
      .expect(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.text).not.toMatch(/node_modules|[A-Z]:\\|at JSON/);
  });

  it('an unknown route stays 404', () =>
    http().get('/api/v1/nowhere').expect(404));

  it('Swagger is not exposed when disabled', async () => {
    await http().get('/api/docs').expect(404);
    await http().get('/api/docs-json').expect(404);
  });
});

describe('Swagger / OpenAPI (e2e, whole AppModule)', () => {
  let app: NestExpressApplication;
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await boot(AppModule, 'true');
  });
  afterAll(async () => {
    await app?.close();
    delete process.env.SWAGGER_ENABLED;
  });

  it('serves the UI and a valid OpenAPI document with the real routes', async () => {
    const ui = await http().get('/api/docs').expect(200);
    expect(ui.text).toContain('swagger-ui');
    const { body: doc } = await http().get('/api/docs-json').expect(200);
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info).toMatchObject({ title: 'For After API', version: 'v1' });
    for (const path of [
      '/api/v1/auth/login',
      '/api/v1/recipients',
      '/api/v1/messages',
      '/api/v1/recipient/messages',
      '/api/v1/trusted-contact/accounts',
      '/api/v1/admin/users',
      '/api/v1/admin-auth/totp/verify',
      '/health/database',
    ])
      expect(Object.keys(doc.paths)).toContain(path);
  });

  it('documents cookie sessions per principal, never bearer tokens', async () => {
    const { body: doc } = await http().get('/api/docs-json').expect(200);
    expect(doc.components.securitySchemes).toEqual({
      'customer-session': {
        type: 'apiKey',
        in: 'cookie',
        name: 'for_after_session',
      },
      'admin-session': {
        type: 'apiKey',
        in: 'cookie',
        name: 'for_after_admin_session',
      },
      'recipient-session': {
        type: 'apiKey',
        in: 'cookie',
        name: 'for_after_recipient_session',
      },
      'trusted-contact-session': {
        type: 'apiKey',
        in: 'cookie',
        name: 'for_after_trusted_contact_session',
      },
    });
    const security = (path: string, method: string) =>
      doc.paths[path][method].security;
    expect(security('/api/v1/messages', 'get')).toEqual([
      { 'customer-session': [] },
    ]);
    expect(security('/api/v1/admin/users', 'get')).toEqual([
      { 'admin-session': [] },
    ]);
    expect(security('/api/v1/recipient/messages', 'get')).toEqual([
      { 'recipient-session': [] },
    ]);
    expect(security('/api/v1/auth/login', 'post')).toBeUndefined();
    // No bearer scheme and no Authorization header anywhere.
    expect(JSON.stringify(doc.components.securitySchemes)).not.toMatch(
      /bearer|"http"/i,
    );
    expect(JSON.stringify(doc.paths)).not.toMatch(/"name":"authorization"/i);
  });

  it('real routes keep their statuses under the filter: 400, 401, 403', async () => {
    await http().post('/api/v1/auth/register').send({}).expect(400);
    await http().get('/api/v1/messages').expect(401);
    await http().get('/api/v1/recipient/messages').expect(401);
    await http()
      .post('/api/v1/auth/login')
      .set('origin', 'https://evil.example')
      .send({})
      .expect(403);
  });
});

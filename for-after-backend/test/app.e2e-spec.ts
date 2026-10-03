import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';

// The whole AppModule boots and reaches PostgreSQL and Redis. There is no root
// route (the Nest scaffold "Hello World" was removed in Step 23).
describe('AppModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('boots with real database and Redis connections', async () => {
    await request(app.getHttpServer())
      .get('/health/database')
      .expect(200, { status: 'ok', database: 'connected' });
    await request(app.getHttpServer()).get('/health/redis').expect(200);
  });

  it('has no scaffold root route', () =>
    request(app.getHttpServer()).get('/').expect(404));

  afterEach(async () => {
    await app.close();
  });
});

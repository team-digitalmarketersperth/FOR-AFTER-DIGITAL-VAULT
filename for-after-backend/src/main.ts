import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { RedisStore } from 'connect-redis';
import { AppModule, ObserveInstrument } from './app.module.js';
import { configureApp } from './config/app.setup.js';
import { RedisService } from './redis/redis.service.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    instrument: ObserveInstrument,
  });
  const redis = app.get(RedisService).client;
  configureApp(
    app,
    new RedisStore({ client: redis, prefix: 'for_after:sess:' }),
    new RedisStore({ client: redis, prefix: 'for_after:admin_sess:' }),
  );
  // Runs onModuleDestroy (closes the Postgres pool and Redis) on SIGTERM/SIGINT.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();

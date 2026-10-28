import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module.js';

// Phase 17B: the background process. Consumes the BullMQ queues and runs their
// reconcilers; no HTTP server, so no business routes can reach it. Startup
// fails (exit 1) if PostgreSQL or queue Redis is unreachable.
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // SIGTERM/SIGINT: stop reconcilers, let active jobs finish (Worker.close),
  // close queues, then Redis and PostgreSQL, then exit.
  app.enableShutdownHooks();
  new Logger('Worker').log('Worker process started');
}
await bootstrap();

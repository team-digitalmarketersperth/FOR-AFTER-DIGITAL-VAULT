import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DeadLetterModule } from './dead-letters/dead-letter.service.js';
import { DeathVerificationQueueModule } from './death-verification/death-verification.module.js';
import { DeathVerificationProcessor } from './death-verification/death-verification.processor.js';
import { EmailModule } from './email/email.module.js';
import { MessageReleaseReconciler } from './message-release/message-release-reconciler.service.js';
import { MessageReleaseModule } from './message-release/message-release.module.js';
import { MessageReleaseProcessor } from './message-release/message-release.processor.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ReleaseNotificationModule } from './release-notifications/release-notification.module.js';
import { ReleaseNotificationProcessor } from './release-notifications/release-notification.processor.js';

/**
 * Phase 17B. Every BullMQ consumer and queue reconciler, and nothing else: no
 * controllers, sessions or HTTP. Only the worker process (WorkerModule) loads
 * it; AppModule (the API) never does. E2E suites that need jobs consumed
 * import it next to their API modules.
 */
@Module({
  imports: [
    EmailModule,
    DeadLetterModule,
    MessageReleaseModule,
    ReleaseNotificationModule,
    DeathVerificationQueueModule,
  ],
  providers: [
    MessageReleaseProcessor,
    MessageReleaseReconciler,
    ReleaseNotificationProcessor,
    DeathVerificationProcessor,
  ],
})
export class QueueWorkersModule {}

// Composition root of the worker process (src/worker.ts).
@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, QueueWorkersModule],
})
export class WorkerModule {}

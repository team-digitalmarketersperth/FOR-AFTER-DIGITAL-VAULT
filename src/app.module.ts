import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthModule } from './health/health.module.js';
import { MediaModule } from './media/media.module.js';
import { MemoryVaultModule } from './memory-vault/memory-vault.module.js';
import { MessageSchedulesModule } from './message-schedules/message-schedules.module.js';
import { MessagesModule } from './messages/messages.module.js';
import { MyStoryModule } from './my-story/my-story.module.js';
import { MyWishesModule } from './my-wishes/my-wishes.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RecipientAuthModule } from './recipient-auth/recipient-auth.module.js';
import { RecipientPortalModule } from './recipient-portal/recipient-portal.module.js';
import { RecipientsModule } from './recipients/recipients.module.js';
import { RedisModule } from './redis/redis.module.js';
import { TrustedContactsModule } from './trusted-contacts/trusted-contacts.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    RedisModule,
    HealthModule,
    AuthModule,
    RecipientsModule,
    TrustedContactsModule,
    MessagesModule,
    MessageSchedulesModule,
    MediaModule,
    MemoryVaultModule,
    MyStoryModule,
    MyWishesModule,
    RecipientAuthModule,
    RecipientPortalModule,
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    // Only loaded when both keys are in .env; otherwise the collector rejects
    // every batch with 401. process.env is populated by ConfigModule above.
    ...(process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET
      ? [
          ObserveModule.forRoot({
            appKey: process.env.OBSERVE_APP_KEY,
            appSecret: process.env.OBSERVE_APP_SECRET,
            serviceId: 'for-after-backend',
          }),
        ]
      : []),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

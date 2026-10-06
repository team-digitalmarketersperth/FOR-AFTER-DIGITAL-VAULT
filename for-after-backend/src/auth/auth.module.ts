import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminAuthModule } from '../admin-auth/admin-auth.module.js';
import { EmailModule } from '../email/email.module.js';
import { RedisService } from '../redis/redis.service.js';
import { RedisThrottlerStorage } from '../redis/redis-throttler.storage.js';
import { UsersModule } from '../users/users.module.js';
import { AuthTokensService } from './auth-tokens.service.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  imports: [
    UsersModule,
    AdminAuthModule,
    EmailModule,
    // Real limits are set per route with @Throttle in AuthController. Counters
    // live in Redis, so every API instance enforces the same limit.
    ThrottlerModule.forRootAsync({
      imports: [],
      inject: [RedisService, ConfigService],
      useFactory: (redis: RedisService, config: ConfigService) => ({
        throttlers: [{ limit: 100, ttl: 60_000 }],
        storage: new RedisThrottlerStorage(redis, config),
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthTokensService],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminAuthController } from './admin-auth.controller.js';
import { AdminMfaService } from './admin-mfa.service.js';

// Admin TOTP + recovery codes (Step 16). AuthModule imports this for the
// admin branch of /auth/login. UsersModule backs SessionAuthGuard. RedisModule
// is global, but imported here because MFA challenges cannot work without it
// (and so any module graph that includes AuthModule gets it).
@Module({
  imports: [UsersModule, RedisModule],
  controllers: [AdminAuthController],
  providers: [AdminMfaService],
  exports: [AdminMfaService],
})
export class AdminAuthModule {}

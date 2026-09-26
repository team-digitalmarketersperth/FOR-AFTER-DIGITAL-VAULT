import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

@Module({
  // Real limits are set per route with @Throttle in AuthController.
  imports: [
    UsersModule,
    ThrottlerModule.forRoot([{ limit: 100, ttl: 60_000 }]),
  ],
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  controllers: [HealthController],
  providers: [HealthService],
  // The admin Overview reuses the same two checks.
  exports: [HealthService],
})
export class HealthModule {}

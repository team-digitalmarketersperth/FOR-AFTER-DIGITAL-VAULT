import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('database')
  checkDatabase() {
    return this.healthService.checkDatabase();
  }

  @Get('redis')
  checkRedis() {
    return this.healthService.checkRedis();
  }
}

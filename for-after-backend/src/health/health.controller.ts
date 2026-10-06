import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service.js';

@ApiTags('Health')
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

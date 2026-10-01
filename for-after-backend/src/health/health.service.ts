import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService, errorCode } from '../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async checkRedis(): Promise<{ status: 'ok'; redis: 'connected' }> {
    try {
      await this.redis.client.ping();
      return { status: 'ok', redis: 'connected' };
    } catch (err) {
      this.logger.error(`Redis health check failed (code: ${errorCode(err)})`);
      throw new ServiceUnavailableException({
        status: 'error',
        redis: 'disconnected',
      });
    }
  }

  async checkDatabase(): Promise<{ status: 'ok'; database: 'connected' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'connected' };
    } catch (err) {
      this.logger.error(
        `Database health check failed (code: ${errorCode(err)})`,
      );
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'disconnected',
      });
    }
  }
}

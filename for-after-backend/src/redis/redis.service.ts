import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { errorCode } from '../prisma/prisma.service.js';

// The one Redis connection for the app (session store + health check).
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: ReturnType<typeof createClient>;

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL');
    if (!url) {
      throw new Error('REDIS_URL is not set. Add it to .env.');
    }
    let everConnected = false;
    this.client = createClient({
      url,
      socket: {
        // connect() otherwise retries forever and startup hangs. Give up after
        // 3 tries at boot; once connected, keep reconnecting with backoff.
        reconnectStrategy: (retries: number) =>
          !everConnected && retries >= 3
            ? new Error('Initial Redis connection failed')
            : Math.min(retries * 200, 5000),
      },
    });
    this.client.on('ready', () => (everConnected = true));
    // Without a listener, a dropped connection crashes the process. Log the
    // code only: messages can include the host.
    this.client.on('error', (err: unknown) =>
      this.logger.error(`Redis error (code: ${errorCode(err)})`),
    );
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
      this.logger.log('Connected to Redis');
    } catch (err) {
      this.logger.error(`Could not connect to Redis (code: ${errorCode(err)})`);
      throw new Error('Redis connection failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }
}

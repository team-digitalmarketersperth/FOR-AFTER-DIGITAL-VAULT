import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

type DbError = {
  code?: unknown;
  meta?: { driverAdapterError?: { cause?: { kind?: unknown } } };
} | null;

// Driver errors carry user/host details in their message and meta; only the
// adapter's error kind (e.g. AuthenticationFailed) or the code is safe to log.
export const errorCode = (err: unknown): string => {
  const e = err as DbError;
  const code = e?.meta?.driverAdapterError?.cause?.kind ?? e?.code;
  return typeof code === 'string' || typeof code === 'number'
    ? String(code)
    : 'UNKNOWN';
};

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    const connectionString = config.get<string>('DATABASE_URL');
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set. Add it to .env.');
    }
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    try {
      // The pg adapter connects lazily; a real query makes startup fail fast.
      await this.$queryRaw`SELECT 1`;
      this.logger.log('Connected to PostgreSQL');
    } catch (err) {
      this.logger.error(
        `Could not connect to PostgreSQL (code: ${errorCode(err)})`,
      );
      throw new Error('Database connection failed');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

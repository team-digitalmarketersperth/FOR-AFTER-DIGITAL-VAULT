import type { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  it.each([undefined, ''])('fails clearly when DATABASE_URL is %j', (url) => {
    const config = { get: () => url } as unknown as ConfigService;
    expect(() => new PrismaService(config)).toThrow(/DATABASE_URL is not set/);
  });
});

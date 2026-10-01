import { ServiceUnavailableException } from '@nestjs/common';
import { HealthService } from './health.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RedisService } from '../redis/redis.service.js';

const serviceWith = (
  queryRaw: () => Promise<unknown>,
  ping: () => Promise<unknown> = () => Promise.resolve('PONG'),
) =>
  new HealthService(
    { $queryRaw: queryRaw } as unknown as PrismaService,
    { client: { ping } } as unknown as RedisService,
  );

describe('HealthService', () => {
  it('reports connected when SELECT 1 succeeds', async () => {
    await expect(
      serviceWith(() => Promise.resolve([{ '?column?': 1 }])).checkDatabase(),
    ).resolves.toEqual({ status: 'ok', database: 'connected' });
  });

  it('returns 503 without leaking driver details when the query fails', async () => {
    const leaky = Object.assign(
      new Error('password authentication failed for user "postgres"'),
      { code: '28P01' },
    );
    const err = await serviceWith(() => Promise.reject(leaky))
      .checkDatabase()
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(
      JSON.stringify((err as ServiceUnavailableException).getResponse()),
    ).not.toContain('postgres');
  });

  it('reports redis connected on PONG and 503 when ping fails', async () => {
    const ok = () => Promise.resolve();
    await expect(serviceWith(ok).checkRedis()).resolves.toEqual({
      status: 'ok',
      redis: 'connected',
    });
    await expect(
      serviceWith(ok, () =>
        Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:6379')),
      ).checkRedis(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

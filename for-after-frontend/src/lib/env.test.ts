import { afterEach, describe, expect, it, vi } from 'vitest';

async function devLoginEnabled(nodeEnv: string, appEnv: string) {
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('NEXT_PUBLIC_APP_ENV', appEnv);
  vi.resetModules();
  return (await import('./env')).isDevLoginEnabled();
}

describe('isDevLoginEnabled', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is on only for a development server with APP_ENV=development', async () => {
    expect(await devLoginEnabled('development', 'development')).toBe(true);
  });

  it('is off in any production build, whatever APP_ENV says', async () => {
    expect(await devLoginEnabled('production', 'development')).toBe(false);
    expect(await devLoginEnabled('production', 'production')).toBe(false);
  });

  it('is off when APP_ENV is not development', async () => {
    expect(await devLoginEnabled('development', 'staging')).toBe(false);
  });
});

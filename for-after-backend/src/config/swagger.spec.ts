import { ConfigService } from '@nestjs/config';
import { swaggerEnabled } from './swagger.js';

const enabled = (env: Record<string, string>) =>
  swaggerEnabled(new ConfigService(env));

describe('swaggerEnabled', () => {
  it('defaults: on in development only', () => {
    expect(enabled({ NODE_ENV: 'development' })).toBe(true);
    expect(enabled({ NODE_ENV: 'test' })).toBe(false);
    expect(enabled({ NODE_ENV: 'production' })).toBe(false);
    expect(enabled({})).toBe(false);
  });

  it('SWAGGER_ENABLED overrides the default either way', () => {
    expect(enabled({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })).toBe(
      true,
    );
    expect(enabled({ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' })).toBe(
      false,
    );
  });

  it('anything else fails startup', () => {
    for (const value of ['yes', '1', 'TRUE '])
      expect(() => enabled({ SWAGGER_ENABLED: value })).toThrow(
        'SWAGGER_ENABLED must be "true" or "false".',
      );
  });
});

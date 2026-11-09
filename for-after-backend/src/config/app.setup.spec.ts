import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import session from 'express-session';
import { configureApp } from './app.setup.js';

@Module({ imports: [ConfigModule.forRoot({ ignoreEnvFile: true })] })
class BareModule {}

describe('configureApp', () => {
  it('starts without Nest Observe (no OBSERVE_* keys) under NestFactory', async () => {
    vi.stubEnv('OBSERVE_APP_KEY', '');
    vi.stubEnv('OBSERVE_APP_SECRET', '');
    vi.stubEnv('SESSION_SECRET', 'x'.repeat(32));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    // NestFactory (as in main.ts), not Test.createTestingModule: only the
    // factory's abortOnError proxy exits on a missing provider.
    const app = await NestFactory.create<NestExpressApplication>(BareModule, {
      logger: false,
    });
    try {
      expect(() => configureApp(app, new session.MemoryStore())).not.toThrow();
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await app.close();
      exit.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});

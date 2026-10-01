import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Each file boots a real app (TS transform, PostgreSQL, Redis, BullMQ);
    // with 14 files in parallel the 10 s default hook timeout is too tight.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Keep test release jobs out of the dev server's queue (same local Redis).
    // Recipient OTP: a fixed dummy pepper (not a secret) and no console
    // delivery; tests capture codes with a fake delivery provider.
    env: {
      RELEASE_QUEUE_NAME: 'test-message-release',
      RECIPIENT_OTP_PEPPER: 'e2e-test-pepper-not-a-real-secret-0000',
      RECIPIENT_OTP_DELIVERY_MODE: 'disabled',
      TRUSTED_CONTACT_OTP_PEPPER: 'e2e-tc-test-pepper-not-a-real-secret-00',
      TRUSTED_CONTACT_OTP_DELIVERY_MODE: 'disabled',
      // Step 15: own queue; notices go through a fake provider in tests.
      DEATH_VERIFICATION_QUEUE_NAME: 'test-death-verification',
      DEATH_VERIFICATION_NOTICE_DELIVERY_MODE: 'disabled',
      // Step 16: a fixed, public test key (not a secret). Admin sign-in in
      // tests completes real TOTP via test/admin-sign-in.ts.
      ADMIN_TOTP_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      ADMIN_TOTP_VERIFY_IP_LIMIT: '10000',
    },
  },
});

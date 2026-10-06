import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Suites that boot the release workers (MessageReleaseModule via schedules,
// death verification, admin or the whole app). They share one database, and
// each release reconciler queues every due SCHEDULED message it finds at boot:
// a suite starting mid-test would release another suite's message from its own
// queues and email it through the 'disabled' provider. One file at a time.
const RELEASE_WORKER_SUITES = [
  'test/admin.e2e-spec.ts',
  'test/app.e2e-spec.ts',
  'test/death-verification.e2e-spec.ts',
  'test/email-delivery.e2e-spec.ts',
  'test/error-boundary.e2e-spec.ts',
  'test/media.e2e-spec.ts',
  'test/message-composition.e2e-spec.ts',
  'test/message-release.e2e-spec.ts',
  'test/message-schedules.e2e-spec.ts',
  'test/recipient-portal.e2e-spec.ts',
  'test/trusted-contact-portal.e2e-spec.ts',
  'test/trusted-contact-invitations.e2e-spec.ts',
];

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    // Each file boots a real app (TS transform, PostgreSQL, Redis, BullMQ);
    // with 14 files in parallel the 10 s default hook timeout is too tight.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    setupFiles: ['test/setup-e2e.ts'],
    // Keep test release jobs out of the dev server's queue (same local Redis).
    // Recipient OTP: a fixed dummy pepper (not a secret) and no console
    // delivery; tests capture codes with a fake delivery provider.
    env: {
      // Step 24: no email ever leaves a test run. Suites that check emails
      // override EmailProvider (or a delivery token) with a fake.
      EMAIL_PROVIDER: 'disabled',
      EMAIL_QUEUE_NAME: 'test-email-delivery',
      EMAIL_RECONCILE_INTERVAL_SECONDS: '3600',
      RELEASE_QUEUE_NAME: 'test-message-release',
      RECIPIENT_OTP_PEPPER: 'e2e-test-pepper-not-a-real-secret-0000',
      TRUSTED_CONTACT_OTP_PEPPER: 'e2e-tc-test-pepper-not-a-real-secret-00',
      // Step 15: own queue; notices go through a fake provider in tests.
      DEATH_VERIFICATION_QUEUE_NAME: 'test-death-verification',
      // Step 16: a fixed, public test key (not a secret). Admin sign-in in
      // tests completes real TOTP via test/admin-sign-in.ts.
      ADMIN_TOTP_ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      ADMIN_TOTP_VERIFY_IP_LIMIT: '10000',
    },
    // Both projects run at the same time; only the release-worker suites are
    // serialised among themselves.
    projects: [
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['**/*.e2e-spec.ts'],
          exclude: ['**/node_modules/**', ...RELEASE_WORKER_SUITES],
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e-release-workers',
          include: RELEASE_WORKER_SUITES,
          fileParallelism: false,
        },
      },
    ],
  },
});

import { defineConfig, devices } from '@playwright/test';

// E2E runs against the real local NestJS API (localhost:4000, with PostgreSQL and
// Redis), never production. Start the backend first; see README.
//
// One worker, no retries: POST /auth/login and /auth/register are throttled to
// 5/min per IP, and the suite spends 5 of each (3 in auth.spec, 2 in
// vault.setup). Wait a minute or two between runs.
//
// vault, portals and people specs upload a few tiny synthetic files to the
// development ImageKit account (the backend's "complete" step checks the real
// file); e2e/imagekit.ts deletes exactly those files after each test.
// Never point E2E at a deployed app or API (e.g. the hosted demo): local only.
const APP = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
for (const url of [APP, process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000']) {
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url)) {
    throw new Error(`E2E targets must be local, got ${new URL(url).origin}`);
  }
}

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  retries: 0,
  // First visits to a route compile it in `next dev`, which can take 20s+.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    {
      name: 'development',
      testIgnore: /production\.spec|vault\.|portals\.|admin\.|account\./,
      // E2E_BASE_URL: another app origin, e.g. a build pointed at a second API.
      use: { ...devices['Desktop Chrome'], baseURL: APP },
    },
    {
      // Signs in two throwaway Customers once; saved to e2e/.auth (git-ignored).
      name: 'vault-setup',
      testMatch: /vault\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], baseURL: APP },
    },
    {
      name: 'vault',
      // Vault (Step 18), portals (Step 19) and admin (Step 20) use the Customers from vault-setup.
      testMatch: /(vault|portals|admin)\.spec\.ts/,
      dependencies: ['vault-setup'],
      use: {
        ...devices['Desktop Chrome'],
        baseURL: APP,
        // Chromium's fake camera + microphone for the recorder tests; nothing real is captured.
        permissions: ['microphone', 'camera'],
        launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
      },
    },
    {
      // Account settings (Step 22) registers its own Customer and spends 4 logins, so it
      // runs after the vault suite has left the 5/min login window (alone: --no-deps).
      // Same production build on :3000 as the vault suites: next dev's first compile of
      // /settings can exceed the 20 s expect timeout.
      name: 'account',
      testMatch: /account\.spec\.ts/,
      dependencies: ['vault'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3000' },
    },
    {
      name: 'production-build',
      testMatch: /production\.spec/,
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3100' },
    },
  ],
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://localhost:3000/login',
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
    {
      // A real production build (NODE_ENV=production) to prove /dev-login is gone.
      command: 'npm run build && npm run start -- -p 3100',
      url: 'http://localhost:3100/login',
      reuseExistingServer: !process.env.CI,
      timeout: 600_000,
    },
  ],
});

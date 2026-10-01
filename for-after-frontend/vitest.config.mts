import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: { tsconfigPaths: true },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // userEvent-driven form tests run slowly on this machine under parallel workers.
    testTimeout: 20_000,
    // Spawning many jsdom workers at once times out on this machine.
    maxWorkers: 3,
    env: { NEXT_PUBLIC_API_BASE_URL: 'http://api.test/api/v1' },
  },
});

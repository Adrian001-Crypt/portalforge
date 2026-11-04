import { defineConfig } from '@playwright/test';
// Starts the local stack (or reuses a running `npm run dev`). Uses the system Chrome; no browser download.
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  reporter: [['list'], ['./e2e/summary-reporter.ts']],
  webServer: { command: 'node --import tsx scripts/dev.ts', url: 'http://localhost:5180', reuseExistingServer: true, timeout: 180_000, stdout: 'ignore', stderr: 'ignore', gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 } },
  use: { baseURL: process.env.PF_E2E_BASE ?? 'http://localhost:5180', channel: 'chrome', headless: true, trace: 'retain-on-failure' },
});

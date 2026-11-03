import { defineConfig } from '@playwright/test';
// Runs against an already running stack (npm run dev). Uses the system Chrome; no browser download.
export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'docs/test-results/browser-latest.json' }]],
  use: { baseURL: process.env.PF_E2E_BASE ?? 'http://localhost:5180', channel: 'chrome', headless: true, trace: 'retain-on-failure' },
});

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  outputDir: '../../test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL,
    httpCredentials: { username: process.env.E2E_USER ?? 'admin', password: process.env.E2E_PASSWORD ?? '' },
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
});

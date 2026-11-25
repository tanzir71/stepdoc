import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:3200',
    viewport: { width: 1440, height: 900 },
    browserName: 'chromium',
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:3200',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})

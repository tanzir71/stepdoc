import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:3100', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Compile every route before timing user interactions and viewer latency.
    command: 'pnpm next build && pnpm next start --port 3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      STEPDOC_TEST_MODE: '1',
      NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:3100',
    },
  },
})

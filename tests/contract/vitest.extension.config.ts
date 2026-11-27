import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['extension.integration.test.ts'],
    fileParallelism: false,
    hookTimeout: 90000,
    // One native UI flow includes pairing, private-store reopen, read and revoke.
    testTimeout: 120000,
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['extension.integration.test.ts'],
    fileParallelism: false,
    hookTimeout: 90000,
    // Real large capture/pairing plus hosted sign-in, editor reload, DOCX and revoke.
    testTimeout: 180000,
  },
})

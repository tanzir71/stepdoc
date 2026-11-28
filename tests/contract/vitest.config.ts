import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'storage.contract.test.ts',
      'auth.contract.test.ts',
      'capture.contract.test.ts',
      `${process.env.STEPDOC_CONTRACT_TARGET ?? 'php'}.contract.test.ts`,
      `${process.env.STEPDOC_CONTRACT_TARGET ?? 'php'}.auth.test.ts`,
      `${process.env.STEPDOC_CONTRACT_TARGET ?? 'php'}.capture.test.ts`,
      `${process.env.STEPDOC_CONTRACT_TARGET ?? 'php'}.hosted.test.ts`,
      `${process.env.STEPDOC_CONTRACT_TARGET ?? 'php'}.devices.test.ts`,
      `${process.env.STEPDOC_CONTRACT_TARGET ?? 'php'}.storage-ui.test.ts`,
      `${process.env.STEPDOC_CONTRACT_TARGET ?? 'php'}.installer.test.ts`,
      `${process.env.STEPDOC_CONTRACT_TARGET ?? 'php'}.backups.test.ts`,
    ],
    fileParallelism: false,
    // Contract cases include durable disk writes and process restart, not UI latency measurements.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})

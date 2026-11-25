import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { exclude: ['node_modules/**', '.wxt/**', '.output/**', 'e2e/**'] },
})

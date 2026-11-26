import { defineConfig } from 'vitest/config'
export default defineConfig({
  optimizeDeps: { include: ['@stepdoc/core > docx'] },
  worker: { format: 'es' },
  server: {
    host: '127.0.0.1',
    port: 3200,
    strictPort: true,
    // Start the lazy editor's development transforms before its first route visit.
    warmup: { clientFiles: ['./src/editor/Editor.tsx'] },
  },
  build: {
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        assetFileNames: (asset) =>
          asset.names.some((name) => name.endsWith('.woff2'))
            ? 'assets/fonts/[name]-[hash][extname]'
            : 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: { exclude: ['e2e/**', 'node_modules/**', 'dist/**'] },
})

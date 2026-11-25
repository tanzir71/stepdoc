import { defineConfig } from 'vitest/config'
export default defineConfig({
  server: { host: '127.0.0.1', port: 3200, strictPort: true },
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

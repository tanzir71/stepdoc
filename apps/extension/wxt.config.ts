import { defineConfig } from 'wxt'

export default defineConfig({
  manifestVersion: 3,
  imports: false,
  manifest: ({ browser }) => ({
    name: 'StepDoc Capture',
    description: 'Capture browser workflows as private step-by-step guides.',
    permissions: ['activeTab', 'tabs', 'storage', 'downloads', 'webNavigation'],
    host_permissions: ['<all_urls>'],
    web_accessible_resources: [
      {
        resources: [
          'assets/418d0-*.svg',
          'assets/0e7f2-*.svg',
          'assets/f9a9e-*.svg',
          'assets/36d61-*.svg',
          'assets/cf8f1-*.svg',
        ],
        matches: ['<all_urls>'],
      },
    ],
    action: { default_title: 'StepDoc' },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'stepdoc@stepdoc.local',
              strict_min_version: '142.0',
              data_collection_permissions: { required: ['websiteContent'] },
            },
          },
        }
      : {}),
  }),
  vite: () => ({
    esbuild: { jsx: 'automatic' },
    worker: { format: 'es' },
    build: { assetsInlineLimit: 0 },
  }),
  hooks: {
    'build:manifestGenerated'(wxt, manifest) {
      // Keep the same private fallback entrypoint in every build. Chrome/Edge
      // still open their side panel; Firefox uses the action popup.
      if (wxt.config.browser !== 'firefox' && manifest.action)
        delete manifest.action.default_popup
    },
    'vite:build:extendConfig'(entrypoints, config) {
      if (
        !entrypoints.some((entrypoint) => entrypoint.type === 'content-script')
      )
        return
      const output = config.build?.rollupOptions?.output
      for (const item of Array.isArray(output)
        ? output
        : output
          ? [output]
          : []) {
        const original = item.assetFileNames
        item.assetFileNames = (asset) =>
          asset.names.some((name) => name.endsWith('.css'))
            ? typeof original === 'function'
              ? original(asset)
              : (original ?? 'content-scripts/[name][extname]')
            : 'assets/[name]-[hash][extname]'
      }
    },
  },
})

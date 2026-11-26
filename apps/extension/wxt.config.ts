import { defineConfig } from 'wxt'

export default defineConfig({
  manifestVersion: 3,
  imports: false,
  manifest: ({ browser }) => ({
    name: 'StepDoc Capture',
    description: 'Capture browser workflows as private step-by-step guides.',
    permissions: ['activeTab', 'tabs', 'storage', 'downloads', 'webNavigation'],
    host_permissions: ['<all_urls>'],
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
})

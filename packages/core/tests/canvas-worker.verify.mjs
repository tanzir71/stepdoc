import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'

const core = fileURLToPath(
  new URL('../src/canvas/index.ts', import.meta.url),
).replaceAll('\\', '/')
const adapter = fileURLToPath(
  new URL('../../../apps/extension/src/image.ts', import.meta.url),
).replaceAll('\\', '/')
const fixture = fileURLToPath(
  new URL('./fixtures/canvas-worker.ts', import.meta.url),
).replaceAll('\\', '/')
const entry = 'virtual:canvas-worker'
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'canvas-worker-check',
      resolveId(id) {
        if (id === entry) return `\0${entry}`
      },
      load(id) {
        if (id === `\0${entry}`)
          return `import * as core from ${JSON.stringify(core)}; import { composite } from ${JSON.stringify(adapter)}; import { verifyCanvas } from ${JSON.stringify(fixture)};
      self.onmessage = async () => { try { self.postMessage({ checks: await verifyCanvas(core, composite) }); } catch (error) { self.postMessage({ failure: error.message }); } };`
      },
    },
  ],
  build: {
    write: false,
    minify: false,
    rollupOptions: {
      input: entry,
      output: { format: 'es', inlineDynamicImports: true },
    },
  },
})
assert(!Array.isArray(bundle) && 'output' in bundle)
const chunk = bundle.output.find(
  (item) => item.type === 'chunk' && item.isEntry,
)
assert(chunk?.type === 'chunk')
assert.equal(chunk.imports.length, 0)
assert.equal(chunk.dynamicImports.length, 0)
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  const context = page.context()
  await context.route(/^https?:/, (route) => route.abort())
  await context.route('http://stepdoc.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Canvas fixture</title><link rel="icon" href="data:,">',
    }),
  )
  await page.goto('http://stepdoc.test/')
  const requests = []
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url())
  })
  const result = await page.evaluate(
    (code) =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(
          new Blob([code], { type: 'text/javascript' }),
        )
        const worker = new Worker(url, { type: 'module' })
        const cleanup = () => {
          worker.terminate()
          URL.revokeObjectURL(url)
        }
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error('Canvas worker timed out'))
        }, 20_000)
        worker.onerror = (event) => {
          clearTimeout(timer)
          cleanup()
          reject(new Error(`Canvas worker failed: ${event.message}`))
        }
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          cleanup()
          resolve(data)
        }
        worker.postMessage(null)
      }),
    chunk.code,
  )
  assert(!result.failure, result.failure)
  assert(result.checks >= 20)
  assert.equal(requests.length, 0)
  console.log(
    `Canvas worker verified in Chromium: ${result.checks} pixel/resource checks, extension adapter and zero HTTP requests.`,
  )
} finally {
  await browser.close()
}

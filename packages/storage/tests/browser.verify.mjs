import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'

const output = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    minify: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./browser-fixture.ts', import.meta.url)),
      output: { format: 'es', inlineDynamicImports: true },
    },
  },
})
assert(!Array.isArray(output) && 'output' in output)
const chunk = output.output.find(
  (item) => item.type === 'chunk' && item.isEntry,
)
assert(
  chunk?.type === 'chunk' &&
    chunk.imports.length === 0 &&
    chunk.dynamicImports.length === 0,
)
const browser = await chromium.launch()
try {
  const context = await browser.newContext()
  const unexpected = []
  await context.route('**/*', (route) => {
    const url = route.request().url()
    if (url === 'http://localhost:4321/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Storage fixture</title><link rel="icon" href="data:,"><script type="module" src="/fixture.js"></script>',
      })
    if (url === 'http://localhost:4321/fixture.js')
      return route.fulfill({ contentType: 'text/javascript', body: chunk.code })
    unexpected.push(url)
    return route.abort()
  })
  const page = await context.newPage()
  await page.goto('http://localhost:4321/')
  await page.waitForFunction(() => !!window.storageFixture)
  assert(
    await page.evaluate(
      () => isSecureContext && !!navigator.storage.getDirectory,
    ),
  )
  let total = 0
  const states = {}
  for (const backend of ['opfs', 'indexeddb']) {
    states[backend] = await page.evaluate(
      (backend) => window.storageFixture.basic(backend),
      backend,
    )
  }
  total += await page.evaluate(() => window.storageFixture.counts())
  await page.reload()
  await page.waitForFunction(() => !!window.storageFixture)
  for (const backend of ['opfs', 'indexeddb'])
    await page.evaluate(
      ({ backend, key }) => window.storageFixture.reload(backend, key),
      { backend, key: states[backend].key },
    )
  await page.evaluate(() => window.storageFixture.concurrentSetup())
  const second = await context.newPage()
  await second.goto('http://localhost:4321/')
  await second.waitForFunction(() => !!window.storageFixture)
  const saves = await Promise.all([
    page.evaluate(() => window.storageFixture.concurrentSave('First tab')),
    second.evaluate(() => window.storageFixture.concurrentSave('Second tab')),
  ])
  assert.equal(saves.filter((result) => result.ok).length, 1)
  assert.equal(saves.filter((result) => result.code === 'conflict').length, 1)
  await page.evaluate(() => window.storageFixture.concurrencyCheck())
  await page.evaluate(() => window.storageFixture.fallback())
  await page.evaluate(() => window.storageFixture.failures())
  await page.evaluate(() => window.storageFixture.corruptFallback())
  await page.evaluate(() => window.storageFixture.upgrade())
  // The same module also works without document/window in a real module worker.
  const workerChecks = await page.evaluate(
    ({ code, key }) =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(
          new Blob(
            [
              code +
                `\nself.onmessage = async () => { try { await self.storageFixture.reload('opfs', ${JSON.stringify(key)}); self.postMessage({ checks: self.storageFixture.counts() }); } catch (error) { self.postMessage({ failure: error.message }); } };`,
            ],
            { type: 'text/javascript' },
          ),
        )
        const worker = new Worker(url, { type: 'module' })
        const timer = setTimeout(() => {
          worker.terminate()
          URL.revokeObjectURL(url)
          reject(new Error('Storage worker timed out'))
        }, 10000)
        worker.onerror = () => {
          clearTimeout(timer)
          worker.terminate()
          URL.revokeObjectURL(url)
          reject(new Error('Storage worker failed'))
        }
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          worker.terminate()
          URL.revokeObjectURL(url)
          data.failure ? reject(new Error(data.failure)) : resolve(data.checks)
        }
        worker.postMessage(null)
      }),
    { code: chunk.code, key: states.opfs.key },
  )
  total += workerChecks
  for (const backend of ['opfs', 'indexeddb'])
    await page.evaluate(
      ({ backend, key }) => window.storageFixture.deleted(backend, key),
      { backend, key: states[backend].key },
    )
  total += await page.evaluate(() => window.storageFixture.counts())
  total += await second.evaluate(() => window.storageFixture.counts())
  assert.equal(unexpected.length, 0)
  assert(total >= 100)
  console.log(
    `Browser storage verified in Chromium: ${total} checks, real IndexedDB/OPFS and fallback, reload/worker persistence, competing tabs, atomic rollback, corruption and zero external requests.`,
  )
} finally {
  await browser.close()
}

import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'

const entry = 'virtual:redaction-worker'
const core = fileURLToPath(
  new URL('../src/redaction/index.ts', import.meta.url),
).replaceAll('\\', '/')
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'redaction-worker-check',
      resolveId(id) {
        if (id === entry) return `\0${entry}`
      },
      load(id) {
        if (id !== `\0${entry}`) return
        return `import { createRedactionDetector, redactSensitiveText } from ${JSON.stringify(core)};
        const detect = createRedactionDetector({ customRules: [{ id: 'employee', pattern: 'EMP-[0-9]{4}' }] });
        self.onmessage = ({ data }) => {
          const spans = detect(data);
          self.postMessage({ spans, redacted: redactSensitiveText(data, spans) });
        };`
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
  // Give module workers a normal origin; the fixture is fulfilled entirely in memory.
  await context.route('http://stepdoc.test/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Worker fixture</title><link rel="icon" href="data:,">',
    }),
  )
  await page.goto('http://stepdoc.test/')
  const requests = []
  context.on('request', (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url())
  })
  const text =
    '😀 alice@example.com | +1 (415) 555-2671 | 4111 1111 1111 1111 | GB82 WEST 1234 5698 7654 32 | 2001:db8::1 | 00:11:22:33:44:55 | sk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | EMP-1234'
  const result = await page.evaluate(
    ({ code, text }) =>
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
          reject(new Error('Redaction worker timed out'))
        }, 10_000)
        worker.onerror = (event) => {
          clearTimeout(timer)
          cleanup()
          reject(new Error(`Redaction worker failed: ${event.message}`))
        }
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          cleanup()
          resolve(data)
        }
        worker.postMessage(text)
      }),
    { code: chunk.code, text },
  )
  assert.deepEqual([...new Set(result.spans.map((span) => span.kind))].sort(), [
    'card',
    'custom',
    'email',
    'iban',
    'ip',
    'phone',
    'token',
  ])
  assert.equal(result.spans[0].start, 3)
  assert(!/alice|2671|4111|WEST|db8|00:11|sk-|EMP-/.test(result.redacted))
  assert(
    result.spans.every(
      (span) =>
        Object.keys(span).sort().join(',') === 'end,kind,rule,source,start',
    ),
  )
  assert.equal(requests.length, 0)
  console.log(
    'Redaction worker verified in Chromium: all categories, UTF-16 offsets, masking and zero HTTP requests.',
  )
} finally {
  await browser.close()
}

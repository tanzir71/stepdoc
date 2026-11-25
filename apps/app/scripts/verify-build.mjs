import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { chromium } from '@playwright/test'
import { readFile, readdir, stat } from 'node:fs/promises'
import assert from 'node:assert/strict'

const files = (
  await readdir(new URL('../dist/', import.meta.url), { recursive: true })
).map((file) => file.replaceAll('\\', '/'))
assert(
  !files.some((file) => file.includes('e2e') || file.includes('fixtures')),
  'Test fixtures leaked into production',
)
assert(
  files.some(
    (file) => file.endsWith('.woff2') && file.startsWith('assets/fonts/'),
  ),
  'Self-hosted fonts missing',
)
for (const file of files.filter((file) => /\.(js|css|svg|woff2)$/.test(file))) {
  const url = new URL(`../dist/${file.replaceAll('\\', '/')}`, import.meta.url)
  assert((await stat(url)).size > 0, 'Empty production asset')
  if (/\.(js|css)$/.test(file))
    assert(
      !(await readFile(url, 'utf8')).includes('figma.com/api/mcp/asset'),
      'Temporary design URL leaked into production',
    )
}
const server = await preview({
  configFile: false,
  root: fileURLToPath(new URL('../', import.meta.url)),
  preview: { host: '127.0.0.1', port: 0, strictPort: false },
})
let browser
try {
  const address = server.httpServer.address()
  assert(address && typeof address === 'object')
  const base = `http://127.0.0.1:${address.port}`
  browser = await chromium.launch()
  const page = await browser.newPage()
  const failures = []
  page.on('pageerror', () => failures.push('Browser runtime error'))
  page.on('requestfailed', () => failures.push('Resource request failed'))
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`HTTP ${response.status()}`)
  })
  page.on('request', (request) => {
    if (!request.url().startsWith(base) && !request.url().startsWith('blob:'))
      failures.push('Non-local runtime request')
  })
  await page.goto(base)
  await page.getByRole('heading', { name: 'Your library is ready' }).waitFor()
  await page.locator('[data-sd="library-create"]').click()
  await page
    .getByRole('textbox', { name: 'Guide title' })
    .fill('Production bundle guide')
  await page
    .getByRole('textbox', { name: 'First instruction' })
    .fill('Open local settings')
  await page.locator('[data-sd="guide-create-submit"]').click()
  await page.waitForURL(/\/g\/production-bundle-guide-/)
  await page.reload()
  await page
    .getByRole('heading', { name: 'Production bundle guide', exact: true })
    .waitFor()
  await page.locator('#step-1[data-sd-step="1"]').waitFor()
  await page.locator('[data-sd="guide-library"]').click()
  await page.locator('[data-sd="library-guide-open"]').waitFor()
  await page.evaluate(() => document.fonts.ready)
  assert(
    await page.evaluate(() => document.fonts.check('14px Geist')),
    'Geist font unavailable',
  )
  assert.deepEqual(failures, [])
  console.log(
    'Static production bundle: creation → native storage → deep-link reload → library; local fonts/assets; no runtime/network failures.',
  )
} finally {
  await browser?.close()
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  )
}

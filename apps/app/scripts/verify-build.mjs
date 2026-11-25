import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { chromium } from '@playwright/test'
import { readFile, readdir, stat } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { unzipSync } from 'fflate'

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
  await page.locator('[data-sd="guide-edit"]').click()
  await page
    .locator('[data-sd="step-title"]')
    .fill('Edited in the static production bundle')
  await page.keyboard.press('Control+s')
  await page.getByRole('button', { name: /^Saved, version/ }).waitFor()
  await page.locator('[data-sd="editor-image-file"]').setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: await readFile(
      new URL('../e2e/fixtures/editor-original.png', import.meta.url),
    ),
  })
  await page
    .getByText('Image processed in this browser and saved.', { exact: true })
    .first()
    .waitFor()
  await page.locator('.editor-image>img').waitFor()
  await page.reload()
  await page.locator('[data-sd="step-title"]').waitFor()
  assert.equal(
    await page.locator('[data-sd="step-title"]').inputValue(),
    'Edited in the static production bundle',
  )
  await page.locator('.editor-image>img').waitFor()
  await page.locator('[data-sd="export-open"]').click()
  for (const id of ['pdf', 'markdown', 'json'])
    await page.locator(`[data-sd="export-format-${id}"]`).uncheck()
  await page.locator('[data-sd="export-format-docx"]').check()
  const wordWaiting = page.waitForEvent('download')
  await page.locator('[data-sd="export-download"]').click()
  const wordDownload = await wordWaiting
  const word = unzipSync(
    new Uint8Array(await readFile(await wordDownload.path())),
  )
  assert(
    new TextDecoder()
      .decode(word['word/document.xml'])
      .includes('Edited in the static production bundle'),
  )
  assert(Object.keys(word).some((name) => name.startsWith('word/media/')))
  await page.locator('[data-sd="export-format-docx"]').uncheck()
  await page.locator('[data-sd="export-format-bundle"]').check()
  const bundleWaiting = page.waitForEvent('download')
  await page.locator('[data-sd="export-download"]').click()
  const bundleDownload = await bundleWaiting
  const bundle = await readFile(await bundleDownload.path())
  assert(unzipSync(new Uint8Array(bundle))['manifest.json'])
  await page.keyboard.press('Escape')
  await page.locator('[data-sd="editor-library"]').click()
  await page.locator('[data-sd="library-guide-open"]').waitFor()
  await page.locator('[data-sd="library-import-file"]').setInputFiles({
    name: 'production.stepdoc',
    mimeType: 'application/vnd.stepdoc+zip',
    buffer: bundle,
  })
  await page.locator('[data-sd="library-import-copy"]').click()
  await page.locator('[data-sd="library-guide-open"]').nth(1).waitFor()
  assert.equal(await page.locator('[data-sd="library-guide-open"]').count(), 2)
  await page.evaluate(() => document.fonts.ready)
  assert(
    await page.evaluate(() => document.fonts.check('14px Geist')),
    'Geist font unavailable',
  )
  assert.deepEqual(failures, [])
  console.log(
    'Static production bundle: creation → native storage → editor/image worker → deep-link reload → DOCX export worker → portable bundle export/import → separate library copy; local fonts/assets; no runtime/network failures.',
  )
} finally {
  await browser?.close()
  await new Promise((resolve, reject) =>
    server.httpServer.close((error) => (error ? reject(error) : resolve())),
  )
}

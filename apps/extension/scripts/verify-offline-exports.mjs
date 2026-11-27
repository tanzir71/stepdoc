import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, expect } from '@playwright/test'
import { extensionWorker } from './extension-worker.mjs'
import { packageExtensions, verifyDistribution } from './package.mjs'
import { workspace } from './runtime-source.mjs'

const require = createRequire(
  new URL('../../../packages/core/package.json', import.meta.url),
)
const { unzipSync, strFromU8 } = require('fflate')
const metadata = await verifyDistribution()
const provenancePath = join(
  workspace,
  'apps/extension/.output/build-chrome.json',
)
const provenance = await readFile(provenancePath, 'utf8')
try {
  await writeFile(
    provenancePath,
    JSON.stringify({
      ...JSON.parse(provenance),
      sourceSha256: '0'.repeat(64),
    }),
  )
  await assert.rejects(
    packageExtensions({ check: true }),
    /Rebuild the chrome extension/,
  )
} finally {
  await writeFile(provenancePath, provenance)
}
await mkdir(join(workspace, 'test-results'), { recursive: true })
const artifacts = await mkdtemp(
  join(workspace, 'test-results/offline-extension-'),
)
const unpacked = join(artifacts, 'extension')
const files = unzipSync(
  await readFile(
    join(workspace, 'site/downloads', metadata.browsers.chrome.file),
  ),
)
for (const [path, bytes] of Object.entries(files)) {
  assert(
    !path.startsWith('/') &&
      !path.includes('\\') &&
      !path.split('/').includes('..'),
    'Unsafe packaged path',
  )
  const target = join(unpacked, path)
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, bytes)
}
let context
const failures = []
const external = []
try {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    viewport: { width: 1440, height: 900 },
    args: [
      '--disable-gpu',
      `--disable-extensions-except=${unpacked}`,
      `--load-extension=${unpacked}`,
    ],
  })
  context.setDefaultTimeout(15000)
  context.on('request', (request) => {
    if (/^https?:/.test(request.url()))
      external.push('Context HTTP request')
  })
  await context.route(/^https?:\/\//, (route) => {
    external.push('HTTP request')
    return route.abort()
  })
  await context.setOffline(true)
  const worker = await extensionWorker(context)
  // Node's URL origin is "null" for chrome-extension; retain its full authority.
  const workerUrl = new URL(worker.url())
  const extensionOrigin = `${workerUrl.protocol}//${workerUrl.host}`
  assert(extensionOrigin.startsWith('chrome-extension://'))
  const page = await context.newPage()
  page.on('pageerror', () => failures.push('Extension runtime error'))
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push('Local asset failed')
  })
  page.on('request', (request) => {
    if (
      !request.url().startsWith(extensionOrigin) &&
      !/^(data:|blob:|about:)/.test(request.url())
    )
      external.push('Non-local resource')
  })
  await page.goto(extensionOrigin + '/app.html')
  await expect(
    page.getByRole('heading', { name: 'Your library is ready' }),
  ).toBeVisible()
  await page.locator('[data-sd="library-create-empty"]').click()
  await page
    .locator('[data-sd="guide-create-title"]')
    .fill('Offline extension exports')
  await page
    .locator('[data-sd="guide-create-instruction"]')
    .fill('Review the locally saved guide')
  await page.locator('[data-sd="guide-create-submit"]').click()
  await page.locator('[data-sd="guide-edit"]').click()
  await expect(page.locator('[data-sd="step-title"]')).toHaveValue(
    'Review the locally saved guide',
  )
  await page.locator('[data-sd="editor-image-file"]').setInputFiles({
    name: 'offline.png',
    mimeType: 'image/png',
    buffer: await readFile(
      new URL(
        '../../app/e2e/fixtures/editor-original.png',
        import.meta.url,
      ),
    ),
  })
  await expect(
    page
      .getByText('Image processed in this browser and saved.', {
        exact: true,
      })
      .first(),
  ).toBeVisible()
  await page.reload()
  await expect(page.locator('.editor-image>img')).toBeVisible()
  await page.locator('[data-sd="export-open"]').click()
  const names = [
    'PDF',
    'HTML',
    'Markdown',
    'DOCX',
    '.stepdoc',
    'guide.json',
    'Playwright',
    'SKILL.md',
  ]
  async function select(name) {
    for (const value of names)
      await page
        .getByRole('checkbox', { name: value, exact: true })
        .setChecked(value === name)
  }
  const downloaded = {}
  for (const name of names.filter((value) => value !== 'PDF')) {
    await select(name)
    const pending = page.waitForEvent('download')
    await page.locator('[data-sd="export-download"]').click()
    const download = await pending
    const bytes = await readFile(await download.path())
    assert(bytes.length > 100, 'Empty offline export')
    downloaded[name] = { bytes, name: download.suggestedFilename() }
    await writeFile(
      join(
        artifacts,
        name.replace(/[^a-z0-9]/gi, '-') +
          '-' +
          download.suggestedFilename(),
      ),
      bytes,
    )
    await expect(page.locator('[data-sd="export-download"]')).toBeEnabled()
    console.log(`Offline packaged-extension export verified: ${name}`)
  }
  const html = downloaded.HTML.bytes.toString('utf8')
  assert(
    html.includes('Offline extension exports') &&
      html.includes('Review the locally saved guide'),
  )
  assert(
    html.includes('data:image/') &&
      html.includes('data:font/woff2;base64,'),
    'HTML must embed images and fonts',
  )
  assert(
    !/<(?:img|script)[^>]+src=["']https?:\/\//i.test(html),
    'HTML depends on a server',
  )
  assert.equal(
    JSON.parse(downloaded['guide.json'].bytes.toString('utf8')).schema,
    'stepdoc/guide@1',
  )
  for (const name of ['Markdown', 'SKILL.md']) {
    const archive = unzipSync(downloaded[name].bytes)
    const main = name === 'Markdown' ? 'guide.md' : name
    assert(archive[main], `${name} content missing`)
    assert(
      Object.keys(archive).some((path) => /\.(?:png|webp)$/.test(path)),
      `${name} image missing`,
    )
  }
  const docx = unzipSync(downloaded.DOCX.bytes)
  assert(
    strFromU8(docx['word/document.xml']).includes(
      'Offline extension exports',
    ),
  )
  assert(
    Object.keys(docx).some((path) => path.startsWith('word/media/')),
    'DOCX image missing',
  )
  const bundle = unzipSync(downloaded['.stepdoc'].bytes)
  assert(
    bundle['guide.json'] &&
      Object.keys(bundle).some((path) => /\.(?:png|webp)$/.test(path)),
    'Portable bundle incomplete',
  )
  assert(
    downloaded.Playwright.bytes
      .toString('utf8')
      .includes('Offline extension exports'),
  )

  // Replace only the native printer UI. The product still builds/loads its real
  // print iframe, embedded fonts/images and calls that iframe's print() method.
  await page.evaluate(() => {
    const create = document.createElement.bind(document)
    document.createElement = function (name, options) {
      const element = create(name, options)
      if (name.toLowerCase() === 'iframe')
        element.addEventListener(
          'load',
          () => {
            Object.defineProperty(element.contentWindow, 'print', {
              value() {
                element.dataset.nativePrintRequested = 'true'
              },
              configurable: true,
            })
          },
          { once: true },
        )
      return element
    }
  })
  await select('PDF')
  await page.locator('[data-sd="export-print"]').click()
  const frame = page.locator('iframe[title="Printable guide"]')
  await expect(frame).toHaveAttribute('data-native-print-requested', 'true')
  const printHtml =
    '<!doctype html>\n' +
    (await frame.evaluate(
      (element) => element.contentDocument.documentElement.outerHTML,
    ))
  const renderer = await context.newPage()
  renderer.on('pageerror', () => failures.push('Print rendering error'))
  renderer.on('request', (request) => {
    if (/^https?:/.test(request.url()))
      external.push('Print resource requested HTTP')
  })
  await renderer.setContent(printHtml)
  await renderer.emulateMedia({ media: 'print' })
  await renderer.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((image) => image.decode()))
  })
  const pdf = await renderer.pdf({
    path: join(artifacts, 'guide.pdf'),
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  })
  assert(
    pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) && pdf.length > 2000,
    'Native browser PDF was not produced',
  )
  await writeFile(join(artifacts, 'guide.html'), html)
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('meta[name="stepdoc-api"]'),
    ),
    null,
  )
  assert.deepEqual(
    external,
    [],
    'Offline export attempted a network request',
  )
  assert.deepEqual(failures, [], 'Offline export runtime failed')
  console.log(
    `Compiled ZIP offline exports passed: PDF via native Print/Save as PDF, HTML, Markdown, DOCX, .stepdoc, guide.json, Playwright and SKILL.md; embedded fonts/images; zero backend/network requests. Artifacts: ${artifacts}`,
  )
} finally {
  await context?.close()
}

import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { guideSchema } from '@stepdoc/schema'
import { exportBundle, importBundle } from '@stepdoc/core/export/archive'
import { hook } from './helpers'
import { prepareEditor, storedGuide } from './editor-helpers'

test('W05 downloads all seven file formats from native images and preserves an editable portable bundle', async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepareEditor(page)
  await hook(page, 'export-open').click()
  await expect(page).toHaveURL(/\/g\/editor-guide\/export\?step=3/)
  const dialog = page.getByRole('dialog', { name: 'Export & publish' })
  await expect(dialog).toBeVisible()
  expect(await dialog.boundingBox()).toMatchObject({
    x: 260,
    y: 96,
    width: 920,
  })
  for (const id of [
    'html',
    'markdown',
    'docx',
    'bundle',
    'json',
    'playwright',
    'skill',
  ])
    await hook(page, `export-format-${id}`).check()
  const pending = page.waitForEvent('download')
  await hook(page, 'export-download').click()
  const result = await pending
  const path = info.outputPath('all-formats.zip')
  await result.saveAs(path)
  await expect(hook(page, 'export-feedback')).toContainText(
    'Export downloaded.',
  )
  const files = unzipSync(new Uint8Array(await readFile(path)))
  expect(
    Object.keys(files)
      .filter((name) => !name.startsWith('img/'))
      .sort(),
  ).toEqual([
    'SKILL.md',
    'editor-guide.stepdoc',
    'guide.docx',
    'guide.html',
    'guide.json',
    'guide.md',
    'replay.spec.ts',
  ])
  const json = guideSchema.parse(
    JSON.parse(new TextDecoder().decode(files['guide.json'])),
  )
  expect(json.steps[6]!.value).toEqual({
    kind: 'secret',
    variable: 'invoice_email',
  })
  expect(json.steps.every((step) => !step.screenshot?.original)).toBe(true)
  expect(
    Object.keys(files).filter((name) => name.startsWith('img/')),
  ).toHaveLength(9)
  const bundle = await importBundle(files['editor-guide.stepdoc']!)
  expect(bundle.guide.steps[2]!.edits?.annotations).toEqual([
    {
      type: 'rectangle',
      x: 1080,
      y: 188,
      width: 156,
      height: 60,
      text: 'Owners only',
      toX: 896,
      toY: 267,
      color: 'accent',
    },
  ])
  expect(bundle.assets['editor-step-3']?.original).toBeDefined()
  const word = unzipSync(files['guide.docx']!)
  expect(new TextDecoder().decode(word['word/document.xml'])).toContain(
    'Fictional Ledgerly billing settings',
  )
  expect(
    new TextDecoder().decode(word['word/document.xml']).match(/<w:drawing>/g),
  ).toHaveLength(9)
  expect(
    Object.keys(word).filter((name) => name.startsWith('word/media/')).length,
  ).toBeGreaterThan(0)
  await writeFile(info.outputPath('guide.docx'), files['guide.docx']!)
  await writeFile(info.outputPath('guide.html'), files['guide.html']!)
  expect(new TextDecoder().decode(files['guide.html'])).toContain(
    'data:font/woff2;base64,',
  )
  expect(errors).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/edit\?step=3/)
  await expect(hook(page, 'step-title')).toHaveValue('Click "Change plan"')
})

test('a native bundle import rekeys safe pixels and keeps an existing guide as a separate copy', async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  await prepareEditor(page)
  const before = await storedGuide(page)
  await page.goto('/g/editor-guide/export?step=3&formats=bundle')
  await expect(
    page.getByRole('dialog', { name: 'Export & publish' }),
  ).toBeVisible()
  const waiting = page.waitForEvent('download')
  await hook(page, 'export-download').click()
  const file = await waiting
  const path = info.outputPath('guide.stepdoc')
  await file.saveAs(path)
  await page.goto('/')
  await hook(page, 'library-import-file').setInputFiles(path)
  await expect(
    page.getByRole('dialog', { name: 'This guide is already in your library' }),
  ).toBeVisible()
  await hook(page, 'library-import-copy').click()
  await expect(hook(page, 'activity-live')).toContainText(
    'Guide and redacted images imported on this device.',
  )
  await expect(hook(page, 'library-guide-open')).toHaveCount(2)
  expect((await storedGuide(page)).steps).toEqual(before.steps)
  const copyId = await hook(page, 'library-guide-open').evaluateAll((links) =>
    links
      .map((link) => (link as HTMLAnchorElement).pathname.split('/').pop())
      .find((id) => id !== 'editor-guide'),
  )
  expect(copyId).toBeTruthy()
  const copy = await storedGuide(page, copyId)
  expect(copy.steps[2]!.screenshot!.rendered).not.toBe(
    before.steps[2]!.screenshot!.rendered,
  )
  expect(copy.steps[2]!.edits).toEqual(before.steps[2]!.edits)
  expect(copy.variables).toEqual(before.variables)
  await page.goto(`/g/${copyId}/edit?step=3`)
  await expect(hook(page, 'canvas-image')).toHaveAttribute('aria-busy', 'false')
  await expect(hook(page, 'canvas-image').locator('img')).toBeVisible()
})

test('print CSS prepares the same self-contained guide for native PDF printing', async ({
  page,
  context,
}, info) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      if (event.data?.type === 'sd-test-print')
        Reflect.set(window, 'sdTestPrintHtml', event.data.html)
    })
    const print = window.print.bind(window)
    window.print = () => {
      document.documentElement.dataset.sdPrintCalled = 'true'
      if (parent !== window)
        parent.postMessage(
          { type: 'sd-test-print', html: document.documentElement.outerHTML },
          parent.location.origin,
        )
      print()
    }
  })
  await prepareEditor(page)
  await page.goto('/g/editor-guide/export?step=3&formats=pdf')
  await expect(
    page.getByRole('dialog', { name: 'Export & publish' }),
  ).toBeVisible()
  await hook(page, 'export-print').click()
  await expect(hook(page, 'export-feedback')).toContainText(
    'Print dialog opened.',
  )
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'sdTestPrintHtml')))
    .toBeTruthy()
  const html: string = await page.evaluate(() =>
    Reflect.get(window, 'sdTestPrintHtml'),
  )
  expect(html).toContain('data-sd-print-called="true"')
  await expect(page.locator('iframe[title="Printable guide"]')).toHaveCount(0)
  await writeFile(info.outputPath('print.html'), html)
  const printed = await context.newPage()
  await printed.setContent(html)
  await printed.evaluate(async () => {
    await document.fonts.ready
    await Promise.all(Array.from(document.images, (image) => image.decode()))
  })
  const pdf = await printed.pdf({
    path: info.outputPath('guide.pdf'),
    preferCSSPageSize: true,
    printBackground: true,
    tagged: true,
  })
  expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  await expect(printed.locator('ol > li[data-sd-step]')).toHaveCount(9)
  expect(await printed.evaluate(() => document.fonts.check('14px Geist'))).toBe(
    true,
  )
  await printed.close()
})

test('copies Markdown, rich text and HTML through native clipboard controls', async ({
  page,
  context,
}) => {
  test.setTimeout(60_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await prepareEditor(page)
  await hook(page, 'export-open').click()
  await hook(page, 'export-copy-menu').click()
  await hook(page, 'export-copy-markdown').click()
  await expect(hook(page, 'export-feedback')).toContainText(
    'Markdown text copied.',
  )
  const markdown = await page.evaluate(() => navigator.clipboard.readText())
  expect(markdown).toContain('STEPDOC_INVOICE_EMAIL')
  expect(markdown).not.toContain('![Fictional')
  await hook(page, 'export-copy-menu').click()
  await hook(page, 'export-copy-rich').click()
  await expect(hook(page, 'export-feedback')).toContainText(
    'Rich text and images copied.',
  )
  const types = await page.evaluate(async () =>
    (await navigator.clipboard.read()).flatMap((item) => item.types),
  )
  expect(types).toEqual(expect.arrayContaining(['text/html', 'text/plain']))
  await hook(page, 'export-copy-menu').click()
  await hook(page, 'export-copy-html').click()
  await expect(hook(page, 'export-feedback')).toContainText(
    'Self-contained HTML copied.',
  )
  const html = await page.evaluate(() => navigator.clipboard.readText())
  expect(html).toContain('data:image/png;base64,')
  expect(html).not.toContain('aria-label="Guide formats"')
})

test('missing local images produce a recoverable export error while metadata still downloads', async ({
  page,
}, info) => {
  await prepareEditor(page)
  await page.evaluate(async () => {
    const path = '/src/repository.ts'
    const repo: typeof import('../src/repository') = await import(
      /* @vite-ignore */ path
    )
    const adapter = await repo.getStorage(),
      guide = await adapter.getGuide('editor-guide')
    guide.steps[2]!.screenshot!.original = null
    guide.steps[2]!.screenshot!.rendered = 'missing-local-image'
    await adapter.saveGuide(guide, guide.version)
  })
  await page.goto('/g/editor-guide/export/?step=3&formats=html')
  await expect(
    page.getByRole('dialog', { name: 'Export & publish' }),
  ).toBeVisible()
  await hook(page, 'export-download').click()
  await expect(hook(page, 'export-feedback')).toContainText(
    'The export could not finish.',
  )
  await hook(page, 'export-format-html').uncheck()
  await hook(page, 'export-format-json').check()
  const waiting = page.waitForEvent('download')
  await hook(page, 'export-download').click()
  const result = await waiting
  const path = info.outputPath('metadata.json')
  await result.saveAs(path)
  expect(
    guideSchema.parse(JSON.parse(await readFile(path, 'utf8'))).steps,
  ).toHaveLength(9)
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/edit\?step=3/)
  expect((await storedGuide(page)).id).toBe('editor-guide')
})

test('cancelling a bundle import leaves existing guides intact and creates no active partial guide', async ({
  page,
}, info) => {
  test.setTimeout(60_000)
  await prepareEditor(page)
  await page.goto('/g/editor-guide/export?step=3&formats=bundle')
  await expect(
    page.getByRole('dialog', { name: 'Export & publish' }),
  ).toBeVisible()
  const waiting = page.waitForEvent('download')
  await hook(page, 'export-download').click()
  const file = await waiting,
    path = info.outputPath('source.stepdoc')
  await file.saveAs(path)
  const parsed = await importBundle(new Uint8Array(await readFile(path)))
  parsed.guide.id = 'cancelled-import-guide'
  const bytes = await exportBundle(parsed.guide, parsed.assets)
  await page.goto('/')
  await hook(page, 'library-import-file').setInputFiles({
    name: 'cancel.stepdoc',
    mimeType: 'application/vnd.stepdoc+zip',
    buffer: Buffer.from(bytes),
  })
  await hook(page, 'library-import-stop').click()
  await expect(hook(page, 'library-import')).toHaveText('Import')
  await expect(hook(page, 'library-guide-open')).toHaveCount(1)
  await expect(hook(page, 'activity-live')).toContainText('Import cancelled.')
  await expect(storedGuide(page, 'cancelled-import-guide')).rejects.toThrow()
  expect((await storedGuide(page)).id).toBe('editor-guide')
})

test('a native image write failure removes only the new bundle import', async ({
  page,
}, info) => {
  test.setTimeout(60_000)
  await prepareEditor(page)
  const before = await storedGuide(page)
  await page.goto('/g/editor-guide/export?formats=bundle')
  const waiting = page.waitForEvent('download')
  await hook(page, 'export-download').click()
  const file = await waiting,
    path = info.outputPath('source.stepdoc')
  await file.saveAs(path)
  const parsed = await importBundle(new Uint8Array(await readFile(path)))
  parsed.guide.id = 'failed-import-guide'
  const bytes = await exportBundle(parsed.guide, parsed.assets)
  await page.goto('/')
  await expect(hook(page, 'library-guide-open')).toHaveCount(1)
  await page.evaluate(() => {
    // Inject at the real backend, independent of Vite module/adapter instances.
    const native = FileSystemWritableFileStream.prototype.write
    Reflect.set(window, 'sdTestBlobWrites', 0)
    FileSystemWritableFileStream.prototype.write = async function (
      this: FileSystemWritableFileStream,
      data: FileSystemWriteChunkType,
    ) {
      const writes = Number(Reflect.get(window, 'sdTestBlobWrites')) + 1
      Reflect.set(window, 'sdTestBlobWrites', writes)
      if (writes === 2)
        throw new DOMException('Synthetic write failure', 'QuotaExceededError')
      return native.call(this, data)
    }
  })
  await hook(page, 'library-import-file').setInputFiles({
    name: 'write-failure.stepdoc',
    mimeType: 'application/vnd.stepdoc+zip',
    buffer: Buffer.from(bytes),
  })
  await expect(hook(page, 'activity-live')).toContainText(
    'The guide could not be imported. Existing guides were kept.',
  )
  expect(
    await page.evaluate(() => Reflect.get(window, 'sdTestBlobWrites')),
  ).toBe(2)
  await expect(hook(page, 'library-import')).toBeEnabled()
  await expect(hook(page, 'library-guide-open')).toHaveCount(1)
  await expect(storedGuide(page, 'failed-import-guide')).rejects.toThrow()
  expect((await storedGuide(page)).steps).toEqual(before.steps)
})

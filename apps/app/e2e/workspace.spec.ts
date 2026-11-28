import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { importWorkspace } from '@stepdoc/core/export/workspace'
import { hook } from './helpers'
import { prepareEditor, storedGuide } from './editor-helpers'

test('W07 exports native redacted images, restores copies without a backend, and preserves the source guide', async ({
  page,
}, info) => {
  test.setTimeout(90000)
  await prepareEditor(page)
  await page.evaluate(async () => {
    const path = '/src/repository.ts'
    const module: typeof import('../src/repository') = await import(
      /* @vite-ignore */ path
    )
    const adapter = await module.getStorage()
    const guide = await adapter.getGuide('editor-guide')
    await adapter.saveGuide(
      {
        ...guide,
        publish: {
          publicId: 'source-public-id',
          isPublic: true,
          targets: ['link'],
        },
      },
      guide.version,
    )
  })
  const source = await storedGuide(page)
  await page.goto('/settings/storage')
  await expect(
    page.getByRole('heading', { name: 'This browser · IndexedDB' }),
  ).toBeVisible()
  await hook(page, 'storage-migrate-browser').click()
  await expect(page.getByRole('dialog')).toContainText(
    'offline StepDoc app or compiled extension',
  )
  await page.keyboard.press('Escape')
  await expect(page).toHaveURL(/\/settings\/storage$/)
  await hook(page, 'storage-export').click()
  const pending = page.waitForEvent('download')
  await hook(page, 'storage-export-confirm').click()
  const download = await pending
  const path = info.outputPath('workspace.stepdoc')
  await download.saveAs(path)
  const bytes = new Uint8Array(await readFile(path))
  const [guide] = await importWorkspace(bytes)
  expect(guide!.guide.id).toBe(source.id)
  expect(Object.keys(guide!.assets)).toHaveLength(9)
  expect(guide!.guide.steps[6]!.value).toEqual({
    kind: 'secret',
    variable: 'invoice_email',
  })
  await expect(hook(page, 'storage-feedback')).toContainText(
    'Workspace archive downloaded',
  )
  const apiRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/')) apiRequests.push(request.method())
  })
  await page.goto('/')
  await hook(page, 'library-import-file').setInputFiles({
    name: 'workspace.stepdoc',
    mimeType: 'application/vnd.stepdoc+zip',
    buffer: Buffer.from(bytes),
  })
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Workspace restored: 1 guide copy.' })
      .first(),
  ).toBeVisible()
  expect(await storedGuide(page)).toEqual(source)
  const copies = await page.evaluate(async () => {
    const path = '/src/repository.ts'
    const module: typeof import('../src/repository') = await import(
      /* @vite-ignore */ path
    )
    const adapter = await module.getStorage()
    const summaries = (await adapter.listGuides()).items
    return Promise.all(summaries.map((item) => adapter.getGuide(item.id)))
  })
  expect(copies.filter((item) => item.title === source.title)).toHaveLength(2)
  expect(copies.find((item) => item.id !== source.id)?.publish).toEqual({
    publicId: null,
    isPublic: false,
    targets: [],
  })
  expect(apiRequests).toEqual([])
})

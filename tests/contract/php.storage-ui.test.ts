import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expect as browserExpect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { guideSchema } from '@stepdoc/schema'
import { HttpAdapter } from '@stepdoc/storage/http'
import { importWorkspace } from '../../packages/core/src/export/workspace'
import { authFixture, type AuthFixture } from './auth-fixture'
import { authBrowser } from './auth-browser'

let fixture: AuthFixture
let native: Awaited<ReturnType<typeof authBrowser>> | undefined
let failures: string[]
const hook = (page: Page, name: string) => page.locator(`[data-sd="${name}"]`)
beforeEach(async () => {
  fixture = await authFixture()
  failures = []
}, 90000)
afterEach(async () => {
  await native?.close()
  native = undefined
  await fixture?.close()
  expect(failures).toEqual([])
})
async function open() {
  native = await authBrowser(fixture)
  const { page } = native
  page.setDefaultTimeout(10000)
  await page.setViewportSize({ width: 1440, height: 900 })
  page.on('pageerror', () => failures.push('Page runtime error'))
  page.on('response', (response) => {
    if (
      response.status() >= 400 &&
      ['script', 'stylesheet', 'image', 'font'].includes(
        response.request().resourceType(),
      )
    )
      failures.push('Production asset failed')
  })
  page.on('request', (request) => {
    if (
      !request.url().startsWith(fixture.server.origin) &&
      !/^(data:|blob:)/.test(request.url())
    )
      failures.push('External request')
  })
  await page.goto(fixture.server.origin + '/tools/settings/storage')
  await hook(page, 'auth-method-email').click()
  await hook(page, 'auth-email').fill(fixture.members.owner.email)
  await hook(page, 'auth-submit').click()
  await browserExpect(hook(page, 'auth-code')).toBeVisible()
  try {
    await hook(page, 'auth-code').fill(
      fixture.smtp.code(fixture.members.owner.email),
    )
  } catch {
    throw new Error('Private fixture code could not be entered')
  }
  await hook(page, 'auth-submit').click()
  await hook(page, 'auth-continue').click()
  await browserExpect(hook(page, 'storage-check')).toBeVisible()
  return native
}
async function audit(page: Page, name: string) {
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(async () => {
    const urls = [
      ...new Set(
        [...document.querySelectorAll('.sd-icon')]
          .map((node) => getComputedStyle(node).maskImage)
          .filter((value) => value.startsWith('url('))
          .map((value) => value.slice(5, -2)),
      ),
    ]
    await Promise.all(
      urls.map(
        (url) =>
          new Promise<void>((resolve, reject) => {
            const image = new Image()
            image.onload = () => resolve()
            image.onerror = () =>
              reject(new Error('Original vector did not load'))
            image.src = url
          }),
      ),
    )
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    )
  })
  expect(
    (await new AxeBuilder({ page }).analyze()).violations
      .filter((item) => item.impact === 'serious' || item.impact === 'critical')
      .map((item) => item.id),
  ).toEqual([])
  // Health origin contains a fixture port; normalize only that dynamic address.
  const tree =
    (await page.locator('.settings-layout').ariaSnapshot()).replaceAll(
      new URL(fixture.server.origin).host,
      'localhost:FIXTURE',
    ) + '\n'
  const file = new URL(
    `../../docs/v2/screens/${name}.aria.txt`,
    import.meta.url,
  )
  if (process.env.UPDATE_STORAGE_ARIA === '1') await writeFile(file, tree)
  else expect(tree).toBe(await readFile(file, 'utf8'))
  await page.screenshot({
    path: new URL(
      `../../docs/v2/screens/${name}.png`,
      import.meta.url,
    ).pathname.replace(/^\/([A-Z]:)/i, '$1'),
  })
}
describe('W07 real storage health and portable workspace', () => {
  it('reports actual PHP capabilities, exports paginated guides and restores separate copies', async () => {
    const adapter = await HttpAdapter.open(fixture.server.api, {
      auth: { kind: 'bearer', token: () => fixture.owner.token },
    })
    try {
      for (let index = 1; index <= 4; index++)
        await adapter.createGuide(
          guideSchema.parse({
            schema: 'stepdoc/guide@1',
            id: `backup-guide-${index}`,
            title: `Backup guide ${index}`,
            version: 1,
            createdAt: '2026-11-28T00:00:00Z',
            updatedAt: '2026-11-28T00:00:00Z',
            steps: [
              {
                id: 'first-step',
                index: 1,
                type: 'manual',
                title: 'Keep this instruction',
              },
            ],
          }),
        )
      const { page } = await open()
      await browserExpect(
        page.getByRole('heading', { name: 'Shared hosting · PHP + SQLite' }),
      ).toBeVisible()
      await browserExpect(
        page.getByText('Screenshot upload limit: 4 KB', { exact: true }),
      ).toBeVisible()
      await browserExpect(
        hook(page, 'storage-migrate-cloudflare'),
      ).toBeDisabled()
      await browserExpect(
        page.getByText('Usage and quota not reported by this server'),
      ).toBeVisible()
      await audit(page, 'w07-storage-php')
      await hook(page, 'storage-check').click()
      await browserExpect(hook(page, 'storage-check')).toHaveText('Run checks')
      await hook(page, 'storage-export').click()
      await audit(page, 'w07-storage-backup')
      const pending = page.waitForEvent('download')
      await hook(page, 'storage-export-confirm').click()
      const download = await pending
      const file = await download.path()
      expect(file).toBeTruthy()
      const bytes = new Uint8Array(await readFile(file!))
      const bundles = await importWorkspace(bytes)
      expect(bundles.map((item) => item.guide.id)).toEqual([
        'backup-guide-1',
        'backup-guide-2',
        'backup-guide-3',
        'backup-guide-4',
      ])
      await browserExpect(hook(page, 'storage-feedback')).toContainText(
        'Workspace archive downloaded',
      )
      await page.goto(fixture.server.origin + '/tools/')
      await hook(page, 'library-import-file').setInputFiles({
        name: 'workspace.stepdoc',
        mimeType: 'application/vnd.stepdoc+zip',
        buffer: Buffer.from(bytes),
      })
      await browserExpect(hook(page, 'library-import')).toBeEnabled({
        timeout: 30000,
      })
      await browserExpect(
        page
          .getByRole('status')
          .filter({ hasText: 'Workspace restored: 4 guide copies.' })
          .first(),
      ).toBeVisible()
      expect((await adapter.getGuide('backup-guide-1')).version).toBe(1)
      await page.unrouteAll({ behavior: 'wait' })
      await page.goto(fixture.server.origin + '/tools/settings/storage')
      let reads = 0
      await page.route(
        fixture.server.api + 'guides/backup-guide-1',
        async (route) => {
          if (++reads === 2) {
            const current = await adapter.getGuide('backup-guide-1')
            await adapter.saveGuide(
              { ...current, description: 'Changed during backup' },
              current.version,
            )
          }
          await route.continue()
        },
      )
      let downloads = 0
      page.on('download', () => downloads++)
      await hook(page, 'storage-export').click()
      await hook(page, 'storage-export-confirm').click()
      await browserExpect.poll(() => reads, { timeout: 30000 }).toBe(2)
      await browserExpect(hook(page, 'storage-feedback')).toContainText(
        'Workspace export could not finish',
      )
      expect(reads).toBe(2)
      expect(downloads).toBe(0)
      expect((await adapter.getGuide('backup-guide-1')).description).toBe(
        'Changed during backup',
      )
      await page.keyboard.press('Escape')
      await page.goto(fixture.server.origin + '/tools/settings/general')
      await browserExpect(
        page.getByText('Guides and images are stored on your server.', {
          exact: false,
        }),
      ).toBeVisible()
      await hook(page, 'settings-storage-details').click()
      await page.setViewportSize({ width: 390, height: 844 })
      await audit(page, 'w07-storage-narrow')
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      let total = 0,
        cursor: string | undefined
      do {
        const result = await adapter.listGuides({ cursor })
        total += result.items.length
        cursor = result.nextCursor ?? undefined
      } while (cursor)
      expect(total).toBe(8)
      await page.unrouteAll({ behavior: 'wait' })
      await page.goto(fixture.server.origin + '/tools/')
      let creates = 0
      await page.route(fixture.server.api + 'guides', async (route) => {
        if (route.request().method() === 'POST' && ++creates === 2)
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'unavailable', message: 'Unavailable' },
            }),
          })
        else await route.continue()
      })
      await hook(page, 'library-import-file').setInputFiles({
        name: 'workspace.stepdoc',
        mimeType: 'application/vnd.stepdoc+zip',
        buffer: Buffer.from(bytes),
      })
      await browserExpect(hook(page, 'library-import')).toBeEnabled({
        timeout: 30000,
      })
      await browserExpect(
        page
          .getByRole('status')
          .filter({ hasText: 'Workspace restore stopped after 1 of 4 copies.' })
          .first(),
      ).toBeVisible()
      expect((await adapter.getGuide('backup-guide-1')).version).toBe(2)
    } finally {
      adapter.close()
    }
  }, 120000)
  it('keeps previous checks on failure and cancels a held backup without a late download', async () => {
    const { page } = await open()
    await page.route(fixture.server.api + 'health', (route) => route.abort())
    await hook(page, 'storage-check').click()
    await browserExpect(page.getByRole('alert')).toContainText(
      'Previously reported results may be out of date',
    )
    await audit(page, 'w07-storage-check-failed')
    await page.unroute(fixture.server.api + 'health')
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = 0
    let delivered = 0
    await page.route(fixture.server.api + 'guides*', async (route) => {
      const response = await route.fetch()
      entered++
      await held
      await route.fulfill({ response }).catch(() => {})
      delivered++
    })
    let downloads = 0
    page.on('download', () => downloads++)
    await hook(page, 'storage-export').click()
    await hook(page, 'storage-export-confirm').click()
    try {
      await browserExpect.poll(() => entered).toBe(1)
      await page.keyboard.press('Escape')
      await browserExpect(page.getByRole('dialog')).not.toBeVisible()
      release()
      await browserExpect.poll(() => delivered).toBe(1)
      await page.waitForLoadState('networkidle')
      await page.unrouteAll({ behavior: 'wait' })
    } catch (error) {
      console.error('W07 held export state', {
        entered,
        dialog: await page.getByRole('dialog').count(),
        feedback: await hook(page, 'storage-feedback')
          .textContent()
          .catch(() => ''),
      })
      throw error
    } finally {
      release()
    }
    await hook(page, 'storage-check').click()
    await browserExpect(hook(page, 'storage-check')).toHaveText('Run checks')
    expect(downloads).toBe(0)
    await browserExpect(hook(page, 'storage-feedback')).toContainText(
      'Workspace export cancelled',
    )
  }, 120000)
})

import { test, expect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { prepare, hook } from './helpers'
import { fixture } from './fixtures'
import { prepareEditor } from './editor-helpers'

async function audit(page: Page, name: string) {
  await expect(page.locator('body')).toMatchAriaSnapshot({
    name: `${name}.aria.yml`,
  })
  const result = await new AxeBuilder({ page }).analyze()
  expect(
    result.violations
      .filter((item) => item.impact === 'serious' || item.impact === 'critical')
      .map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => ({
          target: node.target,
          summary: node.failureSummary,
        })),
      })),
  ).toEqual([])
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} library, collection, settings and preview routes expose stable accessible trees`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await page.addInitScript(
      (theme) =>
        localStorage.setItem(
          'stepdoc.preferences.v1',
          JSON.stringify({ version: 1, theme, collapsed: false }),
        ),
      theme,
    )
    await prepare(page)
    await expect(page.locator('.guide-card-thumb img')).toHaveCount(8)
    await audit(page, `${theme}-library`)
    await hook(page, 'library-view-list').click()
    await audit(page, `${theme}-library-list`)
    await hook(page, 'nav-collections').click()
    await audit(page, `${theme}-collections`)
    await hook(page, 'library-collection-open')
      .filter({ hasText: 'Finance ops' })
      .click()
    await expect(page.locator('.guide-card-thumb img')).toHaveCount(3)
    await audit(page, `${theme}-collection`)
    await hook(page, 'library-guide-open').first().click()
    await expect(page.locator('#step-1')).toBeVisible()
    await expect(page.locator('#step-1 img')).toBeVisible()
    await audit(page, `${theme}-preview`)
    await hook(page, 'settings-open').click()
    await audit(page, `${theme}-settings`)
    await hook(page, 'settings-storage-details').click()
    await audit(page, `${theme}-storage-dialog`)
    await page.keyboard.press('Escape')
    await page.goto('/does-not-exist')
    await audit(page, `${theme}-not-found`)
  })
}

test('empty, search-empty and creation/activity dialogs are accessible', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await prepare(page, false)
  await audit(page, 'empty-library')
  await hook(page, 'library-create').click()
  await audit(page, 'create-dialog')
  await page.keyboard.press('Escape')
  await hook(page, 'activity-open').click()
  await audit(page, 'activity-dialog')
  await page.keyboard.press('Escape')
  await page.goto('/e2e/seed.html')
  await expect(page.getByText('Seeded 48 guides')).toBeVisible()
  await page.goto('/?q=unmatched')
  await expect(
    page.getByRole('heading', { name: 'No matching guides' }),
  ).toBeVisible()
  await audit(page, 'no-matching-guides')
})

test('unavailable browser storage is accessible', async ({ page }) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, 'indexedDB', { get: () => undefined }),
  )
  await prepare(page, false)
  await audit(page, 'storage-error')
})

test('loading guides exposes an accessible busy state', async ({ page }) => {
  await page.addInitScript(() => {
    const open = indexedDB.open.bind(indexedDB)
    const setter = Object.getOwnPropertyDescriptor(
      IDBRequest.prototype,
      'onsuccess',
    )!.set!
    indexedDB.open = (name, version) => {
      const request = open(name, version)
      Object.defineProperty(request, 'onsuccess', {
        set(handler: IDBRequest['onsuccess']) {
          setter.call(
            request,
            handler
              ? (event: Event) =>
                  setTimeout(() => handler.call(request, event), 15_000)
              : null,
          )
        },
      })
      return request
    }
  })
  await page.goto('/')
  await expect(hook(page, 'library-results')).toHaveAttribute(
    'aria-busy',
    'true',
  )
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading guides' }),
  ).toBeVisible()
  await audit(page, 'loading-library')
})

test('duplicate import and activity feedback are accessible', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await prepare(page, false)
  const upload = () =>
    hook(page, 'library-import-file').setInputFiles({
      name: 'guide.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(fixture())),
    })
  await upload()
  await expect(hook(page, 'library-guide-open')).toHaveCount(1)
  await expect(hook(page, 'activity-live')).toContainText(
    'Guide imported on this device.',
  )
  await hook(page, 'activity-open').click()
  await expect(
    page.getByRole('dialog', { name: 'Activity log' }),
  ).toContainText('Guide imported on this device.')
  await audit(page, 'import-activity')
  await page.keyboard.press('Escape')
  await upload()
  await expect(
    page.getByRole('dialog', { name: 'This guide is already in your library' }),
  ).toBeVisible()
  await audit(page, 'duplicate-import-dialog')
})

for (const theme of ['light', 'dark'] as const) {
  test(`${theme} editor modes, inspector panels and numeric layers are accessible`, async ({
    page,
  }) => {
    test.setTimeout(150_000)
    await page.addInitScript(
      (theme) =>
        localStorage.setItem(
          'stepdoc.preferences.v1',
          JSON.stringify({ version: 1, theme, collapsed: false }),
        ),
      theme,
    )
    await prepareEditor(page)
    await audit(page, `${theme}-editor-target`)
    await hook(page, 'canvas-layer-select').first().click()
    await audit(page, `${theme}-editor-layers`)
    for (const panel of ['step', 'redact', 'history']) {
      await hook(page, `inspector-${panel}`).click()
      if (panel === 'history')
        await expect(
          page.getByRole('list', { name: 'Saved versions' }),
        ).toBeVisible()
      await audit(page, `${theme}-editor-${panel}`)
    }
    await hook(page, 'editor-mode-preview').click()
    await expect(page.locator('.editor-document #step-1 img')).toBeVisible()
    await audit(page, `${theme}-editor-preview`)
    await hook(page, 'editor-mode-agent').click()
    await audit(page, `${theme}-editor-agent`)
  })
}
test('editor dialogs expose named keyboard controls', async ({ page }) => {
  test.setTimeout(150_000)
  await prepareEditor(page)
  await hook(page, 'editor-add-step').click()
  await audit(page, 'editor-add-dialog')
  await page.keyboard.press('Escape')
  await hook(page, 'editor-guide-details').click()
  await audit(page, 'editor-guide-dialog')
  await page.keyboard.press('Escape')
  await hook(page, 'target-locator-edit').first().click()
  await audit(page, 'editor-locator-dialog')
  await page.keyboard.press('Escape')
  await hook(page, 'ai-cleanup').click()
  await audit(page, 'editor-cleanup-dialog')
  await page.keyboard.press('Escape')
  await hook(page, 'target-action').selectOption('fill')
  await hook(page, 'target-variable-add').click()
  await audit(page, 'editor-variable-dialog')
  await page.keyboard.press('Escape')
})

test('editor delete, unsaved-navigation and concurrent-write recovery are accessible', async ({
  page,
  context,
}) => {
  test.setTimeout(120_000)
  await prepareEditor(page)
  await hook(page, 'inspector-step').click()
  await hook(page, 'step-delete').click()
  await audit(page, 'editor-delete-dialog')
  await page.keyboard.press('Escape')
  await page.clock.install({ time: new Date('2026-11-25T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-11-25T12:00:01Z'))
  await hook(page, 'step-title').fill('Unsaved local title')
  await hook(page, 'editor-library').click()
  // Axe schedules timers internally. The navigation guard has already opened;
  // let autosave settle before auditing its still-open, native dialog.
  await page.clock.resume()
  await expect(hook(page, 'editor-save-status')).toContainText('Saved ·')
  await audit(page, 'editor-leave-dialog')
  await hook(page, 'editor-leave-stay').click()
  await page.keyboard.press('Control+s')
  await expect(hook(page, 'editor-save-status')).toContainText('Saved ·')
  const other = await context.newPage()
  await other.clock.setFixedTime(new Date('2026-11-25T12:00:01Z'))
  await other.goto('/g/editor-guide/edit?step=3')
  await expect(hook(other, 'step-title')).toHaveValue('Unsaved local title')
  await expect(hook(other, 'canvas-image')).toHaveAttribute(
    'aria-busy',
    'false',
  )
  await hook(page, 'step-title').fill('Remote title')
  await page.keyboard.press('Control+s')
  await expect(hook(page, 'editor-save-status')).toContainText('Saved ·')
  await hook(other, 'step-title').fill('Conflicting title')
  await other.keyboard.press('Control+s')
  await expect(
    other.getByRole('dialog', { name: 'Another tab saved a newer version' }),
  ).toBeVisible()
  await audit(other, 'editor-conflict-dialog')
  await hook(other, 'editor-conflict-reload').click()
  await expect(hook(other, 'step-title')).toHaveValue('Remote title')
  await other.close()
})

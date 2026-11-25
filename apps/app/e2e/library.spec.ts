import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { guideSchema } from '@stepdoc/schema'
import { fixture } from './fixtures'
import { prepare, hook } from './helpers'

test('creates a guide, reloads native storage, and downloads a valid document', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await prepare(page, false)
  await expect(
    page.getByRole('heading', { name: 'Your library is ready' }),
  ).toBeVisible()
  await hook(page, 'library-create').click()
  await expect(page).toHaveURL(/create=1/)
  await expect(page.getByRole('textbox', { name: 'Guide title' })).toBeFocused()
  await page
    .getByRole('textbox', { name: 'Guide title' })
    .fill('My first guide')
  await page
    .getByRole('textbox', { name: 'First instruction' })
    .fill('Open workspace settings')
  await hook(page, 'guide-create-submit').click()
  await expect(page).toHaveURL(/\/g\/my-first-guide-/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'My first guide',
  )
  await expect(hook(page, 'activity-live')).toContainText('Guide created')
  await page.reload()
  await expect(page.locator('#step-1[data-sd-step="1"]')).toContainText(
    'Open workspace settings',
  )
  const downloading = page.waitForEvent('download')
  await hook(page, 'guide-download-json').click()
  const download = await downloading
  const guide = guideSchema.parse(
    JSON.parse(await readFile((await download.path())!, 'utf8')),
  )
  expect(guide.title).toBe('My first guide')
  expect(guide.steps[0]).not.toHaveProperty('value')
  await hook(page, 'activity-open').click()
  await expect(
    page.getByRole('dialog', { name: 'Activity log' }),
  ).toContainText('Guide data downloaded')
  await page.keyboard.press('Escape')
  await expect(hook(page, 'activity-open')).toBeFocused()
  await hook(page, 'guide-library').click()
  await expect(hook(page, 'library-guide-open')).toHaveCount(1)
  expect(errors).toEqual([])
})

test('filters real guides by text, status and collection with show-all and durable URLs', async ({
  page,
}) => {
  await prepare(page)
  await expect(hook(page, 'library-guide-open')).toHaveCount(8)
  await expect(
    page.getByRole('tab', { name: 'All 48', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await hook(page, 'library-show-all').click()
  await expect(hook(page, 'library-guide-open')).toHaveCount(48)
  await page.reload()
  await expect(hook(page, 'library-guide-open')).toHaveCount(48)
  await hook(page, 'library-search').fill('plan dialog')
  await expect(hook(page, 'library-guide-open')).toHaveCount(48)
  await hook(page, 'library-search').fill('no match at all')
  await expect(
    page.getByRole('heading', { name: 'No matching guides' }),
  ).toBeVisible()
  await hook(page, 'library-clear').click()
  await hook(page, 'library-status-all').focus()
  await page.keyboard.press('ArrowRight')
  await expect(hook(page, 'library-status-draft')).toBeFocused()
  await expect(hook(page, 'library-status-draft')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(hook(page, 'library-guide-open')).toHaveCount(8)
  await expect(hook(page, 'library-show-all')).toHaveText('Show all 9 guides')
  await page.keyboard.press('End')
  await expect(hook(page, 'library-status-replay-passed')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(hook(page, 'library-show-all')).toHaveText('Show all 22 guides')
  await hook(page, 'library-status-needs-review').click()
  await expect(hook(page, 'library-guide-open')).toHaveCount(3)
  await hook(page, 'nav-archived').click()
  await expect(hook(page, 'library-status-archived')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await expect(hook(page, 'library-guide-open')).toHaveCount(8)
  await hook(page, 'nav-collections').click()
  await expect(hook(page, 'library-collection-open')).toHaveCount(6)
  await hook(page, 'library-search').fill('Rotate')
  await expect(hook(page, 'library-guide-open')).toHaveCount(1)
  await expect(page).not.toHaveURL(/collections=1/)
  await hook(page, 'nav-collections').click()
  await hook(page, 'library-collection-open')
    .filter({ hasText: 'Finance ops' })
    .click()
  await expect(
    page.getByRole('heading', { name: 'Finance ops', exact: true }),
  ).toBeVisible()
  await expect(hook(page, 'library-show-all')).toHaveText('Show all 14 guides')
  await hook(page, 'library-view-list').click()
  await hook(page, 'library-sort').selectOption('title')
  await page.reload()
  await expect(hook(page, 'library-view-list')).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(hook(page, 'library-sort')).toHaveValue('title')
  await expect(hook(page, 'library-guide-open').first()).toContainText(
    'Add a customer',
  )
  await page.goBack()
  await expect(hook(page, 'library-sort')).toHaveValue('edited')
})

test('imports copies without overwriting, rejects private field literals and never fetches remote images', async ({
  page,
}) => {
  const remote: string[] = []
  page.on('request', (request) => {
    if (
      !request.url().startsWith('http://127.0.0.1:3200') &&
      !request.url().startsWith('blob:')
    )
      remote.push(request.url())
  })
  await prepare(page, false)
  const guide = fixture()
  guide.steps[0]!.screenshot = {
    rendered: 'https://invalid.example/private.png',
    width: 200,
    height: 100,
  }
  const upload = () =>
    hook(page, 'library-import-file').setInputFiles({
      name: 'guide.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(guide)),
    })
  await upload()
  await expect(hook(page, 'library-guide-open')).toHaveCount(1)
  await upload()
  await expect(
    page.getByRole('dialog', { name: 'This guide is already in your library' }),
  ).toBeVisible()
  await hook(page, 'library-import-copy').click()
  await expect(hook(page, 'library-guide-open')).toHaveCount(2)
  const invalid = {
    ...guide,
    id: 'invalid-input-guide',
    steps: [
      {
        ...guide.steps[0],
        type: 'action',
        action: 'fill',
        value: { kind: 'literal', literal: 'synthetic-private-input' },
      },
    ],
  }
  await hook(page, 'library-import-file').setInputFiles({
    name: 'bad.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(invalid)),
  })
  await expect(hook(page, 'activity-live')).toContainText('not a valid guide@1')
  await expect(hook(page, 'library-guide-open')).toHaveCount(2)
  await hook(page, 'library-guide-open').first().click()
  await expect(
    page.getByText('Image not available on this device.', { exact: true }),
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole('heading', { name: 'Imported guide', exact: true }),
  ).toBeVisible()
  expect(remote).toEqual([])
})

test('keeps light as the default and persists explicit dark/system and navigation preferences', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await prepare(page)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await hook(page, 'settings-open').click()
  await expect(page.locator('#main')).toBeFocused()
  await hook(page, 'theme-dark').click()
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await hook(page, 'theme-system').click()
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.keyboard.press('Control+k')
  await expect(hook(page, 'library-search')).toBeFocused()
  await hook(page, 'nav-collapse').click()
  await page.reload()
  await expect(hook(page, 'nav-collapse')).toHaveAttribute(
    'aria-label',
    'Expand navigation',
  )
  await hook(page, 'nav-collapse').click()
  await hook(page, 'library-create').click()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('dialog', { name: 'Create a guide' }),
  ).not.toBeVisible()
  await expect(page).not.toHaveURL(/create=/)
  await expect(hook(page, 'library-create')).toBeFocused()
})

test('retains local filtering while the loaded page is offline and handles narrow screens', async ({
  page,
  context,
}) => {
  await prepare(page)
  await context.setOffline(true)
  await expect(
    page.getByText('Offline · browser storage remains available.'),
  ).toBeVisible()
  await hook(page, 'library-search').fill('Rotate')
  await expect(hook(page, 'library-guide-open')).toHaveCount(1)
  await context.setOffline(false)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true)
  await hook(page, 'library-guide-open').click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Rotate the Ledgerly API key',
  )
})

test('shows unavailable-storage state and retries without changing stored data', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const native = window.indexedDB
    Object.defineProperty(window, 'indexedDB', {
      configurable: true,
      get: () => undefined,
    })
    window.addEventListener(
      'stepdoc:test-restore',
      () =>
        Object.defineProperty(window, 'indexedDB', {
          configurable: true,
          value: native,
        }),
      { once: true },
    )
  })
  await prepare(page, false)
  await expect(
    page.getByRole('heading', { name: 'Browser storage is unavailable' }),
  ).toBeVisible()
  await page.evaluate(() =>
    window.dispatchEvent(new Event('stepdoc:test-restore')),
  )
  await hook(page, 'library-retry').click()
  await expect(
    page.getByRole('heading', { name: 'Your library is ready' }),
  ).toBeVisible()
})

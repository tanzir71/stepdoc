import { expect, type Page } from '@playwright/test'
import type { Guide } from '@stepdoc/schema'
import { hook } from './helpers'
export async function prepareEditor(page: Page) {
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00Z'))
  await page.goto('/e2e/editor-seed.html')
  await expect(
    page.getByText('Editor fixture ready', { exact: true }),
  ).toBeVisible()
  await page.goto('/g/editor-guide/edit?step=3')
  await expect(hook(page, 'step-title')).toHaveValue('Click "Change plan"')
  await expect(hook(page, 'canvas-image')).toHaveAttribute('aria-busy', 'false')
  await expect(hook(page, 'canvas-image').locator('img')).toBeVisible()
}
export async function storedGuide(
  page: Page,
  id = 'editor-guide',
): Promise<Guide> {
  return page.evaluate(async (id) => {
    const path = '/src/repository.ts'
    const repo: typeof import('../src/repository') = await import(
      /* @vite-ignore */ path
    )
    return (await repo.getStorage()).getGuide(id)
  }, id)
}

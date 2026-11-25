import { expect, type Page } from '@playwright/test'

export async function prepare(page: Page, seeded = true) {
  await page.clock.setFixedTime(new Date('2026-11-25T12:00:00Z'))
  if (seeded) {
    await page.goto('/e2e/seed.html')
    await expect(
      page.getByText('Seeded 48 guides', { exact: true }),
    ).toBeVisible()
  }
  await page.goto('/')
  await expect(page.locator('[data-sd="library-results"]')).toHaveAttribute(
    'aria-busy',
    'false',
  )
}
export const hook = (page: Page, name: string) =>
  page.locator(`[data-sd="${name}"]`)

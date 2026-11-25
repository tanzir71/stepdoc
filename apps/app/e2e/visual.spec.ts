import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prepare } from './helpers'

test('W02/W12 library geometry follows the reference at 1440 by 900', async ({
  page,
}, info) => {
  await prepare(page)
  await expect(page.locator('.guide-card-thumb img')).toHaveCount(8)
  await page.evaluate(() => document.fonts.ready)
  const boxes = await page.evaluate(() => {
    const box = (selector: string) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    return {
      sidebar: box('.app-sidebar'),
      header: box('.library-header'),
      filters: box('.library-filters'),
      grid: box('.guide-grid'),
      thumb: box('.guide-card-thumb'),
    }
  })
  expect(boxes.sidebar).toEqual({ x: 0, y: 0, width: 248, height: 900 })
  expect(boxes.header).toEqual({ x: 248, y: 0, width: 1192, height: 104 })
  expect(boxes.filters).toEqual({ x: 280, y: 104, width: 1128, height: 56 })
  expect(boxes.grid.x).toBe(280)
  expect(boxes.grid.y).toBe(160)
  expect(boxes.thumb.width).toBe(270)
  expect(boxes.thumb.height).toBe(152)
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((theme) => {
      localStorage.setItem(
        'stepdoc.preferences.v1',
        JSON.stringify({ version: 1, theme, collapsed: false }),
      )
    }, theme)
    await page.reload()
    await expect(page.locator('.guide-card-thumb img')).toHaveCount(8)
    await page.evaluate(() => document.fonts.ready)
    const target = process.env.STEPDOC_UPDATE_SCREENS
      ? fileURLToPath(
          new URL(
            `../../../docs/v2/screens/W02-library-${theme}.png`,
            import.meta.url,
          ),
        )
      : info.outputPath(`W02-library-${theme}.png`)
    if (process.env.STEPDOC_UPDATE_SCREENS)
      await mkdir(new URL('../../../docs/v2/screens/', import.meta.url), {
        recursive: true,
      })
    await page.screenshot({ path: target, animations: 'disabled' })
  }
})

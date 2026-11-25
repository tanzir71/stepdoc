import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prepare, hook } from './helpers'
import { prepareEditor } from './editor-helpers'

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

test('W03 editor uses the reference three-pane canvas geometry in both themes', async ({
  page,
}, info) => {
  await prepareEditor(page)
  await page.evaluate(() => document.fonts.ready)
  const box = await page.evaluate(() => {
    const rect = (selector: string) => {
      const r = document.querySelector(selector)!.getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return {
      header: rect('.editor-topbar'),
      steps: rect('.editor-step-list'),
      inspector: rect('.editor-inspector'),
      image: rect('.editor-image'),
    }
  })
  expect(box.header).toEqual({ x: 0, y: 0, width: 1440, height: 56 })
  expect(box.steps).toEqual({ x: 0, y: 56, width: 320, height: 844 })
  expect(box.inspector).toEqual({ x: 1100, y: 56, width: 340, height: 844 })
  expect(box.image.width).toBe(680)
  expect(box.image.height).toBe(425)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) =>
        localStorage.setItem(
          'stepdoc.preferences.v1',
          JSON.stringify({ version: 1, theme, collapsed: false }),
        ),
      theme,
    )
    await page.reload()
    await expect(page.locator('.editor-image>img')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    const target = process.env.STEPDOC_UPDATE_SCREENS
      ? fileURLToPath(
          new URL(
            `../../../docs/v2/screens/W03-editor-${theme}.png`,
            import.meta.url,
          ),
        )
      : info.outputPath(`W03-editor-${theme}.png`)
    await page.screenshot({ path: target, animations: 'disabled' })
  }
})

test('W05 export dialog follows the reference geometry in both themes', async ({
  page,
}, info) => {
  await prepareEditor(page)
  await hook(page, 'export-open').click()
  await expect(
    page.getByRole('dialog', { name: 'Export & publish' }),
  ).toBeVisible()
  expect(await page.locator('.export-dialog').boundingBox()).toEqual({
    x: 260,
    y: 96,
    width: 920,
    height: 576,
  })
  expect(await page.locator('.export-targets').boundingBox()).toMatchObject({
    width: 380,
  })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (theme) =>
        localStorage.setItem(
          'stepdoc.preferences.v1',
          JSON.stringify({ version: 1, theme, collapsed: false }),
        ),
      theme,
    )
    await page.reload()
    await expect(
      page.getByRole('dialog', { name: 'Export & publish' }),
    ).toBeVisible()
    await expect(page.locator('.editor-image>img')).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({
      path: process.env.STEPDOC_UPDATE_SCREENS
        ? fileURLToPath(
            new URL(
              `../../../docs/v2/screens/W05-export-${theme}.png`,
              import.meta.url,
            ),
          )
        : info.outputPath(`W05-export-${theme}.png`),
      animations: 'disabled',
    })
  }
})

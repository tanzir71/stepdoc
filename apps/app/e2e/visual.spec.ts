import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prepare, hook } from './helpers'
import { prepareEditor } from './editor-helpers'

async function auditAssets(page: Page, info: TestInfo, name: string) {
  const roots: Array<{ file: string; width: number; height: number }> =
    JSON.parse(
      await readFile(
        new URL('../../../packages/ui/assets/dimensions.json', import.meta.url),
        'utf8',
      ),
    )
  const assets = await page.locator('[data-asset], img').evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      const box = node.getBoundingClientRect()
      if (!box.width || !box.height) return []
      const img = node instanceof HTMLImageElement ? node : null
      const source = img ? img.src : getComputedStyle(node).maskImage
      const file = source.match(/([a-z0-9]+\.svg)(?:[?"\s)]|$)/i)?.[1]
      if (!file) return [] // Guide screenshots are dynamic native blobs.
      return [
        {
          file,
          slot: node.closest('[data-sd]')?.getAttribute('data-sd'),
          box: box.toJSON(),
          layoutWidth: img
            ? img.width
            : parseFloat(getComputedStyle(node).width),
          layoutHeight: img
            ? img.height
            : parseFloat(getComputedStyle(node).height),
          loaded: !img || (img.complete && img.naturalWidth > 0),
          maskSize: img ? null : getComputedStyle(node).maskSize,
        },
      ]
    }),
  )
  expect(assets.length).toBeGreaterThan(10)
  for (const asset of assets) {
    const root = roots.find((root) => root.file === asset.file)
    expect(root, asset.file).toBeDefined()
    expect(asset.loaded, asset.file).toBe(true)
    expect(asset.layoutWidth, asset.file).toBe(root!.width)
    expect(asset.layoutHeight, asset.file).toBe(root!.height)
    if (asset.maskSize !== null) {
      expect(asset.maskSize).toBe('auto')
      expect(asset.box.width, asset.file).toBeCloseTo(root!.width, 2)
      expect(asset.box.height, asset.file).toBeCloseTo(root!.height, 2)
    }
  }
  const path = info.outputPath(`${name}-assets.json`)
  await writeFile(path, JSON.stringify(assets, null, 2))
  await info.attach(`${name}-assets`, {
    path,
    contentType: 'application/json',
  })
}

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
    await auditAssets(page, info, `W02-${theme}`)
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
  const caption = await page
    .locator('.editor-image>img')
    .evaluate(async (element) => {
      const image = element as HTMLImageElement
      await image.decode()
      const canvas = new OffscreenCanvas(
          image.naturalWidth,
          image.naturalHeight,
        ),
        ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      const { data } = ctx.getImageData(800, 250, 270, 80)
      const xs: number[] = [],
        ys: number[] = []
      for (let y = 0; y < 80; y++)
        for (let x = 0; x < 270; x++) {
          const at = (y * 270 + x) * 4
          if (data[at] === 242 && data[at + 1] === 85 && data[at + 2] === 31) {
            xs.push(x)
            ys.push(y)
          }
        }
      canvas.width = canvas.height = 1
      return {
        x: Math.min(...xs) + 800,
        y: Math.min(...ys) + 250,
        width: Math.max(...xs) - Math.min(...xs) + 1,
        height: Math.max(...ys) - Math.min(...ys) + 1,
      }
    })
  expect(caption).toMatchObject({ x: 896, y: 267, height: 45 })
  expect(Math.abs(caption.width - 162)).toBeLessThanOrEqual(2)
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
    await auditAssets(page, info, `W03-${theme}`)
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
    await auditAssets(page, info, `W05-${theme}`)
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

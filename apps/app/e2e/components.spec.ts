import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, stat } from 'node:fs/promises'
import { hook } from './helpers'

test('component controls preserve semantics, asset dimensions and keyboard state', async ({
  page,
}) => {
  await page.goto('/e2e/components.html')
  await expect(hook(page, 'gallery-button-primary-m')).toBeVisible()
  expect(
    await hook(page, 'gallery-button-primary-m').evaluate(
      (node) => node.getBoundingClientRect().height,
    ),
  ).toBe(36)
  expect(
    await hook(page, 'gallery-button-primary-s').evaluate(
      (node) => node.getBoundingClientRect().height,
    ),
  ).toBe(28)
  expect(
    await hook(page, 'gallery-icon-button').evaluate(
      (node) => node.getBoundingClientRect().width,
    ),
  ).toBe(32)
  await hook(page, 'gallery-toggle').focus()
  await page.keyboard.press('Space')
  await expect(hook(page, 'gallery-toggle')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await hook(page, 'gallery-checkbox').check()
  await expect(hook(page, 'gallery-checkbox')).toBeChecked()
  await hook(page, 'gallery-segment-first').focus()
  await page.keyboard.press('ArrowRight')
  await expect(hook(page, 'gallery-segment-second')).toBeFocused()
  await expect(hook(page, 'gallery-segment-second')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  for (const theme of ['light', 'dark']) {
    await page
      .locator('html')
      .evaluate((node, theme) => (node.dataset.theme = theme), theme)
    const violations = (
      await new AxeBuilder({ page }).analyze()
    ).violations.filter(
      (item) => item.impact === 'serious' || item.impact === 'critical',
    )
    expect(
      violations.map((item) => ({
        id: item.id,
        nodes: item.nodes.map((node) => node.target),
      })),
    ).toEqual([])
    await expect(page.locator('body')).toMatchAriaSnapshot({
      name: `${theme}-components.aria.yml`,
    })
    const icons = await page.locator('[data-asset]').evaluateAll((nodes) =>
      nodes.map((node) => ({
        box: node.getBoundingClientRect().toJSON(),
        mask: getComputedStyle(node).maskImage,
        size: getComputedStyle(node).maskSize,
      })),
    )
    for (const icon of icons) {
      expect(icon.box.width).toBeGreaterThan(0)
      expect(icon.box.height).toBeGreaterThan(0)
      expect(icon.mask).toContain('.svg')
      expect(icon.size).toBe('auto')
    }
    for (const image of await page.locator('img:visible').all())
      expect(
        await image.evaluate(
          (node) =>
            node instanceof HTMLImageElement &&
            node.complete &&
            node.naturalWidth > 0 &&
            node.width === node.naturalWidth &&
            node.height === node.naturalHeight,
        ),
      ).toBe(true)
  }
  const dimensions: Array<{ file: string; width: number; height: number }> =
    JSON.parse(
      await readFile('../../packages/ui/assets/dimensions.json', 'utf8'),
    )
  for (const asset of dimensions) {
    const file = `../../packages/ui/assets/${asset.file}`
    expect((await stat(file)).size).toBeGreaterThan(0)
    const source = await readFile(file, 'utf8')
    expect(source).toMatch(new RegExp(`width="${asset.width}"`))
    expect(source).toMatch(new RegExp(`height="${asset.height}"`))
  }
  // Dark Figma exports differ in fill color. Prove that the shared, recolored
  // mask is an exact silhouette match at its unchanged intrinsic dimensions.
  const variants = [
    ['3e6da.svg', '25fac.svg', 14],
    ['3c0c1.svg', '57a55.svg', 16],
    ['7f093.svg', '2d1a1.svg', 16],
    ['a08f2.svg', '3074b.svg', 6],
  ] as const
  await page.evaluate(async (variants) => {
    const panel = document.createElement('div')
    panel.style.cssText =
      'display:flex;align-items:flex-start;gap:16px;padding:16px;background:white'
    for (const [canonical, variant, size] of variants)
      for (const file of [canonical, variant]) {
        const icon = document.createElement('span')
        icon.dataset.variant = file
        const existing = document.querySelector<HTMLElement>('[data-asset]')!
        const mask = getComputedStyle(existing).maskImage
        const base = mask
          .slice(mask.indexOf('"') + 1, mask.lastIndexOf('"'))
          .replace(/[^/]+$/, '')
        const asset = base + file
        const response = await fetch(asset)
        if (!response.ok) throw new Error('Reference asset unavailable')
        icon.style.cssText = `display:block;flex:none;width:${size}px;height:${size}px;background:black;mask-image:url("${asset}");mask-size:auto;mask-repeat:no-repeat;mask-position:center`
        panel.append(icon)
      }
    document.body.append(panel)
  }, variants)
  for (const [canonical, variant] of variants) {
    const a = await page.locator(`[data-variant="${canonical}"]`).screenshot()
    const b = await page.locator(`[data-variant="${variant}"]`).screenshot()
    expect(a.equals(b), `${canonical} matches ${variant}`).toBe(true)
  }
})

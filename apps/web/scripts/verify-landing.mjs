/* global process, document, getComputedStyle, innerWidth, scrollY, OffscreenCanvas, createImageBitmap */
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export async function verifyLanding({
  pageAt,
  landing,
  entry,
  origin,
  root,
  output,
}) {
  const update = process.env.STEPDOC_UPDATE_SITE === '1'
  const snapshots = path.join(root, 'apps/web/tests/landing')
  await mkdir(snapshots, { recursive: true })
  const manifest = JSON.parse(
    await readFile(path.join(root, 'site/assets/provenance.json'), 'utf8'),
  )
  async function inspect(page, name, paint = false) {
    await page.evaluate(() => document.fonts.ready)
    await page
      .locator('img')
      .evaluateAll((images) =>
        Promise.all(images.map((image) => image.decode().catch(() => {}))),
      )
    const png = await page.screenshot({
      fullPage: true,
      path: path.join(output, name + '.png'),
    })
    const layout = await page.evaluate(() =>
      Object.fromEntries(
        [
          ...document.querySelectorAll(
            '[data-figma],h1,.human-shot,.site-header .sd-logo,.site-footer .credit',
          ),
        ].map((element) => {
          const r = element.getBoundingClientRect()
          return [
            element.dataset.figma ?? element.className ?? element.tagName,
            { x: r.x, y: r.y + scrollY, width: r.width, height: r.height },
          ]
        }),
      ),
    )
    await writeFile(
      path.join(output, name + '-layout.json'),
      JSON.stringify(layout, null, 2),
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow ${name}`,
    )
    const violations = (await new AxeBuilder({ page }).analyze()).violations
    assert.deepEqual(
      violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
      [],
      `Axe ${name}`,
    )
    const aria = `${await page.locator('body').ariaSnapshot()}\n`
    const file = path.join(snapshots, name + '.aria.yml')
    if (update) await writeFile(file, aria)
    else
      assert.equal(
        aria,
        (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'),
        `Aria ${name}`,
      )
    if (paint) {
      const assets = await page
        .locator('[data-asset]')
        .evaluateAll((elements) =>
          elements
            .filter((element) => element.checkVisibility())
            .map((element) => {
              const r = element.getBoundingClientRect()
              return {
                file: element.dataset.asset,
                width: r.width,
                height: r.height,
                x: r.x,
                y: r.y + scrollY,
                loaded: element.complete && element.naturalWidth > 0,
                logo: element.classList.contains('sd-logo-light'),
              }
            }),
        )
      for (const asset of assets) {
        const source = manifest.assets.find(
          (source) => source.file === asset.file,
        )
        assert(source && asset.loaded, `Loaded original ${asset.file}`)
        assert(
          (await stat(path.join(root, 'site/assets', asset.file))).size > 0,
        )
        if (asset.file.endsWith('.svg')) {
          const scale = asset.logo ? 0.75 : 1
          assert(
            Math.abs(asset.width - source.width * scale) < 0.1 &&
              Math.abs(asset.height - source.height * scale) < 0.1,
            `Original root geometry ${name}: ${asset.file}`,
          )
        }
      }
      const painted = await page.evaluate(
        async ({ png, assets }) => {
          const bitmap = await createImageBitmap(
            await (await fetch(`data:image/png;base64,${png}`)).blob(),
          )
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
            ctx = canvas.getContext('2d')
          ctx.drawImage(bitmap, 0, 0)
          bitmap.close()
          return assets
            .filter((asset) => asset.file.endsWith('.svg'))
            .map((asset) => {
              const data = ctx.getImageData(
                  Math.floor(asset.x),
                  Math.floor(asset.y),
                  Math.ceil(asset.width),
                  Math.ceil(asset.height),
                ).data,
                colors = new Set()
              for (let i = 0; i < data.length; i += 4)
                colors.add(data.slice(i, i + 3).join(','))
              return { file: asset.file, painted: colors.size > 1 }
            })
        },
        { png: png.toString('base64'), assets },
      )
      assert(
        painted.every((asset) => asset.painted),
        `Every original SVG paints ${name}: ${JSON.stringify(painted.filter((asset) => !asset.painted))}`,
      )
      assert(assets.length >= 30, `Complete visible asset inventory ${name}`)
    }
    return layout
  }
  const desktop = await pageAt({ width: 1440, height: 900 })
  await desktop.page.goto(entry)
  await desktop.page.waitForURL(entry)
  await expect(desktop.page.getByRole('heading', { level: 1 })).toHaveText(
    'Record it once. People read it. Agents run it.',
  )
  await desktop.page.evaluate(() => document.fonts.ready)
  if (update)
    await desktop.page.screenshot({
      path: path.join(root, 'site/og.png'),
      clip: { x: 120, y: 0, width: 1200, height: 630 },
    })
  const layout = await inspect(desktop.page, 'landing-desktop', true)
  const expected = [
    ['32:7456', 0, 72],
    ['32:7486', 72, 516],
    ['32:7504', 588, 572],
    ['32:7680', 1160, 292],
    ['32:7721', 1452, 672],
    ['32:7937', 2124, 568],
    ['32:7983', 2692, 380],
    ['32:8010', 3072, 780],
    ['32:8107', 3852, 288],
    ['32:8122', 4140, 312],
    ['32:8137', 4452, 80],
  ]
  for (const [id, y, height] of expected)
    assert(
      Math.abs(layout[id].y - y) <= 2 &&
        Math.abs(layout[id].height - height) <= 2,
      `Desktop Figma frame ${id}: ${JSON.stringify(layout[id])}`,
    )
  const colors = await desktop.page.evaluate(() => ({
    canvas: getComputedStyle(document.body).backgroundColor,
    headerBorder: getComputedStyle(document.querySelector('header'))
      .borderBottomWidth,
    hero: getComputedStyle(document.querySelector('h1')).fontSize,
  }))
  assert.equal(colors.headerBorder, '0px')
  assert.equal(colors.hero, '68px')
  const resources = [
    'styles.css',
    'main.js',
    'ui/styles.css',
    'ui/tokens.css',
    'fonts/GeistSans.woff2',
    'fonts/GeistMono.woff2',
    'fonts/OFL.txt',
    'og.png',
    'llms.txt',
    'docs/',
    'docs/guide.schema.json',
    'demo/guide.json',
    'demo/guide.md',
    'demo/replay.spec.ts',
    'demo/SKILL.md',
  ]
  for (const resource of resources)
    assert.equal(
      (
        await desktop.page.request.get(new URL(resource, landing).href)
      ).status(),
      200,
      `Project resource ${resource}`,
    )
  const allLinks = await desktop.page
    .locator('a[href]')
    .evaluateAll((links) => links.map((link) => link.href))
  for (const link of new Set(
    allLinks.filter((link) => link.startsWith(origin)),
  )) {
    const url = new URL(link)
    assert(
      url.pathname.startsWith('/stepdoc/'),
      'Project-relative link stays inside Pages prefix',
    )
    assert.equal(
      (await desktop.page.request.get(url.href)).status(),
      200,
      `Internal link ${url.pathname}`,
    )
    if (
      url.hash &&
      [new URL(landing).pathname, new URL(entry).pathname].includes(
        url.pathname,
      )
    )
      assert(
        await desktop.page.locator(`[id="${url.hash.slice(1)}"]`).count(),
        `Section anchor ${url.hash}`,
      )
  }
  const guide = await (
    await desktop.page.request.get(landing + 'demo/guide.json')
  ).json()
  assert.equal(guide.schema, 'stepdoc/guide@1')
  const shown = await desktop.page.locator('.signature-code').textContent()
  const step = JSON.parse(shown.split('// replay.spec.ts')[0].trim())
  assert.equal(step.title, guide.steps[2].title)
  assert.equal(step.target.name, guide.steps[2].target.name)
  await desktop.page.locator('.human-shot').click()
  await desktop.page.waitForURL(landing + 'demo/')
  await expect(desktop.page.getByRole('heading', { level: 1 })).toHaveText(
    guide.title,
  )
  await expect(desktop.page.locator('meta[name=generator]')).toHaveAttribute(
    'content',
    'StepDoc',
  )
  await expect(desktop.page.locator('figure img')).toHaveCount(3)
  assert(
    await desktop.page
      .locator('figure img')
      .evaluateAll((images) =>
        images.every((image) => image.complete && image.naturalWidth > 0),
      ),
  )
  await desktop.page.screenshot({
    path: path.join(output, 'exported-guide.png'),
    fullPage: true,
  })
  await desktop.context.close()
  for (const width of [390, 320, 768, 1024]) {
    const mobile = await pageAt({ width, height: 900 })
    await mobile.page.goto(entry)
    await mobile.page.waitForURL(entry)
    if (width === 390) {
      const layout = await inspect(mobile.page, 'landing-mobile', true)
      const heights = [
        ['32:7456', 60],
        ['32:7486', 424],
        ['32:7504', 511],
        ['32:7680', 534],
        ['32:7937', 320],
        ['32:7983', 340],
        ['32:8010', 508],
        ['32:8107', 328],
        ['32:8122', 186],
        ['32:8137', 136],
      ]
      for (const [id, height] of heights)
        assert(
          Math.abs(layout[id].height - height) <= 2,
          `Mobile Figma frame ${id}: ${JSON.stringify(layout[id])}`,
        )
      const open = mobile.page.getByRole('button', {
        name: 'Open menu',
        exact: true,
      })
      await open.focus()
      await mobile.page.keyboard.press('Enter')
      await expect(
        mobile.page.getByRole('dialog', { name: 'Menu' }),
      ).toBeVisible()
      await expect(open).toHaveAttribute('aria-expanded', 'true')
      assert.equal(new URL(mobile.page.url()).searchParams.get('menu'), 'open')
      await inspect(mobile.page, 'landing-menu')
      await mobile.page.keyboard.press('Escape')
      await expect(mobile.page.getByRole('dialog')).toBeHidden()
      await expect(open).toBeFocused()
      assert(!new URL(mobile.page.url()).searchParams.has('menu'))
      const faq = mobile.page.locator('[data-sd=landing-faq-1]')
      await faq.locator('summary').focus()
      await mobile.page.keyboard.press('Enter')
      await expect(faq).toHaveAttribute('open', '')
      await inspect(mobile.page, 'landing-faq')
    } else {
      await mobile.page.evaluate(() => document.fonts.ready)
      assert(
        await mobile.page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `Responsive overflow ${width}`,
      )
      assert.deepEqual(
        (await new AxeBuilder({ page: mobile.page }).analyze()).violations.map(
          (v) => v.id,
        ),
        [],
        `Responsive axe ${width}`,
      )
      await mobile.page.screenshot({
        path: path.join(output, `landing-${width}.png`),
        fullPage: true,
      })
    }
    await mobile.context.close()
  }
  const docs = await pageAt({ width: 390, height: 844 })
  await docs.page.goto(landing + 'docs/#browser')
  await expect(
    docs.page.getByRole('heading', { name: 'Install in this browser' }),
  ).toBeVisible()
  assert(
    await docs.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Docs mobile overflow',
  )
  assert.deepEqual(
    (await new AxeBuilder({ page: docs.page }).analyze()).violations.map(
      (v) => v.id,
    ),
    [],
    'Docs axe',
  )
  await docs.context.close()
  const staticPage = await pageAt({ width: 390, height: 844 }, false)
  await staticPage.page.goto(entry)
  await staticPage.page.waitForURL(entry)
  await expect(staticPage.page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(
    staticPage.page.getByText('Yes. Install the extension', { exact: false }),
  ).toBeVisible()
  await staticPage.context.close()
}

/* global console, process, document, getComputedStyle, innerWidth */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const output = path.join(root, 'test-results/website')
await mkdir(output, { recursive: true })
// Match the real Pages source: repository root mounted at /stepdoc/, not site/ at /.
const prefix = '/stepdoc/'
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.woff2': 'font/woff2',
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/stepdoc') {
      res.writeHead(308, { location: prefix }).end()
      return
    }
    if (!url.pathname.startsWith(prefix)) throw new Error('Outside project')
    const file = path.resolve(
      root,
      decodeURIComponent(url.pathname.slice(prefix.length)) || '.',
    )
    if (
      file !== path.resolve(root) &&
      !file.startsWith(`${path.resolve(root)}${path.sep}`)
    )
      throw new Error('Outside root')
    const info = await stat(file)
    if (info.isDirectory() && !url.pathname.endsWith('/')) {
      res.writeHead(308, { location: `${url.pathname}/${url.search}` }).end()
      return
    }
    const target = info.isDirectory() ? path.join(file, 'index.html') : file
    res.writeHead(200, {
      'content-type': types[path.extname(target)] ?? 'application/octet-stream',
    })
    res.end(await readFile(target))
  } catch {
    res.writeHead(404).end('Not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const entry =
  process.env.STEPDOC_SITE_URL ??
  `http://127.0.0.1:${server.address().port}${prefix}`
const origin = new URL(entry).origin
const landing = `${entry}site/`
const errors = []
let browser
try {
  browser = await chromium.launch()
  async function pageAt(viewport, javaScriptEnabled = true) {
    const context = await browser.newContext({
      viewport,
      reducedMotion: 'reduce',
      javaScriptEnabled,
    })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('Console error')
    })
    page.on('pageerror', () => errors.push('Page runtime error'))
    page.on('requestfailed', (request) =>
      errors.push(`Resource failed: ${new URL(request.url()).pathname}`),
    )
    page.on('response', (response) => {
      if (response.status() >= 400)
        errors.push(
          `HTTP ${response.status()}: ${new URL(response.url()).pathname}`,
        )
    })
    page.on('request', (request) => {
      if (
        !request.url().startsWith(origin) &&
        !request.url().startsWith('data:')
      )
        errors.push('Nonlocal request')
    })
    return { context, page }
  }
  const desktop = await pageAt({ width: 1440, height: 1000 })
  await desktop.page.goto(entry)
  await desktop.page.waitForURL(landing)
  const hero = desktop.page.getByRole('heading', {
    name: 'Click record. Do the task. Get the guide.',
  })
  await expect(hero).toBeVisible()
  await desktop.page.evaluate(() => document.fonts.ready)
  assert.equal(
    await desktop.page
      .locator('.hero')
      .evaluate((element) => getComputedStyle(element).display),
    'grid',
    'Landing stylesheet loaded under the project prefix',
  )
  assert(
    await desktop.page.evaluate(
      () =>
        document.fonts.check('16px Geist') &&
        document.fonts.check('16px "Geist Mono"'),
    ),
    'Both local fonts load',
  )
  for (const resource of [
    'styles.css',
    'main.js',
    'favicon.svg',
    'og.svg',
    'fonts/GeistSans.woff2',
    'fonts/GeistMono.woff2',
    'fonts/OFL.txt',
    'llms.txt',
  ]) {
    const response = await desktop.page.request.get(
      new URL(resource, landing).href,
    )
    assert.equal(response.status(), 200, `Project resource ${resource}`)
  }
  const links = await desktop.page
    .locator('a[href]')
    .evaluateAll((links) => links.map((link) => link.href))
  for (const link of new Set(links.filter((link) => link.startsWith(origin)))) {
    const url = new URL(link)
    assert(
      url.pathname.startsWith(prefix),
      'Internal links remain in the Pages project',
    )
    if (url.hash && url.pathname === new URL(landing).pathname)
      assert(
        await desktop.page.locator(`[id="${url.hash.slice(1)}"]`).count(),
        `Anchor ${url.hash}`,
      )
    assert.equal(
      (await desktop.page.request.get(url.href)).status(),
      200,
      `Internal link ${url.pathname}`,
    )
  }
  await desktop.page.screenshot({
    path: path.join(output, 'home.png'),
    fullPage: true,
  })
  await desktop.page.getByRole('button', { name: 'Start simulation' }).click()
  await expect(
    desktop.page.locator('.captured-step', {
      hasText: 'Fill in the “Administrator email” field',
    }),
  ).toBeVisible()
  await desktop.page
    .getByRole('button', { name: 'Save preferences', exact: true })
    .click()
  await expect(
    desktop.page.locator('.captured-step', {
      hasText: 'Click “Save preferences”',
    }),
  ).toBeVisible()
  await desktop.page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(desktop.page.locator('#step-count')).toHaveText('0 steps')
  await desktop.page
    .getByRole('link', { name: 'Open a real HTML export', exact: true })
    .click()
  await desktop.page.waitForURL(`${landing}demo/`)
  await expect(
    desktop.page.getByRole('heading', {
      name: 'Share an internal guide without exposing your workspace',
    }),
  ).toBeVisible()
  await expect(
    desktop.page.getByText('This guide was generated by StepDoc.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(desktop.page.locator('meta[name="generator"]')).toHaveAttribute(
    'content',
    'StepDoc HTML export',
  )
  await expect(desktop.page.locator('img')).toHaveCount(5)
  assert(
    await desktop.page
      .locator('img')
      .evaluateAll((images) =>
        images.every((image) => image.complete && image.naturalWidth > 0),
      ),
    'All five embedded demo images load',
  )
  await desktop.page.screenshot({
    path: path.join(output, 'exported-guide.png'),
    fullPage: true,
  })
  await desktop.context.close()
  for (const width of [390, 320]) {
    const mobile = await pageAt({ width, height: 844 })
    await mobile.page.goto(entry)
    await mobile.page.waitForURL(landing)
    await expect(
      mobile.page.getByRole('heading', {
        name: 'Click record. Do the task. Get the guide.',
      }),
    ).toBeVisible()
    await mobile.page.screenshot({
      path: path.join(output, `mobile-${width}.png`),
    })
    const overflow = await mobile.page.evaluate(() =>
      [...document.querySelectorAll('body *')]
        .map((element) => ({
          tag: element.tagName,
          class: element.className,
          right: element.getBoundingClientRect().right,
          width: element.getBoundingClientRect().width,
        }))
        .filter((element) => element.right > innerWidth + 1)
        .slice(0, 12),
    )
    assert(
      await mobile.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Mobile overflow at ${width}px: ${JSON.stringify(overflow)}`,
    )
    await mobile.context.close()
  }
  const staticPage = await pageAt({ width: 1440, height: 1000 }, false)
  await staticPage.page.goto(entry)
  await staticPage.page.waitForURL(landing)
  await expect(
    staticPage.page.getByRole('heading', {
      name: 'Click record. Do the task. Get the guide.',
    }),
  ).toBeVisible()
  await staticPage.context.close()
  assert.deepEqual(errors, [])
  console.log(
    'Pages browser verification passed: real /stepdoc/ root entry, project-relative CSS/JS/icons/fonts/links, simulation/reset, five-image export, 390/320px layout, readable without JavaScript and zero failed or external requests.',
  )
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}

/* global console, process */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { chromium } from '@playwright/test'
import { verifyLanding } from './verify-landing.mjs'
import { verifyLighthouse } from './verify-lighthouse.mjs'

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
  '.png': 'image/png',
  '.json': 'application/json',
  '.md': 'text/plain',
  '.ts': 'text/plain',
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
    const contents = await readFile(target)
    // Pages compresses text resources in transit; mirror that local serving behavior.
    const compressed =
      /gzip/.test(req.headers['accept-encoding'] ?? '') &&
      /\.(html|css|js|svg|txt|json|md|ts)$/.test(target)
    const body = compressed ? gzipSync(contents) : contents
    res.writeHead(200, {
      'content-type': types[path.extname(target)] ?? 'application/octet-stream',
      'content-length': body.length,
      ...(compressed
        ? { 'content-encoding': 'gzip', vary: 'Accept-Encoding' }
        : {}),
    })
    res.end(body)
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
  const lighthouseMode = process.argv.includes('--lighthouse')
  if (!lighthouseMode) browser = await chromium.launch()
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
  if (lighthouseMode) {
    await verifyLighthouse({ entry, output, chrome: chromium.executablePath() })
  } else await verifyLanding({ pageAt, landing, entry, origin, root, output })
  assert.deepEqual(errors, [])
  console.log(
    lighthouseMode
      ? 'Local Lighthouse gate passed for mobile and desktop.'
      : 'Pages browser verification passed: Figma L01/L02 geometry/assets, desktop/mobile aria and axe, native menu/FAQ, real guide downloads, docs, project-root navigation and zero failed/external requests.',
  )
} finally {
  await browser?.close()
  await new Promise((resolve) => server.close(resolve))
}

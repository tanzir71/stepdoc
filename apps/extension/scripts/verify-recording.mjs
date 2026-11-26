import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { extensionWorker } from './extension-worker.mjs'

let uploads = 0
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/')) uploads++
  if (req.url === '/fixture.css') {
    res.writeHead(200, { 'content-type': 'text/css' })
    res.end(
      'body{margin:0;background:rgb(245,246,247);color:black;font:16px Arial}header{padding:110px 24px 0}h1{font-size:20px}nav,main,footer{padding:12px 24px}button,input{font:inherit}main button{margin:10px}footer{margin-top:300px}',
    )
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html',
    'content-security-policy':
      "default-src 'self'; style-src 'self'; img-src 'self'; font-src 'none'",
  })
  res.end(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local recording fixture</title><link rel="stylesheet" href="/fixture.css"><link rel="icon" href="/fixture.css"></head><body><header><h1>Local recording workflow</h1></header><nav aria-label="Fixture"><a href="#main">Workflow</a></nav><main id="main"><button id="one">Open settings</button><button id="two">Apply settings</button><button id="three">Confirm settings</button><label>Password<input type="password" id="private"></label></main><footer>Local fixture</footer></body></html>',
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const screens = new URL(
  update ? '../../../docs/v2/screens/' : '../../../test-results/screens/',
  import.meta.url,
)
const snapshots = new URL('../tests/recording/', import.meta.url)
await mkdir(screens, { recursive: true })
await mkdir(snapshots, { recursive: true })
let context
try {
  const dir = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url))
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: null,
    args: [
      '--disable-gpu',
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
    ],
  })
  const worker = await extensionWorker(context)
  const workerUrl = new URL(worker.url()),
    origin = `${workerUrl.protocol}//${workerUrl.host}`
  const failures = []
  context.on('page', (page) => {
    page.on('pageerror', () => failures.push('Page runtime error'))
    page.on('requestfailed', (request) => {
      if (request.url().startsWith(origin))
        failures.push('Extension resource failed')
    })
    page.on('request', (request) => {
      if (
        ![base, origin, 'data:', 'blob:'].some((prefix) =>
          request.url().startsWith(prefix),
        )
      )
        failures.push('Nonlocal request')
    })
  })
  const page = await context.newPage()
  await page.goto(`${base}/workflow`)
  const tab = await worker.evaluate(
    async (base) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(base)),
    base,
  )
  const session = await context.newCDPSession(page)
  async function selectFixture() {
    await worker.evaluate(async ({ id, windowId }) => {
      await chrome.windows.update(windowId, { focused: true })
      await chrome.tabs.update(id, { active: true })
    }, tab)
    await page.bringToFront()
    await expect
      .poll(() =>
        worker.evaluate(
          async (id) => (await chrome.tabs.get(id)).active,
          tab.id,
        ),
      )
      .toBe(true)
  }
  async function sizeWindow(width, height) {
    await page.bringToFront()
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      )
      const bounds = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        outerWidth,
        outerHeight,
      }))
      if (bounds.width === width && bounds.height === height) return
      const { windowId } = await session.send('Browser.getWindowForTarget')
      await session.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          width: bounds.outerWidth + width - bounds.width,
          height: bounds.outerHeight + height - bounds.height,
          left: 0,
          top: 0,
        },
      })
      try {
        await page.waitForFunction(
          ({ width, height }) => innerWidth === width && innerHeight === height,
          { width, height },
          { polling: 50, timeout: 1_000 },
        )
        return
      } catch (error) {
        if (attempt === 2) throw error
      }
    }
  }
  await sizeWindow(1040, 856)
  const panel = await context.newPage()
  await panel.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('root').style.width = '400px'
    }),
  )
  await panel.goto(`${origin}/sidepanel.html`)
  const state = () => worker.evaluate(() => chrome.storage.local.get(null))
  const phase = (value) =>
    expect
      .poll(
        async () => {
          const value = await state()
          return value.captureError ?? value.captureReview?.phase
        },
        {
          timeout: 20_000,
        },
      )
      .toBe(value)
  const steps = (count) =>
    expect
      .poll(
        async () => {
          const value = await state()
          return value.captureError ?? value.steps?.length
        },
        { timeout: 20_000 },
      )
      .toBe(count)
  const pill = page.getByRole('complementary', {
    name: 'Recording controls',
    exact: true,
  })
  const time = page.getByRole('timer', { name: 'Active recording time' })
  async function inspect(name, locator = pill) {
    const violations = (await new AxeBuilder({ page }).analyze()).violations
    assert.deepEqual(
      violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
      [],
      `Axe ${name}`,
    )
    const aria = `${await locator.ariaSnapshot()}\n`,
      file = new URL(`${name}.aria.txt`, snapshots)
    if (update) await writeFile(file, aria)
    else
      assert.equal(
        aria,
        (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'),
        `Aria ${name}`,
      )
  }
  await page.bringToFront()
  await page.keyboard.press('Alt+Shift+s')
  await phase('recording')
  await expect(pill.getByRole('status')).toHaveText('Recording · 0 steps')
  const first = await state(),
    clock = first.captureReview.clock
  assert.equal(clock.elapsedMs, 0)
  assert.equal(typeof clock.runningSince, 'number')
  const before = await time.textContent()
  await expect(time).not.toHaveText(before)
  assert.deepEqual(
    (await state()).captureReview.clock,
    clock,
    'Ticks never write per-second state',
  )
  // A page-dispatched click cannot control its recorder.
  await pill
    .locator('[data-sd="capture-pill-pause"]')
    .evaluate((button) => button.click())
  const tick = await time.textContent()
  await expect(time).not.toHaveText(tick)
  await phase('recording')
  const forged = await panel.evaluate(
    (sessionId) =>
      chrome.runtime.sendMessage({
        type: 'CAPTURE_PILL_CONTROL',
        sessionId,
        action: 'stop',
      }),
    first.captureSessionId,
  )
  assert.equal(
    forged.ok,
    false,
    'Another extension tab is not the capture page',
  )
  for (const [index, id] of ['one', 'two', 'three'].entries()) {
    await page.locator(`#${id}`).click()
    await steps(index + 1)
  }
  await expect(pill.getByRole('status')).toHaveText('Recording · 3 steps')
  await inspect('recording-pill')
  const box = await pill.boundingBox()
  assert.equal(box.height, 48)
  assert(Math.abs(box.x + box.width / 2 - 520) < 1)
  assert.equal(box.y, 16)
  const glyphs = await pill.locator('.sd-icon').evaluateAll((icons) =>
    icons.map((icon) => {
      const r = icon.getBoundingClientRect()
      return {
        name: icon.dataset.asset,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        color: getComputedStyle(icon).backgroundColor,
        image: getComputedStyle(icon).maskImage,
      }
    }),
  )
  assert.deepEqual(
    glyphs.map(({ name, width, height }) => ({ name, width, height })),
    [
      { name: 'pill-dot', width: 8, height: 8 },
      { name: 'pill-pause', width: 16, height: 16 },
      { name: 'pill-stop', width: 16, height: 16 },
    ],
  )
  assert(
    glyphs.every((glyph) => glyph.image.startsWith(`url("${origin}/assets/`)),
  )
  const capture = await session.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { ...box, scale: 1 },
  })
  const png = Buffer.from(capture.data, 'base64')
  assert.equal(png.readUInt32BE(20), 48)
  await writeFile(new URL('m11-recording-pill.png', screens), png)
  const saved = await state()
  const pixelEvidence = await panel.evaluate(
    async ({ png, glyphs, box, image }) => {
      const decode = async (data) => {
        const bitmap = await createImageBitmap(
          new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], {
            type: 'image/png',
          }),
        )
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        return ctx
      }
      const control = await decode(png)
      const painted = glyphs.map((glyph) => {
        const color = glyph.color
          .match(/[\d.]+/g)
          .slice(0, 3)
          .map(Number)
        const data = control.getImageData(
          Math.round(glyph.x - box.x),
          Math.round(glyph.y - box.y),
          glyph.width,
          glyph.height,
        ).data
        let count = 0
        for (let i = 0; i < data.length; i += 4)
          if (color.every((c, n) => Math.abs(c - data[i + n]) < 25)) count++
        return { name: glyph.name, count }
      })
      const recorded = await decode(image.slice(image.indexOf(',') + 1)),
        ratio = recorded.canvas.width / 1040
      return {
        painted,
        stored: [
          ...recorded.getImageData(
            Math.round((box.x + 20) * ratio),
            Math.round((box.y + 20) * ratio),
            1,
            1,
          ).data,
        ],
      }
    },
    { png: capture.data, glyphs, box, image: saved.steps.at(-1).screenshot },
  )
  assert(
    pixelEvidence.painted.every((glyph) => glyph.count > 3),
    'Original glyphs paint under strict CSP',
  )
  assert(
    pixelEvidence.stored.every(
      (value, index) => Math.abs(value - [245, 246, 247, 255][index]) <= 4,
    ),
    'Recording pill is excluded from stored pixels',
  )
  // Freeze only this private renderer's wall clock for the reference timer.
  await panel.evaluate((time) => {
    globalThis.recordingRealNow = Date.now
    Date.now = () => time
  }, clock.runningSince + 41_000)
  await expect(
    panel.getByRole('timer', { name: 'Active recording time' }),
  ).toHaveText('00:41')
  const headerDot = await panel.locator('[data-asset="pill-dot"]').boundingBox()
  assert.deepEqual([headerDot.width, headerDot.height], [8, 8])
  const headerTime = await panel
    .getByRole('timer', { name: 'Active recording time' })
    .boundingBox()
  assert(headerTime.x >= 0 && headerTime.x + headerTime.width <= 400)
  await panel.bringToFront()
  const panelSession = await context.newCDPSession(panel)
  const timerCapture = await panelSession.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 400, height: 52, scale: 1 },
  })
  await writeFile(
    new URL('m11-recording-timer.png', screens),
    Buffer.from(timerCapture.data, 'base64'),
  )
  await panelSession.detach()
  await panel.evaluate(() => {
    Date.now = globalThis.recordingRealNow
    delete globalThis.recordingRealNow
  })
  await selectFixture()
  await pill
    .getByRole('button', { name: 'Pause recording', exact: true })
    .focus()
  await page.keyboard.press('Enter')
  await phase('paused')
  await expect(pill.getByRole('status')).toHaveText('Paused · 3 steps')
  const paused = (await state()).captureReview.clock,
    frozen = await time.textContent()
  assert.equal(paused.runningSince, null)
  await page.waitForTimeout(1_200)
  await expect(time).toHaveText(frozen)
  assert.deepEqual((await state()).captureReview.clock, paused)
  await inspect('recording-paused')
  await page.reload()
  await expect(
    pill.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeVisible()
  assert.deepEqual((await state()).captureReview.clock, paused)
  await selectFixture()
  await pill.getByRole('button', { name: 'Resume', exact: true }).click()
  await phase('recording')
  const resumed = (await state()).captureReview.clock
  assert.equal(resumed.elapsedMs, paused.elapsedMs)
  assert(resumed.runningSince > clock.runningSince)
  await page.locator('#one').click()
  await steps(4)
  assert.equal(
    (await state()).capturedSteps.length,
    4,
    'Pill controls never create steps',
  )
  // Failed review launch retains the completed draft and offers a native retry.
  await worker.evaluate(() => {
    const original = chrome.tabs.create.bind(chrome.tabs)
    globalThis.restoreRecordingReview = () => {
      chrome.tabs.create = original
    }
    chrome.tabs.create = async (options) => {
      if (options.url?.includes('sidepanel.html'))
        throw new Error('PRIVATE_OPEN_FAILURE')
      return original(options)
    }
  })
  await pill
    .getByRole('button', { name: 'Stop and review', exact: true })
    .click()
  await phase('review')
  await expect(pill.getByRole('status')).toHaveText(
    'Capture retained. Retry opening review.',
  )
  assert.equal((await state()).captureReview.clock.runningSince, null)
  assert.equal((await state()).steps.length, 4)
  await inspect('recording-review-error')
  await worker.evaluate(() => {
    globalThis.restoreRecordingReview()
    delete globalThis.restoreRecordingReview
  })
  const opened = context.waitForEvent('page')
  await pill.getByRole('button', { name: 'Open review', exact: true }).click()
  const review = await opened
  await review.waitForURL(`${origin}/sidepanel.html?surface=tab&view=review`)
  await expect(review.locator('[data-sd="capture-title"]')).toBeVisible()
  await expect(pill).toBeHidden()
  assert.equal((await state()).steps.length, 4)
  const completed = await state()
  const discard = await review.evaluate(
    (sessionId) =>
      chrome.runtime.sendMessage({ type: 'DISCARD_CAPTURE', sessionId }),
    completed.captureSessionId,
  )
  assert.equal(discard.ok, true)
  await page.bringToFront()
  await page.keyboard.press('Alt+Shift+s')
  await phase('recording')
  const restarted = await state()
  assert.notEqual(restarted.captureSessionId, first.captureSessionId)
  assert.equal(restarted.captureReview.clock.elapsedMs, 0)
  await steps(0)
  await pill
    .getByRole('button', { name: 'Pause recording', exact: true })
    .click()
  await phase('paused')
  // Responsive emulation is isolated from native captureVisibleTab sizing.
  await page.setViewportSize({ width: 320, height: 740 })
  await inspect('recording-narrow')
  const narrow = await pill.boundingBox()
  assert(narrow.x >= 16 && narrow.x + narrow.width <= 304)
  await selectFixture()
  await pill.getByRole('button', { name: 'Resume', exact: true }).focus()
  await page.keyboard.press('Alt+Shift+s')
  await phase('review')
  const last = await state()
  await review.evaluate(
    (sessionId) =>
      chrome.runtime.sendMessage({ type: 'DISCARD_CAPTURE', sessionId }),
    last.captureSessionId,
  )
  const closing = await context.newPage()
  await closing.goto(`${base}/closure`)
  const closingTab = await worker.evaluate(
    async (base) =>
      (await chrome.tabs.query({})).find(
        (tab) => tab.url === `${base}/closure`,
      ),
    base,
  )
  await worker.evaluate(
    (id) => chrome.tabs.update(id, { active: true }),
    closingTab.id,
  )
  await closing.bringToFront()
  await closing.keyboard.press('Alt+Shift+s')
  await phase('recording')
  await closing.close()
  await expect
    .poll(async () => (await state()).captureReview?.phase)
    .toBe('review')
  const closed = await state()
  assert.equal(closed.captureReview.clock.runningSince, null)
  assert.match(closed.captureError, /selected tab changed/)
  assert.equal(uploads, 0)
  assert.deepEqual(failures, [])
  console.log(
    'Native recording controls verified: trusted page pause/resume/stop, live counts, persisted active-only timer, reload, keyboard/narrow aria/axe, strict-CSP original glyph pixels, no UI in captured pixels, forged-control rejection and retained review launch retry with no upload.',
  )
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}

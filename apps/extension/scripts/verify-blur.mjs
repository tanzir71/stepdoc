import { extensionWorker } from './extension-worker.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

let base,
  otherBase,
  uploads = 0
const screenDir = new URL(
  process.env.STEPDOC_UPDATE_SCREENS === '1'
    ? '../../../docs/v2/screens/'
    : '../../../test-results/screens/',
  import.meta.url,
)
await mkdir(screenDir, { recursive: true })
const css = `body{margin:0;background:rgb(245,246,247);font:16px Arial}header,nav,main,footer{padding:12px 20px}h1{font-size:20px;margin:0}p{margin:8px 0}.pii{font:24px monospace;background:repeating-linear-gradient(90deg,black 0,black 1px,white 1px,white 2px);color:rgb(80,80,80)}#manual,#keyboard,#late-mask,#uncached{display:block;width:220px;height:48px;margin:20px 0;background:repeating-linear-gradient(90deg,black 0,black 1px,white 1px,white 2px);color:rgb(80,80,80);border:0}#cross{position:absolute;left:500px;top:160px;width:400px;height:250px;border:4px solid black}#save{width:180px;height:40px}#child-manual{display:block;width:220px;height:50px;background:repeating-linear-gradient(90deg,black 0,black 1px,white 1px,white 2px);border:0}#clear-tile{position:absolute;left:800px;top:600px;width:80px;height:40px;background:rgb(30,180,140)}`
const handler = (req, res) => {
  if (req.url === '/fixture.css') {
    res.writeHead(200, { 'content-type': 'text/css' })
    res.end(css)
    return
  }
  if (req.url === '/fixture.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(
      `window.activations=0;for(const button of document.querySelectorAll('[data-activate]'))button.addEventListener('click',()=>window.activations++);`,
    )
    return
  }
  if (req.url === '/api/sessions') {
    uploads++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"id":"unused"}')
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'none'; img-src 'self' data:; frame-src http://127.0.0.1:*",
  })
  const child = req.url.startsWith('/child')
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local blur fixture</title><link rel="stylesheet" href="/fixture.css"><link rel="icon" href="data:,"></head><body><header><h1>Privacy fixture</h1></header><nav aria-label="Fixture"><a href="#main">Content</a></nav><main id="main">${child ? '<p class="pii">child@example.test</p><button id="child-manual" data-activate>Blur child element</button>' : `<p id="mail" class="pii">🧭 <span>person</span><b>@example</b><span>.test</span></p><label>Private input<input value="PRIVATE_TYPED_NEVER_READ"></label><button id="manual" data-activate>Blur this element</button><button id="keyboard" data-activate>Blur with keyboard</button><button id="save">Save fixture</button><button id="late-mask" data-activate>New blur after capture</button><button id="uncached" data-activate>New blur after retry</button><div id="clear-tile"></div><iframe id="cross" title="Cross-origin fixture" src="${otherBase}/child"></iframe>`}</main><footer>Local fixture</footer><script src="/fixture.js"></script></body></html>`,
  )
}
const servers = [createServer(handler), createServer(handler)]
await Promise.all(
  servers.map(
    (server) =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
  ),
)
base = `http://127.0.0.1:${servers[0].address().port}`
otherBase = `http://127.0.0.1:${servers[1].address().port}`
let context
try {
  const dir = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url))
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  })
  const worker = await extensionWorker(context)
  const url = new URL(worker.url()),
    origin = `${url.protocol}//${url.host}`
  const panel = await context.newPage()
  await panel.goto(`${origin}/sidepanel.html`)
  const page = await context.newPage(),
    failures = []
  page.on('pageerror', (error) => failures.push(error.message))
  page.on('request', (request) => {
    if (
      ![base, otherBase, origin, 'data:', 'blob:'].some((prefix) =>
        request.url().startsWith(prefix),
      )
    )
      failures.push('Non-local request')
  })
  await page.goto(`${base}/root`)
  const state = () =>
    worker.evaluate(() =>
      chrome.storage.local.get([
        'recording',
        'steps',
        'capturedSteps',
        'captureError',
        'captureBlurMode',
        'captureManualCount',
        'captureReview',
      ]),
    )
  const start = () =>
    panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }))
  assert.deepEqual(await start(), { ok: true })
  await page.locator('#save').click()
  await expect
    .poll(
      async () => {
        const value = await state()
        return value.captureError ?? value.steps.length
      },
      { timeout: 20_000 },
    )
    .toBe(1)
  assert(
    (await state()).capturedSteps[0].redactions.filter(
      (mask) => mask.kind === 'email',
    ).length >= 4,
  )
  assert(
    !(await state()).capturedSteps[0].redactions.some(
      (mask) => mask.source === 'manual',
    ),
  )
  await page.keyboard.press('Alt+b')
  await expect.poll(async () => (await state()).captureBlurMode).toBe(true)
  const controls = page.getByRole('complementary', {
    name: 'Capture privacy controls',
  })
  const screenshotControls = async (name) => {
    const original = await page.evaluate(() => document.body.style.visibility)
    await page.evaluate(() => {
      document.body.style.visibility = 'hidden'
    })
    try {
      await controls.screenshot({
        path: fileURLToPath(new URL(name, screenDir)),
      })
    } finally {
      await page.evaluate((visibility) => {
        document.body.style.visibility = visibility
      }, original)
    }
  }
  await expect(controls).toBeVisible()
  await expect(controls.getByRole('status')).toHaveText(
    'Choose an element to blur · 0 added. Click, or focus and press Enter. Esc to finish.',
  )
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.fonts].some(
          (font) =>
            font.family === 'StepDoc Capture' && font.status === 'loaded',
        ),
      ),
    )
    .toBe(true)
  const snapshot = await controls.ariaSnapshot()
  assert.equal(
    snapshot,
    (
      await readFile(
        new URL(
          '../../../docs/v2/screens/m11-blur-mode.aria.yml',
          import.meta.url,
        ),
        'utf8',
      )
    )
      .replaceAll('\r\n', '\n')
      .trim(),
  )
  assert.deepEqual(
    (
      await new AxeBuilder({ page })
        .include('stepdoc-privacy-controls')
        .analyze()
    ).violations,
    [],
  )
  const geometry = await controls.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    top: element.getBoundingClientRect().top,
    radius: getComputedStyle(element).borderRadius,
    shadow: getComputedStyle(element).boxShadow,
    family: getComputedStyle(element).fontFamily,
    bg: getComputedStyle(element).backgroundColor,
  }))
  assert.equal(geometry.height, 48)
  assert.equal(geometry.top, 16)
  assert.equal(geometry.radius, '999px')
  assert.notEqual(geometry.shadow, 'none')
  assert(geometry.family.includes('StepDoc Capture'))
  assert.equal(geometry.bg, 'rgb(17, 17, 19)')
  await screenshotControls('m11-blur-mode.png')
  await page.setViewportSize({ width: 390, height: 844 })
  assert.deepEqual(
    (
      await new AxeBuilder({ page })
        .include('stepdoc-privacy-controls')
        .analyze()
    ).violations,
    [],
  )
  const narrow = await controls.boundingBox()
  assert(
    Math.abs(narrow.x - 16) <= 0.5 &&
      Math.abs(narrow.x + narrow.width - 374) <= 0.5,
    'Narrow picker overflows its page',
  )
  await screenshotControls('m11-blur-mode-narrow.png')
  await page.setViewportSize({ width: 1440, height: 900 })
  await controls.getByRole('button', { name: 'Done' }).focus()
  await page.keyboard.press('Escape')
  await expect(controls).toHaveCount(0)
  await panel
    .getByRole('button', { name: 'Choose element to blur (Alt+B)' })
    .click()
  await page.bringToFront()
  await expect(controls).toBeVisible()
  await page.locator('#save').focus()
  await page.locator('#manual').click()
  await expect.poll(async () => (await state()).captureManualCount).toBe(1)
  await expect(controls.getByRole('status')).toHaveText(
    'Choose an element to blur · 1 added. Click, or focus and press Enter. Esc to finish.',
  )
  assert.equal(
    await page.evaluate(() => window.activations),
    0,
    'Blur click activated the page',
  )
  assert.equal(
    (await state()).steps.length,
    1,
    'Blur click was recorded as a guide action',
  )
  // Selection suppresses focus/click. Save was the previous focus; Shift+Tab
  // focuses the preceding fixture button, which Enter selects without activation.
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('#keyboard')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => {
      const value = await state()
      return value.captureError ?? value.captureManualCount
    })
    .toBe(2)
  assert.equal(await page.evaluate(() => window.activations), 0)
  // A fresh frame inherits the active picker through CONTENT_STATE, rather than
  // relying on a broadcast that happened before its content script existed.
  await page.evaluate((url) => {
    const frame = document.createElement('iframe')
    frame.id = 'new-cross'
    frame.title = 'New cross-origin fixture'
    frame.src = url
    frame.style.cssText =
      'position:absolute;left:1000px;top:160px;width:300px;height:250px;border:4px solid black'
    document.body.append(frame)
  }, `${otherBase}/child`)
  await page.frameLocator('#new-cross').locator('#child-manual').click()
  await expect.poll(async () => (await state()).captureManualCount).toBe(3)
  assert.equal(
    await page
      .frames()
      .find((frame) => frame.name() === 'new-cross')
      .evaluate(() => window.activations),
    0,
  )
  await page.evaluate(() =>
    history.pushState(null, '', '/picker?PRIVATE_QUERY#PRIVATE_FRAGMENT'),
  )
  await expect
    .poll(
      async () => {
        const value = await state()
        return (
          value.captureError ??
          value.capturedSteps.some(
            (step) =>
              step.action === 'navigate' && step.url.endsWith('/picker'),
          )
        )
      },
      { timeout: 20_000 },
    )
    .toBe(true)
  await expect(controls).toBeVisible()
  let saved = await state()
  const current = saved.capturedSteps.at(-1)
  assert(
    current.redactions.some(
      (mask) => mask.source === 'manual' && mask.rule === 'click-to-blur',
    ),
  )
  const rootBox = await page.locator('#manual').boundingBox(),
    childBox = await page
      .frameLocator('#new-cross')
      .locator('#child-manual')
      .boundingBox()
  for (const box of [rootBox, childBox])
    assert(
      current.redactions.some(
        (mask) =>
          mask.source === 'manual' &&
          mask.rect.x <= box.x &&
          mask.rect.y <= box.y &&
          mask.rect.x + mask.rect.width >= box.x + box.width &&
          mask.rect.y + mask.rect.height >= box.y + box.height,
      ),
      'Stored manual mask missed native element bounds',
    )
  const emailBox = await page.locator('#mail span').first().boundingBox()
  const pixels = await page.evaluate(
    async ({ dataUrl, rootBox, childBox, emailBox }) => {
      const [header, encoded] = dataUrl.split(',')
      const bytes = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0),
      )
      const image = await createImageBitmap(
          new Blob([bytes], { type: header.slice(5, header.indexOf(';')) }),
        ),
        canvas = new OffscreenCanvas(image.width, image.height),
        ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      image.close()
      return {
        toolbar: [...ctx.getImageData(720, 30, 1, 1).data],
        clear: [...ctx.getImageData(820, 620, 1, 1).data],
        transitions: [rootBox, childBox, emailBox].map((box) => {
          const pixels = ctx.getImageData(
            Math.ceil(box.x) + 8,
            Math.ceil(box.y) + 2,
            60,
            1,
          ).data
          let count = 0
          for (let i = 4; i < pixels.length; i += 4)
            if (Math.abs(pixels[i] - pixels[i - 4]) > 60) count++
          return count
        }),
      }
    },
    { dataUrl: saved.steps.at(-1).screenshot, rootBox, childBox, emailBox },
  )
  assert(
    pixels.toolbar.every(
      (channel, index) => Math.abs(channel - [245, 246, 247, 255][index]) <= 4,
    ),
    'Picker UI appeared in stored pixels',
  )
  assert(
    pixels.clear.every(
      (channel, index) => Math.abs(channel - [30, 180, 140, 255][index]) <= 4,
    ),
    'Non-sensitive page region was masked',
  )
  assert(
    pixels.transitions.every((count) => count < 15),
    'Manual or detected text pixels were not processed',
  )
  assert(!JSON.stringify(saved).includes('PRIVATE_'))
  await controls.getByRole('button', { name: 'Done' }).click()
  await expect(controls).toHaveCount(0)
  await expect.poll(async () => (await state()).captureBlurMode).toBe(false)
  const count = saved.steps.length
  await page.locator('#save').click()
  await expect.poll(async () => (await state()).steps.length).toBe(count + 1)
  // Pause the real camera, add a mask, then release. The invalidated capture
  // must retry in order with fresh masks, rather than storing its old frame.
  saved = await state()
  await worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    globalThis.restoreBlurCamera = () => {
      chrome.tabs.captureVisibleTab = original
    }
    globalThis.blurCameraCalls = 0
    chrome.tabs.captureVisibleTab = async (...args) => {
      const image = await original(...args)
      if (++globalThis.blurCameraCalls === 1)
        await new Promise((resolve) => {
          globalThis.releaseBlurCamera = resolve
        })
      return image
    }
  })
  await page.locator('#save').click()
  await expect
    .poll(() => worker.evaluate(() => typeof globalThis.releaseBlurCamera))
    .toBe('function')
  await worker.evaluate(() => {
    const original = chrome.storage.local.set.bind(chrome.storage.local)
    globalThis.restoreBlurMode = () => {
      chrome.storage.local.set = original
    }
    chrome.storage.local.set = async (values) => {
      if (values.captureBlurMode === true)
        await new Promise((resolve) => {
          globalThis.releaseBlurMode = resolve
        })
      return original(values)
    }
  })
  await page.keyboard.press('Alt+b')
  await expect
    .poll(() => worker.evaluate(() => typeof globalThis.releaseBlurMode))
    .toBe('function')
  assert.equal((await state()).captureBlurMode, false)
  await page.locator('#late-mask').click()
  await expect.poll(async () => (await state()).captureManualCount).toBe(4)
  await worker.evaluate(() => {
    globalThis.releaseBlurMode()
    globalThis.restoreBlurMode()
  })
  await expect.poll(async () => (await state()).captureBlurMode).toBe(true)
  await page
    .locator('stepdoc-privacy-controls [role="status"]')
    .waitFor({ state: 'attached' })
  await expect(
    page.locator('stepdoc-privacy-controls [role="status"]'),
  ).toContainText('4 added.')
  await worker.evaluate(() => globalThis.releaseBlurCamera())
  await expect
    .poll(
      async () => {
        const value = await state()
        return value.captureError ?? value.steps.length
      },
      { timeout: 20_000 },
    )
    .toBe(saved.steps.length + 1)
  assert(
    await worker.evaluate(() => globalThis.blurCameraCalls >= 2),
    'Privacy invalidation did not retry the camera',
  )
  const late = await page.locator('#late-mask').boundingBox()
  assert(
    (await state()).capturedSteps
      .at(-1)
      .redactions.some(
        (mask) =>
          mask.source === 'manual' &&
          mask.rect.x <= late.x &&
          mask.rect.y <= late.y &&
          mask.rect.x + mask.rect.width >= late.x + late.width &&
          mask.rect.y + mask.rect.height >= late.y + late.height,
      ),
    'Retry omitted the newly selected mask',
  )
  await worker.evaluate(() => globalThis.restoreBlurCamera())
  // New manual choices invalidate the primed/processed cache. A subsequent
  // camera failure must block upload, never reuse an image missing that choice.
  await expect(controls).toBeVisible()
  await page.locator('#uncached').click()
  await expect.poll(async () => (await state()).captureManualCount).toBe(5)
  await page.keyboard.press('Escape')
  await expect(controls).toHaveCount(0)
  saved = await state()
  await worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    globalThis.restoreBlurCamera = () => {
      chrome.tabs.captureVisibleTab = original
    }
    chrome.tabs.captureVisibleTab = async () => {
      globalThis.blurCameraFailed = true
      throw new Error('PRIVATE_CAMERA_FAILURE')
    }
  })
  await page.locator('#save').click()
  await expect
    .poll(async () => (await state()).captureError)
    .toMatch(/metadata or privacy masks/)
  assert.equal(
    (await state()).captureReview.clock.runningSince,
    null,
    'A failed capture freezes active time',
  )
  assert(
    await worker.evaluate(() => globalThis.blurCameraFailed),
    'Camera failure injection did not run',
  )
  assert.equal(
    (await state()).steps.length,
    saved.steps.length,
    'Stale cache reused after a new manual choice',
  )
  assert.equal(
    (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })))
      .ok,
    false,
  )
  assert.equal(uploads, 0)
  await worker.evaluate(() => globalThis.restoreBlurCamera())
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' }))
  assert.deepEqual(await start(), { ok: true })
  await page.locator('#save').click()
  await expect.poll(async () => (await state()).steps.length).toBe(1)
  assert(
    !(await state()).capturedSteps[0].redactions.some(
      (mask) => mask.source === 'manual',
    ),
    'Manual selections survived the session boundary',
  )
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' }))
  await page.evaluate(() => {
    const paragraph = document.createElement('p')
    paragraph.append(document.createTextNode('x'.repeat(250_001)))
    document.querySelector('main').prepend(paragraph)
  })
  assert.equal(
    (await start()).ok,
    false,
    'A visible-text limit did not fail the real collector',
  )
  assert.match((await state()).captureError, /metadata or privacy masks/)
  assert.equal(
    (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })))
      .ok,
    false,
  )
  assert.equal(uploads, 0)
  assert.deepEqual(failures, [])
  console.log(
    'Native Smart Blur verified: visible text before storage; Alt+B pointer/keyboard/cross-frame picking; native page actions suppressed; private accessible token/Geist toolbar under strict CSP; UI excluded from pixels; manual cache invalidation; session reset and real collector-limit upload blocking.',
  )
} finally {
  await context?.close()
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  )
}

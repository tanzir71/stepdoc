import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

let base,
  remoteBase,
  apiCalls = 0
const handler = (req, res) => {
  if (req.url.startsWith('/api/')) apiCalls++
  if (req.url === '/fixture.css') {
    res.writeHead(200, { 'content-type': 'text/css' })
    res.end(
      'body{margin:0;background:white;color:black;font:16px Arial}header,nav,main,footer{padding:12px}button,input,select{font:inherit}#change{position:absolute;left:887px;top:162px;width:107px;height:31px;font-size:12px;background:#111827;color:white;border:0;border-radius:6px}#fields{margin-top:190px}#frame{width:400px;height:160px;border:4px solid black}#remote-host{display:block;margin-left:100px}h1{font-size:20px}label{display:block;margin:8px 0}',
    )
    return
  }
  if (req.url === '/fixture.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(
      `if(document.querySelector('#host')){document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<button id="shadow">Shadow action</button>';const root=document.querySelector('#remote-host').attachShadow({mode:'open'});root.innerHTML='<iframe id="remote" title="Remote frame" src="${remoteBase}/frame"></iframe>';const sheet=new CSSStyleSheet();sheet.replaceSync('iframe{width:400px;height:160px;border:4px solid black}');root.adoptedStyleSheets=[sheet]}`,
    )
    return
  }
  res.writeHead(200, {
    'content-type': 'text/html',
    'content-security-policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'none'; frame-src http://127.0.0.1:*",
  })
  const frame = req.url.startsWith('/frame')
  const area = !frame
    ? 'Main workflow'
    : req.headers.host === new URL(remoteBase).host
      ? 'Remote frame'
      : 'Local frame'
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local walkthrough fixture</title><link rel="stylesheet" href="/fixture.css"><link rel="icon" href="data:,"></head><body><header aria-label="${area} header"><h1>Local walkthrough</h1></header><nav aria-label="${area}"><a href="#main">Content</a></nav><main id="main" aria-label="${area}">${frame ? '<button id="frame-action">Frame action</button>' : `<button id="change">Change plan</button><section id="fields"><label>Password<input id="private" type="password"></label><label>Plan<select id="plan"><option>Basic</option><option>Team</option></select></label><label>Confirmation<input id="confirmation"></label></section><div id="host"></div><iframe id="frame" title="Local frame" src="/frame"></iframe><div id="remote-host"></div><button>Duplicate</button><button id="fallback">Duplicate</button><button id="unrelated">Unrelated</button>`}</main><footer aria-label="${area} footer">Local fixture</footer><script src="/fixture.js"></script></body></html>`,
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
remoteBase = `http://127.0.0.1:${servers[1].address().port}`
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const screens = new URL(
  update ? '../../../docs/v2/screens/' : '../../../test-results/screens/',
  import.meta.url,
)
const snapshots = new URL('../tests/guide/', import.meta.url)
await mkdir(screens, { recursive: true })
await mkdir(snapshots, { recursive: true })
let context
try {
  const dir = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url))
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [
      '--disable-gpu',
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
    ],
  })
  let [worker] = context.serviceWorkers()
  worker ??= await context.waitForEvent('serviceworker')
  const workerUrl = new URL(worker.url()),
    origin = `${workerUrl.protocol}//${workerUrl.host}`
  const errors = [],
    iconFailures = [],
    requests = []
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('requestfailed', (request) => {
      if (/\/assets\/(418d0|0e7f2)-.*\.svg/.test(request.url()))
        iconFailures.push('Walkthrough icon request failed')
    })
    page.on('request', (request) => {
      const url = request.url()
      if (
        url !== 'about:blank' &&
        ![base, remoteBase, origin, 'blob:', 'data:'].some((prefix) =>
          url.startsWith(prefix),
        )
      )
        requests.push('Nonlocal request')
    })
  })
  const panel = await context.newPage()
  await panel.goto(`${origin}/sidepanel.html`)
  // Host the unchanged private entrypoint at the side panel's real dimensions.
  // The parent can be captured without resizing a background portrait tab.
  await panel.evaluate((origin) => {
    document.getElementById('root').style.display = 'none'
    const header = document.createElement('header')
    header.setAttribute('aria-label', 'Control host header')
    const title = document.createElement('h1')
    title.textContent = 'Guide Me control host'
    title.className = 'sd-sr-only'
    header.append(title)
    const main = document.createElement('main')
    main.setAttribute('aria-label', 'Control host')
    const frame = document.createElement('iframe')
    frame.src = `${origin}/sidepanel.html`
    frame.title = 'Walkthrough panel'
    frame.dataset.testid = 'control-frame'
    frame.style.cssText = 'display:block;width:400px;height:856px;border:0'
    main.append(frame)
    document.body.append(header, main)
  }, origin)
  const controlFrame = panel.frameLocator('[data-testid="control-frame"]')
  const panelSession = await context.newCDPSession(panel)
  const app = await context.newPage()
  await app.goto(`${origin}/app.html`)
  const state = () =>
    worker.evaluate(() =>
      chrome.storage.local.get('guideMe').then((value) => value.guideMe),
    )
  const waitIndex = (index) =>
    expect
      .poll(
        async () => {
          const run = await state()
          return run?.phase === 'running' ? run.index : run?.phase
        },
        { timeout: 30_000 },
      )
      .toBe(index)
  const targetFound = () =>
    expect
      .poll(async () => (await state())?.target.reason, { timeout: 30_000 })
      .toBe('matched')
  const control = async (action) => {
    const hook = action === 'dismiss' || action === 'stop' ? 'close' : action
    await controlFrame
      .locator(`[data-sd="guide-me-${hook}"]`)
      .click({ noWaitAfter: action === 'dismiss' })
    // Closing the selected live tab can make Chromium speculate about a pending
    // navigation in the panel iframe. Verify the actual command result instead.
    if (action === 'dismiss') await expect.poll(state).toBeUndefined()
  }
  const at = '2026-11-26T00:00:00Z'
  const target = (name, locators) => ({
    role: 'button',
    name,
    ...(locators && { locators }),
  })
  const step = (id, action, title, details = {}) => ({
    id,
    index: 0,
    type: 'action',
    action,
    title,
    url: `${base}/workflow`,
    ...details,
  })
  const steps = [
    {
      id: 'start',
      type: 'navigate',
      action: 'navigate',
      title: 'Open the local workflow',
      url: `${base}/workflow`,
    },
    step('change', 'click', 'Click "Change plan"', {
      description: 'Opens the plan picker. Only owners see this button.',
      target: target('Change plan'),
    }),
    step('private', 'fill', 'Fill the Password field', {
      target: {
        role: 'textbox',
        name: 'Password',
        locators: [{ strategy: 'label', value: 'Password', exact: true }],
      },
      value: { kind: 'secret', variable: 'password' },
    }),
    step('plan', 'select', 'Select Team', {
      target: { role: 'combobox', name: 'Plan' },
      value: { kind: 'literal', literal: 'Team' },
    }),
    step('enter', 'press', 'Press Enter', {
      target: { role: 'textbox', name: 'Confirmation' },
      key: 'Enter',
    }),
    step('shadow', 'click', 'Click Shadow action', {
      target: { ...target('Shadow action'), shadowPath: ['#host'] },
    }),
    step('frame', 'click', 'Click the frame action', {
      url: `${base}/frame`,
      target: { ...target('Frame action'), frame: ['#frame'] },
    }),
    step('remote', 'click', 'Click the remote frame action', {
      url: `${remoteBase}/frame`,
      target: { ...target('Frame action'), frame: ['#remote-host #remote'] },
    }),
    step('fallback', 'click', 'Click the unique fallback', {
      target: target('Duplicate', [
        { strategy: 'css', value: '#fallback', exact: true },
      ]),
    }),
    { id: 'manual', type: 'manual', title: 'Confirm the final result' },
  ].map((value, index) => ({ ...value, index: index + 1 }))
  const guide = {
    schema: 'stepdoc/guide@1',
    id: 'native-walkthrough',
    title: 'Complete the local workflow',
    version: 1,
    createdAt: at,
    updatedAt: at,
    preconditions: [`Open ${base}/workflow`],
    variables: [{ name: 'password', kind: 'secret' }],
    steps,
  }
  async function importGuide(value) {
    await app.bringToFront()
    await app.goto(`${origin}/app.html`)
    await app.locator('[data-sd="library-import-file"]').setInputFiles({
      name: `${value.id}.json`,
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(value)),
    })
    await expect(
      app
        .locator('[data-sd="library-guide-open"]')
        .filter({ hasText: value.title }),
    ).toBeVisible()
    await app
      .locator('[data-sd="library-guide-open"]')
      .filter({ hasText: value.title })
      .click()
    await app.getByRole('link', { name: 'Edit guide', exact: true }).click()
    try {
      await expect(app.locator('[data-sd="guide-me"]')).toBeVisible()
    } catch (error) {
      console.log('Native editor diagnostic', {
        url: app.url(),
        headings: await app.getByRole('heading').allTextContents(),
        errors,
      })
      throw error
    }
  }
  async function start() {
    await app.bringToFront()
    const opened = context.waitForEvent('page')
    await app.locator('[data-sd="guide-me"]').click()
    const page = await opened
    await page.setViewportSize({ width: 1040, height: 856 })
    await page.waitForURL(`${base}/workflow`)
    await page.waitForLoadState()
    return page
  }
  async function checkAria(page, locator, name) {
    const result = (await new AxeBuilder({ page }).analyze()).violations
    assert.deepEqual(
      result.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({
          target,
          failureSummary,
        })),
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
  async function paintedIcons(locator, png) {
    const box = await locator.boundingBox()
    const icons = await locator.locator('.sd-icon').evaluateAll((nodes) =>
      nodes.map((node) => {
        const r = node.getBoundingClientRect()
        return {
          name: node.dataset.asset,
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          color: getComputedStyle(node).backgroundColor,
        }
      }),
    )
    const counts = await panel.evaluate(
      async ({ png, box, icons }) => {
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
        const image = await createImageBitmap(
          new Blob([bytes], { type: 'image/png' }),
        )
        const canvas = new OffscreenCanvas(image.width, image.height),
          ctx = canvas.getContext('2d')
        ctx.drawImage(image, 0, 0)
        image.close()
        return icons.map((icon) => {
          const expected = icon.color
            .match(/[\d.]+/g)
            .slice(0, 3)
            .map(Number)
          const pixels = ctx.getImageData(
            Math.round(icon.x - box.x),
            Math.round(icon.y - box.y),
            icon.width,
            icon.height,
          ).data
          let painted = 0
          for (let i = 0; i < pixels.length; i += 4)
            if (
              expected.every(
                (value, channel) => Math.abs(value - pixels[i + channel]) < 25,
              )
            )
              painted++
          return { name: icon.name, painted }
        })
      },
      { png: png.toString('base64'), box, icons },
    )
    assert(
      counts.every((icon) => icon.painted > 3),
      `Original icons must paint under page CSP: ${JSON.stringify(counts)}`,
    )
  }
  await importGuide(guide)
  let page = await start()
  await waitIndex(1)
  await targetFound()
  console.log('Walkthrough started from the actual editor')
  const overlay = page.getByRole('complementary', { name: 'Guide Me controls' })
  await expect(
    overlay.getByRole('dialog', { name: 'Click "Change plan"' }),
  ).toBeVisible()
  await checkAria(page, overlay, 'guide-overlay')
  await checkAria(panel, controlFrame.locator('.guide-panel'), 'guide-panel')
  const overlayPng = await overlay.screenshot({
    path: fileURLToPath(new URL('m11-guide-overlay.png', screens)),
  })
  await paintedIcons(overlay, overlayPng)
  await panel.bringToFront()
  const panelCapture = await panelSession.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 400, height: 856, scale: 1 },
  })
  const panelPng = Buffer.from(panelCapture.data, 'base64')
  assert.deepEqual(
    [panelPng.readUInt32BE(16), panelPng.readUInt32BE(20)],
    [400, 856],
  )
  await writeFile(new URL('m11-guide-panel.png', screens), panelPng)
  await paintedIcons(controlFrame.locator('.guide-panel'), panelPng)
  await page.bringToFront()
  const liveSession = await context.newCDPSession(page)
  const { windowId } = await liveSession.send('Browser.getWindowForTarget')
  await liveSession.send('Browser.setWindowBounds', {
    windowId,
    bounds: { windowState: 'normal', width: 1440, height: 1100 },
  })
  assert.deepEqual(
    await page.evaluate(() => [innerWidth, innerHeight]),
    [1040, 856],
    'Reference page viewport',
  )
  const shade = await page
    .locator('stepdoc-guide-me')
    .locator('svg.guide-shade')
    .boundingBox()
  assert.deepEqual(
    { width: shade.width, height: shade.height },
    { width: 1040, height: 856 },
    'The live shade covers the full reference viewport',
  )
  const liveCapture = await liveSession.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    clip: { x: 0, y: 0, width: 1040, height: 856, scale: 1 },
  })
  const livePng = Buffer.from(liveCapture.data, 'base64')
  await writeFile(new URL('m11-guide-page.png', screens), livePng)
  assert.deepEqual(
    [livePng.readUInt32BE(16), livePng.readUInt32BE(20)],
    [1040, 856],
  )
  const maskPixels = await panel.evaluate(async (png) => {
    const image = await createImageBitmap(
      new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
        type: 'image/png',
      }),
    )
    const canvas = new OffscreenCanvas(image.width, image.height),
      ctx = canvas.getContext('2d')
    ctx.drawImage(image, 0, 0)
    image.close()
    return [
      ctx.getImageData(1020, 830, 1, 1).data[0],
      ctx.getImageData(883, 177, 1, 1).data[0],
    ]
  }, livePng.toString('base64'))
  assert(
    maskPixels[0] < 220 && maskPixels[1] > 245,
    `The viewport bottom is dimmed while the target cutout stays clear: ${maskPixels}`,
  )
  await writeFile(new URL('m11-guide-page.png', screens), livePng)
  await liveSession.detach()
  await controlFrame.locator('html').evaluate((html) => {
    html.dataset.theme = 'dark'
  })
  await checkAria(
    panel,
    controlFrame.locator('.guide-panel'),
    'guide-panel-dark',
  )
  await controlFrame.locator('html').evaluate((html) => {
    delete html.dataset.theme
  })
  await page.setViewportSize({ width: 360, height: 740 })
  await panel.evaluate(async () => {
    const { guideMe } = await chrome.storage.local.get('guideMe')
    await chrome.runtime.sendMessage({
      type: 'GUIDE_REFRESH',
      runId: guideMe.runId,
      sequence: guideMe.sequence,
    })
  })
  await checkAria(page, overlay, 'guide-overlay-narrow')
  const narrow = await overlay.boundingBox()
  assert(
    narrow.x >= 16 &&
      narrow.x + narrow.width <= 344 &&
      narrow.y >= 16 &&
      narrow.y + narrow.height <= 724,
  )
  await page.setViewportSize({ width: 1040, height: 856 })
  await panel.evaluate(async () => {
    const { guideMe } = await chrome.storage.local.get('guideMe')
    await chrome.runtime.sendMessage({
      type: 'GUIDE_REFRESH',
      runId: guideMe.runId,
      sequence: guideMe.sequence,
    })
  })
  await expect
    .poll(async () => {
      const rect = await page.locator('#change').boundingBox()
      const target = (await state()).target
      return (
        target.reason === 'matched' &&
        !!target.rect &&
        ['x', 'y', 'width', 'height'].every(
          (key) => Math.abs(rect[key] - target.rect[key]) < 1,
        )
      )
    })
    .toBe(true)
  const assets = await overlay.locator('.sd-icon').evaluateAll((icons) =>
    icons.map((icon) => ({
      name: icon.dataset.asset,
      width: icon.getBoundingClientRect().width,
      height: icon.getBoundingClientRect().height,
      image: getComputedStyle(icon).maskImage,
    })),
  )
  assert.deepEqual(
    assets.map(({ name, width, height }) => ({ name, width, height })),
    [
      { name: 'export-close', width: 16, height: 16 },
      { name: 'guide-check', width: 14, height: 14 },
    ],
  )
  assert(
    assets.every((asset) => asset.image.startsWith(`url("${origin}/assets/`)),
  )
  // A site cannot forge success by dispatching a click into its own DOM.
  await page.locator('#change').evaluate((button) => button.click())
  assert.equal((await state()).index, 1)
  await page.locator('#unrelated').click()
  assert.equal((await state()).index, 1)
  await page.locator('#change').click()
  await waitIndex(2)
  await targetFound()
  await page.locator('#private').fill('PRIVATE_TYPED_GUIDE_PASSWORD')
  // A refresh must retain the same target's pending committed-field observation.
  await panel.evaluate(async () => {
    const { guideMe } = await chrome.storage.local.get('guideMe')
    await chrome.runtime.sendMessage({
      type: 'GUIDE_REFRESH',
      runId: guideMe.runId,
      sequence: guideMe.sequence,
    })
  })
  assert.equal((await state()).index, 2)
  await page.locator('#plan').focus()
  await waitIndex(3)
  await targetFound()
  await page.locator('#plan').selectOption({ label: 'Basic' })
  assert.equal((await state()).index, 3)
  await page.locator('#plan').selectOption({ label: 'Team' })
  assert.equal(
    (await state()).index,
    3,
    'Programmatic select events are not trusted interactions',
  )
  await page.locator('#plan').focus()
  await page.locator('#plan').press('Home')
  await page.locator('#plan').press('ArrowDown')
  await waitIndex(4)
  await targetFound()
  await page.locator('#confirmation').press('Enter')
  await waitIndex(5)
  await targetFound()
  await page
    .locator('#host')
    .getByRole('button', { name: 'Shadow action' })
    .click()
  await waitIndex(6)
  await targetFound()
  await page
    .frameLocator('#frame')
    .getByRole('button', { name: 'Frame action' })
    .click()
  await waitIndex(7)
  await targetFound()
  const remoteBox = await page.locator('#remote-host iframe').boundingBox()
  const childBox = await page
    .frameLocator('#remote-host iframe')
    .getByRole('button', { name: 'Frame action' })
    .evaluate((element) => {
      const r = element.getBoundingClientRect()
      return { x: r.x, y: r.y }
    })
  const remoteTarget = (await state()).target.rect
  assert(Math.abs(remoteTarget.x - remoteBox.x - 4 - childBox.x) < 1)
  assert(Math.abs(remoteTarget.y - remoteBox.y - 4 - childBox.y) < 1)
  await page
    .frameLocator('#remote-host iframe')
    .getByRole('button', { name: 'Frame action' })
    .click()
  await waitIndex(8)
  await targetFound()
  assert.equal((await state()).target.strategy, 'css')
  const old = await state()
  await page.locator('#fallback').click()
  await waitIndex(9)
  const forged = await panel.evaluate(
    (run) =>
      chrome.runtime.sendMessage({
        type: 'GUIDE_MATCH',
        runId: run.runId,
        sequence: run.sequence,
        documentId: run.target.documentId,
        token: run.target.token,
      }),
    old,
  )
  assert.equal(forged.ok, true)
  assert.equal((await state()).index, 9)
  await overlay.getByRole('button', { name: 'I did it', exact: true }).click()
  await expect.poll(async () => (await state()).phase).toBe('complete')
  assert.deepEqual((await state()).report.status, 'passed')
  assert.equal((await state()).report.runner, 'guide-me')
  assert(
    !JSON.stringify(await state()).includes('PRIVATE_TYPED_GUIDE_PASSWORD'),
  )
  await expect(
    app.getByRole('button', {
      name: 'Saved, version 2. Open history.',
      exact: true,
    }),
  ).toBeVisible()
  console.log(
    'Matched trusted actions, shadow and cross-origin frame targets; saved a local report',
  )
  await control('dismiss')
  await expect(overlay).toHaveCount(0)
  // Skip/back and missing targets cannot create a false pass.
  const second = {
    ...guide,
    id: 'native-missing',
    title: 'Missing target workflow',
    variables: [],
    steps: [
      step('missing', 'click', 'Find the missing target', {
        target: target('Does not exist'),
      }),
      step('ambiguous', 'click', 'Find the unique target', {
        target: target('Duplicate'),
      }),
      { id: 'manual', type: 'manual', title: 'Confirm manually' },
    ].map((s, i) => ({ ...s, index: i + 1 })),
  }
  await importGuide(second)
  page = await start()
  await waitIndex(0)
  await expect.poll(async () => (await state()).target.reason).toBe('missing')
  await checkAria(
    page,
    page.getByRole('complementary', { name: 'Guide Me controls' }),
    'guide-missing',
  )
  await control('skip')
  await waitIndex(1)
  await control('back')
  await waitIndex(0)
  assert.deepEqual((await state()).outcomes, [null, null, null])
  await control('skip')
  await waitIndex(1)
  await expect.poll(async () => (await state()).target.reason).toBe('ambiguous')
  await checkAria(
    page,
    page.getByRole('complementary', { name: 'Guide Me controls' }),
    'guide-ambiguous',
  )
  await page
    .getByRole('button', { name: 'Duplicate', exact: true })
    .first()
    .click()
  assert.equal((await state()).index, 1)
  await control('skip')
  await waitIndex(2)
  await control('confirm')
  await expect.poll(async () => (await state()).phase).toBe('complete')
  assert.equal((await state()).report.status, 'failed')
  assert.equal((await state()).report.failedStep, 1)
  await control('dismiss')
  // Native report-save failure preserves one stable report and retries safely.
  await importGuide({
    ...second,
    id: 'native-retry',
    title: 'Retry report workflow',
    steps: [
      { id: 'manual', index: 1, type: 'manual', title: 'Confirm manually' },
    ],
  })
  page = await start()
  await waitIndex(0)
  await worker.evaluate(() => {
    globalThis.savedGuidePut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'guides') throw new Error('PRIVATE_NATIVE_FAILURE')
      return globalThis.savedGuidePut.apply(this, args)
    }
  })
  await control('confirm')
  await expect.poll(async () => (await state()).phase).toBe('save-error')
  const report = (await state()).report
  await worker.evaluate(() => {
    IDBObjectStore.prototype.put = globalThis.savedGuidePut
    delete globalThis.savedGuidePut
  })
  await control('retry')
  await expect.poll(async () => (await state()).phase).toBe('complete')
  assert.deepEqual((await state()).report, report)
  await control('dismiss')
  // Closing a walkthrough with pending steps records failure, not success.
  page = await start()
  await waitIndex(0)
  await expect(
    page.getByRole('button', { name: 'End walkthrough', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await state()).phase).toBe('complete')
  assert.equal((await state()).report.status, 'failed')
  await control('dismiss')
  // The existing precondition retains the parent URL for a frame-first capture.
  const framed = {
    ...second,
    id: 'native-frame-first',
    title: 'Frame-first workflow',
    steps: [{ ...steps[7], index: 1 }],
  }
  await importGuide(framed)
  page = await start()
  await waitIndex(0)
  await targetFound()
  await page
    .frameLocator('#remote-host iframe')
    .getByRole('button', { name: 'Frame action' })
    .click()
  await expect.poll(async () => (await state()).phase).toBe('complete')
  assert.equal((await state()).report.status, 'passed')
  await control('dismiss')
  page = await start()
  await waitIndex(0)
  await targetFound()
  await page
    .frameLocator('#remote-host iframe')
    .getByRole('button', { name: 'Frame action' })
    .press('Escape')
  await expect.poll(async () => (await state()).phase).toBe('complete')
  assert.equal(
    (await state()).report.status,
    'failed',
    'Escape also ends a walkthrough while focus is inside a cross-origin frame',
  )
  await control('dismiss')
  // An editor commit made during a walkthrough cannot be overwritten by its report.
  await importGuide({
    ...second,
    id: 'native-conflict',
    title: 'Concurrent editor workflow',
    steps: [
      { id: 'manual', index: 1, type: 'manual', title: 'Confirm manually' },
    ],
  })
  page = await start()
  await waitIndex(0)
  await app.locator('[data-sd="editor-guide-details"]').click()
  await app
    .locator('[data-sd="editor-guide-title"]')
    .fill('Newer editor revision')
  await app.locator('[data-sd="editor-guide-details-close"]').click()
  await app
    .getByRole('button', {
      name: 'Saved, version 2. Open history.',
      exact: true,
    })
    .waitFor()
  await control('confirm')
  await expect.poll(async () => (await state()).phase).toBe('conflict')
  await app.reload()
  await expect(app.locator('[data-sd="editor-guide-details"]')).toHaveText(
    'Newer editor revision',
  )
  await expect(
    app.getByRole('button', {
      name: 'Saved, version 2. Open history.',
      exact: true,
    }),
  ).toBeVisible()
  await control('dismiss')
  page = await start()
  await waitIndex(0)
  await page.close()
  await expect.poll(async () => (await state()).phase).toBe('complete')
  assert.equal((await state()).report.status, 'failed')
  await control('dismiss')
  assert.equal(apiCalls, 0)
  assert.deepEqual(iconFailures, [])
  assert.deepEqual(errors, [])
  assert.deepEqual(requests, [])
  console.log(
    'Native Guide Me verified: actual editor launch, safe role/name + CSS fallback, trusted committed fields/select/key/click, open shadows and authenticated cross-origin frame projection, ambiguity/missing/manual/skip/back, local report save/retry/conflict, frame-first start, Escape/tab close, light/dark/narrow aria/axe, original icon pixels and no upload or typed-value retention.',
  )
} finally {
  await context?.close()
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  )
}

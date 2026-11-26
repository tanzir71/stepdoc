import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { extensionWorker } from './extension-worker.mjs'

let uploads = 0
const fixture = (req, res) => {
  if (req.url.startsWith('/api/')) uploads++
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>PRIVATE_TITLE</title><link rel="icon" href="data:,"></head><body style="margin:24px;font:16px Arial"><header><h1>Source fixture</h1></header><nav aria-label="Fixture"><a href="#main">Workflow</a></nav><main id="main" style="padding-top:100px"><button id="continue">Continue workflow</button><label>Password<input type="password"></label></main><footer>Local fixture</footer></body></html>',
  )
}
const servers = [createServer(fixture), createServer(fixture)]
await Promise.all(
  servers.map(
    (server) =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
  ),
)
const [base, other] = servers.map(
  (server) => `http://127.0.0.1:${server.address().port}`,
)
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const snapshots = new URL('../tests/targets/', import.meta.url)
const screens = new URL(
  update ? '../../../docs/v2/screens/' : '../../../test-results/screens/',
  import.meta.url,
)
await mkdir(snapshots, { recursive: true })
await mkdir(screens, { recursive: true })
const results = fileURLToPath(
  new URL('../../../test-results/', import.meta.url),
)
await mkdir(results, { recursive: true })
const profile = await mkdtemp(`${results}capture-target-profile-`)
let context
try {
  const dir = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url))
  const launchOptions = {
    channel: 'chromium',
    headless: true,
    viewport: null,
    args: [
      '--disable-gpu',
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
    ],
  }
  context = await chromium.launchPersistentContext(profile, launchOptions)
  context.setDefaultTimeout(15_000)
  context.setDefaultNavigationTimeout(20_000)
  console.log('Loading native source controls')
  let worker = await extensionWorker(context)
  const extensionId = new URL(worker.url()).host
  const origin = `chrome-extension://${extensionId}`
  const failures = []
  const watchPage = (page) => {
    page.on('pageerror', () => failures.push('Page runtime error'))
    page.on('request', (request) => {
      if (
        ![base, other, origin, 'data:', 'blob:'].some((prefix) =>
          request.url().startsWith(prefix),
        )
      )
        failures.push('Nonlocal request')
    })
  }
  context.on('page', watchPage)
  let source = await context.newPage()
  // Observe the real content-script execution world, including across navigation.
  const cdp = await context.newCDPSession(source),
    worlds = []
  cdp.on('Runtime.executionContextCreated', ({ context }) =>
    worlds.push(context),
  )
  cdp.on('Runtime.executionContextsCleared', () => {
    worlds.length = 0
  })
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    const index = worlds.findIndex((world) => world.id === executionContextId)
    if (index !== -1) worlds.splice(index, 1)
  })
  await cdp.send('Runtime.enable')
  await source.goto(`${base}/PRIVATE_PATH?PRIVATE_QUERY#PRIVATE_FRAGMENT`)
  let sourceTab = await worker.evaluate(
    async (base) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(base)),
    base,
  )
  const control = await context.newPage()
  const urlFor = (target, view = 'idle', entry = 'popup') => {
    const url = new URL(`${origin}/${entry}.html?surface=tab&view=${view}`)
    if (target) {
      url.searchParams.set('source', String(target.tabId))
      url.searchParams.set('origin', target.origin)
      url.searchParams.set('browser-session', target.browserSession)
    }
    return url.href
  }
  await control.goto(urlFor())
  const hook = (name, page = control) => page.locator(`[data-sd="${name}"]`)
  const message = (command, page = control) =>
    page.evaluate((command) => chrome.runtime.sendMessage(command), command)
  const state = () => worker.evaluate(() => chrome.storage.local.get(null))
  const phase = (expected) =>
    expect
      .poll(
        async () => {
          const value = await state()
          return value.captureError ?? value.captureReview?.phase
        },
        { timeout: 20_000 },
      )
      .toBe(expected)
  const inventory = async () => {
    const result = await message({ type: 'CAPTURE_TARGETS' })
    assert.equal(result.ok, true)
    return result.state
  }
  const initial = await inventory(),
    target = initial.targets.find((target) => target.tabId === sourceTab.id)
  assert(target?.ready)
  console.log('Checking origin-only inventory and empty selection')
  const choice = {
    tabId: target.tabId,
    origin: target.origin,
    browserSession: target.browserSession,
  }
  assert.equal(
    initial.suggested,
    null,
    'Full-tab controls never choose another active window implicitly',
  )
  assert(
    !JSON.stringify(initial).includes('PRIVATE_'),
    'Inventory excludes full addresses and titles',
  )
  assert.deepEqual(Object.keys(target).sort(), [
    'browserSession',
    'origin',
    'ready',
    'tabId',
  ])
  await expect(hook('capture-source')).toBeVisible()
  await expect(hook('capture-start')).toBeDisabled()
  assert.equal((await message({ type: 'START_CAPTURE' })).code, 'unavailable')
  assert.equal(
    (await state()).captureSessionId,
    undefined,
    'Invalid source fails before capture state mutation',
  )

  async function inspect(name, page = control) {
    await page.evaluate(() => document.fonts.ready)
    assert.deepEqual(
      (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
      [],
      `Axe ${name}`,
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow ${name}`,
    )
    const aria = `${await page.locator('.capture-panel').ariaSnapshot()}\n`
      .replaceAll(base, '<source>')
      .replaceAll(other, '<other>')
      .replaceAll(choice.browserSession, '<browser-session>')
      .replaceAll(`tab ${sourceTab.id}`, 'tab <source-tab>')
    const file = new URL(`${name}.aria.txt`, snapshots)
    if (update) await writeFile(file, aria)
    else
      assert.equal(
        aria,
        (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'),
        `Aria ${name}`,
      )
  }
  await inspect('source-empty')
  console.log('Checking selection, pairing and reload')
  await hook('capture-source').focus()
  await hook('capture-source').press('ArrowDown')
  await expect(hook('capture-source')).toHaveValue(JSON.stringify(choice))
  assert.equal(
    await hook('capture-source').evaluate(
      (element) =>
        getComputedStyle(
          element.closest('.sd-input').querySelector('.sd-input-field'),
        ).outlineStyle,
    ),
    'solid',
    'Keyboard selection retains the shared focus ring',
  )
  await expect(hook('capture-start')).toBeEnabled()
  await control.reload()
  await expect(hook('capture-source')).toHaveValue(JSON.stringify(choice))
  await expect(hook('capture-start')).toBeEnabled()
  await hook('capture-pair').click()
  await expect(hook('pair-server')).toBeVisible()
  const devices = control.getByRole('link', { name: 'Devices', exact: true })
  if (await devices.count())
    await expect(devices).toHaveAttribute('referrerpolicy', 'no-referrer')
  await control.reload()
  await expect(hook('pair-server')).toBeVisible()
  await hook('pair-local').click()
  await expect(hook('capture-source')).toHaveValue(JSON.stringify(choice))
  await expect(hook('capture-start')).toBeEnabled()
  await hook('capture-source-open').click()
  await expect
    .poll(() =>
      worker.evaluate(
        async (id) => (await chrome.tabs.get(id)).active,
        sourceTab.id,
      ),
    )
    .toBe(true)
  await expect(control.getByRole('status')).toContainText(
    'Selected web page opened',
  )
  assert.equal(
    (await state()).recording,
    undefined,
    'Show page never starts a capture',
  )
  await control.bringToFront()

  // Actual content-script messages have the browser's source URL, not a forged sender.
  let contentWorld
  await expect
    .poll(async () => {
      for (const world of worlds.filter((world) => !world.auxData?.isDefault)) {
        const result = await cdp.send('Runtime.evaluate', {
          contextId: world.id,
          expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`,
          returnByValue: true,
        })
        if (result.result.value) contentWorld = world.id
      }
      return !!contentWorld
    })
    .toBe(true)
  for (const command of [
    { type: 'CAPTURE_TARGETS' },
    { type: 'CAPTURE_FOCUS_TARGET', target: choice },
    { type: 'START_CAPTURE', target: choice },
  ]) {
    const result = await cdp.send('Runtime.evaluate', {
      contextId: contentWorld,
      expression: `chrome.runtime.sendMessage(${JSON.stringify(command)})`,
      returnByValue: true,
      awaitPromise: true,
    })
    assert(!result.exceptionDetails)
    assert.equal(
      result.result.value.ok,
      false,
      `Reject content-world ${command.type}`,
    )
    assert(!JSON.stringify(result.result.value).includes(choice.browserSession))
  }
  const before = await state()
  assert.equal(
    (
      await message({
        type: 'START_CAPTURE',
        target: { ...choice, browserSession: randomUUID() },
      })
    ).code,
    'expired',
  )
  assert.deepEqual(
    await state(),
    before,
    'Expired selection leaves retained state untouched',
  )
  await source.goto(`${other}/changed`)
  await expect(hook('capture-start')).toBeDisabled()
  assert.equal(
    (await message({ type: 'START_CAPTURE', target: choice })).code,
    'changed',
  )
  assert.deepEqual(
    await state(),
    before,
    'Changed origin fails before capture mutation',
  )
  await source.goto(`${base}/PRIVATE_PATH?PRIVATE_QUERY#PRIVATE_FRAGMENT`)
  await expect(hook('capture-start')).toBeEnabled()

  console.log('Checking explicit cross-window start and retained review return')
  // Move the source to another real browser window, then minimize it.
  const secondWindow = await worker.evaluate(async (id) => {
    const window = await chrome.windows.create({ tabId: id, focused: false })
    await chrome.windows.update(window.id, { state: 'minimized' })
    return window.id
  }, sourceTab.id)
  await control.bringToFront()
  const closed = control.waitForEvent('close')
  await hook('capture-start').click()
  await closed
  await phase('recording')
  const started = await state()
  assert.deepEqual(started.captureSource, choice)
  assert.equal(started.captureTabId, sourceTab.id)
  const windowState = await worker.evaluate(
    (id) => chrome.windows.get(id),
    secondWindow,
  )
  assert.equal(windowState.focused, true)
  assert.notEqual(windowState.state, 'minimized')
  const pill = source.getByRole('complementary', {
    name: 'Recording controls',
    exact: true,
  })
  await expect(pill).toBeVisible()
  await source.locator('#continue').click()
  await expect
    .poll(
      async () => {
        const value = await state()
        return value.captureError ?? value.capturedSteps?.length
      },
      { timeout: 20_000 },
    )
    .toBe(1)
  const captured = await state()
  assert(
    /^data:image\/(png|webp);base64,/.test(captured.steps[0].screenshot),
    'Only processed raster data is retained',
  )
  assert.equal(captured.capturedSteps[0].url, `${base}/PRIVATE_PATH`)
  const reviewOpened = context.waitForEvent('page')
  await pill
    .getByRole('button', { name: 'Stop and review', exact: true })
    .click()
  const review = await reviewOpened
  await review.waitForURL(`${origin}/sidepanel.html?surface=tab&view=review`)
  await phase('review')
  await expect(hook('capture-title', review)).toBeVisible()
  assert.equal(
    (await message({ type: 'CAPTURE_FOCUS_TARGET', target: choice }, review))
      .code,
    'busy',
  )
  await hook('capture-discard', review).click()
  await review
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click()
  await expect(hook('capture-source', review)).toHaveValue(
    JSON.stringify(choice),
  )
  await expect(hook('capture-start', review)).toBeEnabled()
  assert.equal((await inventoryFrom(review)).suggested.tabId, sourceTab.id)
  async function inventoryFrom(page) {
    return (await message({ type: 'CAPTURE_TARGETS' }, page)).state
  }

  // Closing controls can fail without restarting, losing or misreporting the capture.
  await review.evaluate(() => {
    const original = chrome.tabs.remove.bind(chrome.tabs)
    globalThis.restoreSourceClose = () => {
      chrome.tabs.remove = original
    }
    chrome.tabs.remove = async () => {
      throw new Error('PRIVATE_CLOSE_FAILURE')
    }
  })
  await hook('capture-start', review).click()
  await phase('recording')
  await expect(review.getByRole('status')).toContainText(
    'controls tab could not close',
  )
  const secondCapture = await state()
  assert.notEqual(secondCapture.captureSessionId, started.captureSessionId)
  assert.equal(secondCapture.steps.length, 0)
  await review.evaluate(() => {
    globalThis.restoreSourceClose()
    delete globalThis.restoreSourceClose
  })

  await source.locator('#continue').click()
  await expect
    .poll(async () => (await state()).capturedSteps?.length, {
      timeout: 20_000,
    })
    .toBe(1)
  const retainedImage = (await state()).steps[0].screenshot
  console.log('Checking browser-session expiry with a real browser restart')
  const oldSession = secondCapture.captureSource.browserSession
  await context.close()
  context = await chromium.launchPersistentContext(profile, launchOptions)
  context.setDefaultTimeout(15_000)
  context.setDefaultNavigationTimeout(20_000)
  context.on('page', watchPage)
  worker = await extensionWorker(context)
  source = await context.newPage()
  await source.goto(`${base}/PRIVATE_PATH?PRIVATE_QUERY#PRIVATE_FRAGMENT`)
  sourceTab = await worker.evaluate(
    async (base) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(base)),
    base,
  )
  let recovered = await context.newPage()
  await recovered.goto(urlFor(choice, 'review'))
  await expect
    .poll(async () => (await state()).captureReview?.phase)
    .toBe('review')
  const retained = await state()
  assert.equal(retained.recording, false)
  assert.equal(retained.captureReview.clock.runningSince, null)
  assert.match(retained.captureError, /browser session changed/)
  assert.equal(retained.captureSessionId, secondCapture.captureSessionId)
  assert.equal(retained.steps.length, 1)
  assert(
    retained.steps[0].screenshot === retainedImage,
    'Browser restart retains the processed image unchanged',
  )
  const freshInventory = await inventoryFrom(recovered)
  assert.equal(freshInventory.suggested, null)
  const freshTarget = freshInventory.targets.find(
    (target) => target.tabId === sourceTab.id,
  )
  assert.notEqual(freshTarget.browserSession, oldSession)
  await message(
    { type: 'DISCARD_CAPTURE', sessionId: retained.captureSessionId },
    recovered,
  )
  await expect(hook('capture-start', recovered)).toBeDisabled()
  assert.equal(
    (await message({ type: 'START_CAPTURE', target: choice }, recovered)).code,
    'expired',
  )
  const freshChoice = {
    tabId: freshTarget.tabId,
    origin: freshTarget.origin,
    browserSession: freshTarget.browserSession,
  }
  await hook('capture-source', recovered).selectOption(
    JSON.stringify(freshChoice),
  )
  await expect(hook('capture-start', recovered)).toBeEnabled()
  await source.close()
  await expect(hook('capture-start', recovered)).toBeDisabled()
  assert.equal(
    (await message({ type: 'START_CAPTURE', target: freshChoice }, recovered))
      .code,
    'unavailable',
  )
  const unrelated = await context.newPage()
  await unrelated.goto(`${other}/unrelated`)
  await expect(hook('capture-start', recovered)).toBeDisabled()
  await hook('capture-source-refresh', recovered).click()
  await expect(hook('capture-start', recovered)).toBeDisabled()
  assert.equal(
    (await inventoryFrom(recovered)).suggested,
    null,
    'Closed source never falls back to an unrelated page',
  )

  // Windows can stop compositor frames after native multi-window/restart checks.
  // Render responsive references in a fresh extension profile, as E05/E06 do.
  await context.close()
  context = await chromium.launchPersistentContext('', {
    ...launchOptions,
    viewport: { width: 400, height: 900 },
  })
  context.setDefaultTimeout(15_000)
  context.setDefaultNavigationTimeout(20_000)
  context.on('page', watchPage)
  worker = await extensionWorker(context)
  const referenceSource = await context.newPage()
  await referenceSource.goto(`${other}/reference`)
  recovered = await context.newPage()
  await recovered.goto(urlFor(null))
  await expect(hook('capture-source', recovered)).toBeVisible()
  const available = (await inventoryFrom(recovered)).targets[0]
  const referenceChoice = {
    tabId: available.tabId,
    origin: available.origin,
    browserSession: available.browserSession,
  }
  await hook('capture-source', recovered).selectOption(
    JSON.stringify(referenceChoice),
  )
  await expect(hook('capture-start', recovered)).toBeEnabled()
  // Canonicalize the changing fixture identity in this reference-only tree.
  const normalize = async (name) => {
    const aria = `${await recovered.locator('.capture-panel').ariaSnapshot()}\n`
      .replaceAll(other, '<source>')
      .replaceAll(`tab ${available.tabId}`, 'tab <source-tab>')
    const file = new URL(`${name}.aria.txt`, snapshots)
    if (update) await writeFile(file, aria)
    else
      assert.equal(
        aria,
        (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'),
        `Aria ${name}`,
      )
    assert.deepEqual(
      (await new AxeBuilder({ page: recovered }).analyze()).violations,
      [],
      `Axe ${name}`,
    )
    assert(
      await recovered.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
  }
  await recovered.evaluate(() => document.fonts.ready)
  const geometry = await recovered.evaluate(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect()
      return { x: r.x, width: r.width, height: r.height }
    }
    return {
      header: box('header'),
      source: box('.capture-source'),
      field: box('.capture-source .sd-input-field'),
      assets: [...document.querySelectorAll('[data-asset]')].map((element) => ({
        name: element.dataset.asset,
        width: element.offsetWidth,
        height: element.offsetHeight,
      })),
    }
  })
  assert.deepEqual(geometry.header, { x: 0, width: 400, height: 52 })
  assert.equal(geometry.source.x, 16)
  assert.equal(geometry.source.width, 368)
  assert.equal(geometry.field.height, 36)
  for (const [name, size] of [
    ['sliders', 16],
    ['capture-record', 30],
  ])
    assert(
      geometry.assets.some(
        (asset) =>
          asset.name === name && asset.width === size && asset.height === size,
      ),
      `Original ${name} geometry`,
    )
  await normalize('source-ready')
  const screenshot = () => recovered.screenshot()
  const painted = await recovered.evaluate(
    async (pixels) => {
      const bitmap = await createImageBitmap(
        await (await fetch(`data:image/png;base64,${pixels}`)).blob(),
      )
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      return [...document.querySelectorAll('[data-asset],.sd-logo img')]
        .filter((element) => element.getBoundingClientRect().width > 0)
        .map((element) => {
          const r = element.getBoundingClientRect(),
            data = ctx.getImageData(r.x, r.y, r.width, r.height).data,
            colors = new Set()
          for (let i = 0; i < data.length; i += 4)
            colors.add(data.slice(i, i + 3).join(','))
          return colors.size > 1
        })
    },
    (await screenshot()).toString('base64'),
  )
  assert(
    painted.length >= 3 && painted.every(Boolean),
    'Every visible original asset paints',
  )
  await writeFile(
    new URL('m11-capture-source-light.png', screens),
    await screenshot(),
  )
  await recovered.evaluate(
    () => (document.documentElement.dataset.theme = 'dark'),
  )
  await normalize('source-dark')
  await writeFile(
    new URL('m11-capture-source-dark.png', screens),
    await screenshot(),
  )
  await recovered.setViewportSize({ width: 320, height: 740 })
  await normalize('source-narrow')
  await recovered.goto(
    `${urlFor(null)}&source=04&origin=${encodeURIComponent(other)}&browser-session=${randomUUID()}`,
  )
  await expect(hook('capture-start', recovered)).toBeDisabled()
  await expect(recovered.locator('#capture-source-hint')).toContainText(
    'invalid',
  )
  assert(!recovered.url().includes('source=04'))
  await normalize('source-invalid')
  assert.equal(uploads, 0)
  assert.deepEqual(failures, [])
  console.log(
    'Native capture targets verified: private origin-only inventory, real source-world rejection, explicit selection across pairing/reload/review, changed/closed/session-expired protection, exact cross-window camera start, controls closure/retry, real browser-restart recovery, geometry and light/dark/narrow aria/axe; no upload.',
  )
} finally {
  await context?.close()
  assert.equal(
    dirname(resolve(profile)),
    resolve(results),
    'Only this suite profile is removed',
  )
  await rm(profile, { recursive: true, force: true })
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  )
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { extensionWorker } from './extension-worker.mjs'

// Action popups are native Chrome targets, outside Playwright's tab inventory.
// Attach with CDP rather than replacing the popup with a normal active tab.
async function attachPopup(session, targetId) {
  const { sessionId } = await session.send('Target.attachToTarget', {
    targetId,
    flatten: false,
  })
  let id = 0
  const pending = new Map()
  const receive = ({ sessionId: from, message }) => {
    if (from !== sessionId) return
    const response = JSON.parse(message)
    if (!response.id) return
    const request = pending.get(response.id)
    if (!request) return
    pending.delete(response.id)
    clearTimeout(request.timer)
    if (response.error) request.reject(new Error(response.error.message))
    else request.resolve(response.result)
  }
  session.on('Target.receivedMessageFromTarget', receive)
  const call = async (method, params = {}) => {
    const requestId = ++id
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`Native popup command timed out: ${method}`))
      }, 15_000)
      pending.set(requestId, { resolve, reject, timer })
    })
    try {
      await session.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id: requestId, method, params }),
      })
    } catch (error) {
      const request = pending.get(requestId)
      if (request) {
        pending.delete(requestId)
        clearTimeout(request.timer)
        request.reject(error)
      }
    }
    return result
  }
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (response.exceptionDetails)
      throw new Error('Native popup evaluation failed')
    return response.result.value
  }
  const click = async (hook) => {
    const selector = `[data-sd="${hook}"]`
    await expect
      .poll(() =>
        evaluate(
          `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`,
        ),
      )
      .toBe(true)
    const point = await evaluate(
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'nearest'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    )
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button: 'left',
      clickCount: 1,
      ...point,
    })
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button: 'left',
      clickCount: 1,
      ...point,
    })
  }
  return {
    call,
    evaluate,
    click,
    targetId,
    async close() {
      await evaluate('window.close(); true')
      session.off('Target.receivedMessageFromTarget', receive)
      await expect
        .poll(async () =>
          (await session.send('Target.getTargets')).targetInfos.some(
            (target) => target.targetId === targetId,
          ),
        )
        .toBe(false)
    },
  }
}

let uploads = 0
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/')) uploads++
  res.writeHead(200, {
    'content-type': 'text/html',
    'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'",
  })
  res.end(
    '<!doctype html><html lang="en"><head><title>Popup capture fixture</title><link rel="icon" href="data:,"><style>body{font:16px Arial;margin:40px;background:rgb(245,246,247)}button{padding:12px;margin:8px}</style></head><body><header><h1>Local popup workflow</h1></header><nav aria-label="Fixture"><a href="#main">Workflow</a></nav><main id="main"><button id="first">Open settings</button><button id="second">Apply settings</button></main><footer>Local fixture</footer></body></html>',
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const snapshots = new URL('../tests/popup/', import.meta.url)
const screens = new URL(
  update ? '../../../docs/v2/screens/' : '../../../test-results/screens/',
  import.meta.url,
)
await mkdir(snapshots, { recursive: true })
await mkdir(screens, { recursive: true })
const require = createRequire(import.meta.url)
const axe = createRequire(require.resolve('@axe-core/playwright'))('axe-core')
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
  const url = new URL(worker.url()),
    origin = `${url.protocol}//${url.host}`
  const errors = []
  context.on('page', (page) => {
    page.on('pageerror', () => errors.push('Private tab runtime error'))
    page.on('requestfailed', (request) => {
      if (request.url().startsWith(origin))
        errors.push('Private resource failed')
    })
    page.on('request', (request) => {
      if (
        ![origin, base, 'data:', 'blob:'].some((prefix) =>
          request.url().startsWith(prefix),
        )
      )
        errors.push('Nonlocal request')
    })
  })
  const fixture = await context.newPage()
  await fixture.goto(`${base}/workflow`)
  const tab = await worker.evaluate(
    async (base) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(base)),
    base,
  )
  const session = await context.newCDPSession(fixture)
  const worlds = []
  session.on('Runtime.executionContextCreated', ({ context }) =>
    worlds.push(context),
  )
  await session.send('Runtime.enable')
  const state = () => worker.evaluate(() => chrome.storage.local.get(null))
  const phase = (expected) =>
    expect
      .poll(async () => (await state()).captureReview?.phase, {
        timeout: 30_000,
      })
      .toBe(expected)
  const activate = async () => {
    await worker.evaluate(async (tab) => {
      await chrome.windows.update(tab.windowId, { focused: true })
      await chrome.tabs.update(tab.id, { active: true })
    }, tab)
    await fixture.bringToFront()
  }
  await worker.evaluate(async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
    await chrome.action.setPopup({ popup: 'popup.html' })
  })
  const open = async () => {
    await activate()
    await expect
      .poll(() =>
        worker.evaluate(async (windowId) => {
          try {
            await chrome.action.openPopup({ windowId })
            return true
          } catch {
            return false
          }
        }, tab.windowId),
      )
      .toBe(true)
    let targetId
    await expect
      .poll(async () => {
        const { targetInfos } = await session.send('Target.getTargets')
        targetId = targetInfos.find(
          (target) =>
            target.url.startsWith(`${origin}/popup.html`) &&
            !target.url.includes('surface=tab'),
        )?.targetId
        return !!targetId
      })
      .toBe(true)
    const popup = await attachPopup(session, targetId)
    await expect
      .poll(() =>
        popup.evaluate(
          '!!document.querySelector(".capture-panel[data-phase]") && !document.querySelector("[data-sd=capture-start]")?.disabled',
        ),
      )
      .toBe(true)
    await popup.evaluate('document.fonts.ready.then(()=>true)')
    return popup
  }
  async function inspect(popup, name) {
    await popup.evaluate(axe.source)
    const violations = await popup.evaluate(
      'axe.run(document).then(result=>result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)})))',
    )
    assert.deepEqual(violations, [], `Native axe: ${name}`)
    const tree = await popup.call('Accessibility.getFullAXTree')
    const text =
      tree.nodes
        .filter((node) => !node.ignored)
        .map((node) => {
          const name = /^\d{2,}(?::\d{2}){1,2}$/.test(node.name?.value ?? '')
            ? '<elapsed>'
            : (node.name?.value ?? '')
          const props = node.properties
            ?.filter((prop) =>
              ['checked', 'disabled', 'expanded', 'level'].includes(prop.name),
            )
            .map((prop) => `${prop.name}=${prop.value.value}`)
            .join(' ')
          return `${node.role?.value ?? ''} ${JSON.stringify(name)}${props ? ' ' + props : ''}`
        })
        .join('\n') + '\n'
    const path = new URL(`${name}.aria.txt`, snapshots)
    if (update) await writeFile(path, text)
    else
      assert.equal(
        text,
        (await readFile(path, 'utf8')).replaceAll('\r\n', '\n'),
        `Native tree: ${name}`,
      )
  }

  // Seed real guides through the native app, then render its actual recent list.
  const app = await context.newPage()
  for (const title of [
    'Rotate an integration key',
    'Upgrade a workspace to the Team plan',
  ]) {
    await app.goto(`${origin}/app.html`)
    await app.locator('[data-sd=library-create]').click()
    await app
      .getByRole('textbox', { name: 'Guide title', exact: true })
      .fill(title)
    await app
      .getByRole('textbox', { name: 'First instruction', exact: true })
      .fill('Open workspace settings')
    await app.locator('[data-sd=guide-create-submit]').click()
    await expect(
      app.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible()
  }
  await app.close()
  let popup = await open()
  await expect
    .poll(() =>
      popup.evaluate(
        'document.querySelectorAll("[data-sd=capture-recent]").length',
      ),
    )
    .toBe(2)
  await inspect(popup, 'popup-idle')
  const geometry = await popup.evaluate(
    `(()=>{const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};return {header:box('.capture-header'),card:box('.capture-start-card'),record:box('[data-sd=capture-start]'),recent:box('.capture-recent'),library:box('[data-sd=capture-library]'),icons:[...document.querySelectorAll('[data-asset]')].map(el=>({name:el.dataset.asset,width:el.offsetWidth,height:el.offsetHeight})),toggles:[...document.querySelectorAll('[role=switch]')].map(el=>({width:el.offsetWidth,height:el.offsetHeight}))}})()`,
  )
  assert.equal(geometry.header.height, 48)
  assert.deepEqual(geometry.card, { x: 14, y: 62, width: 332, height: 72 })
  assert.deepEqual(geometry.record, { x: 28, y: 76, width: 44, height: 44 })
  assert.equal(geometry.recent.y, 210)
  assert.equal(geometry.library.y, 330)
  for (const [name, width, height] of [
    ['popup-record', 20, 20],
    ['popup-file', 14, 14],
    ['popup-library', 14, 14],
    ['popup-pair', 14, 14],
    ['dot', 6, 6],
  ]) {
    assert(
      geometry.icons.some(
        (icon) =>
          icon.name === name && icon.width === width && icon.height === height,
      ),
      `Original icon geometry: ${name}`,
    )
  }
  assert.deepEqual(geometry.toggles, [
    { width: 32, height: 18 },
    { width: 32, height: 18 },
  ])
  const painted = await popup.call('Page.captureScreenshot', { format: 'png' })
  const glyphPixels = await popup.evaluate(`(async()=>{
    const bitmap=await createImageBitmap(await (await fetch('data:image/png;base64,${painted.data}')).blob());
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext('2d');ctx.drawImage(bitmap,0,0);bitmap.close();
    return [...document.querySelectorAll('[data-asset],.sd-logo img,.sd-toggle img')].filter(el=>el.getBoundingClientRect().width>0).map(el=>{
      const r=el.getBoundingClientRect(),pixels=ctx.getImageData(Math.floor(r.x),Math.floor(r.y),Math.ceil(r.width),Math.ceil(r.height)).data,colors=new Set();
      for(let i=0;i<pixels.length;i+=4) colors.add(pixels.slice(i,i+3).join(','));
      return {name:el.dataset.asset??(el.closest('.sd-logo')?'logo':'toggle'),painted:colors.size>1};
    });
  })()`)
  assert(painted.data.length > 1000, 'Native popup screenshot is empty')
  assert(glyphPixels.length >= 9, 'Visible E06 asset inventory is incomplete')
  assert(
    glyphPixels.every((glyph) => glyph.painted),
    'An original E06 asset did not paint',
  )

  await popup.click('capture-agent-context')
  await expect
    .poll(async () => (await state()).captureReview.preferences.agentContext)
    .toBe(false)
  await popup.close()
  popup = await open()
  assert.equal(
    await popup.evaluate(
      'document.querySelector("[data-sd=capture-agent-context]").getAttribute("aria-checked")',
    ),
    'false',
  )
  await popup.evaluate(
    'document.querySelector("[data-sd=capture-agent-context]").focus()',
  )
  for (const type of ['keyDown', 'keyUp'])
    await popup.call('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(type === 'keyDown' ? { text: '\r', unmodifiedText: '\r' } : {}),
    })
  await expect
    .poll(async () => (await state()).captureReview.preferences.agentContext)
    .toBe(true)
  await popup.click('capture-smart-blur')
  await popup.close()
  popup = await open()
  assert.equal(
    await popup.evaluate(
      'document.querySelector("[data-sd=capture-smart-blur]").getAttribute("aria-checked")',
    ),
    'false',
  )
  await popup.click('capture-smart-blur')
  await popup.close()

  // Reference geometry in the same unchanged private renderer, at 360×560.
  const reference = await context.newPage()
  await reference.setViewportSize({ width: 360, height: 560 })
  await reference.goto(`${origin}/popup.html`)
  await expect(reference.locator('[data-sd=capture-recent]')).toHaveCount(2)
  await reference.evaluate(() => document.fonts.ready)
  for (const theme of ['light', 'dark']) {
    await reference.evaluate(
      (theme) =>
        localStorage.setItem(
          'stepdoc.preferences.v1',
          JSON.stringify({ version: 1, theme, collapsed: false }),
        ),
      theme,
    )
    await reference.reload()
    await expect(reference.locator('html')).toHaveAttribute('data-theme', theme)
    await reference.evaluate(() => document.fonts.ready)
    assert.deepEqual(
      (await new AxeBuilder({ page: reference }).analyze()).violations.map(
        (v) => v.id,
      ),
      [],
    )
    await reference.screenshot({
      path: fileURLToPath(new URL(`m11-popup-${theme}.png`, screens)),
    })
  }
  await reference.setViewportSize({ width: 320, height: 560 })
  assert.deepEqual(
    (await new AxeBuilder({ page: reference }).analyze()).violations.map(
      (v) => v.id,
    ),
    [],
  )
  assert(
    await reference.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Narrow popup overflow',
  )
  await reference.evaluate(() =>
    localStorage.setItem(
      'stepdoc.preferences.v1',
      JSON.stringify({ version: 1, theme: 'system', collapsed: false }),
    ),
  )
  await reference.close()
  popup = await open()
  for (const value of ['dark', 'light']) {
    await popup.call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value }],
    })
    await expect
      .poll(() => popup.evaluate('document.documentElement.dataset.theme'))
      .toBe(value)
  }
  await popup.evaluate(
    'localStorage.setItem("stepdoc.preferences.v1",JSON.stringify({version:1,theme:"light",collapsed:false}))',
  )
  await popup.close()

  popup = await open()
  const libraryOpened = context.waitForEvent('page')
  await popup.click('capture-library')
  const library = await libraryOpened
  await library.waitForLoadState()
  assert.equal(library.url(), `${origin}/app.html`)
  await library.close()
  popup = await open()
  const editorOpened = context.waitForEvent('page')
  await popup.click('capture-recent')
  const editor = await editorOpened
  await expect(editor.locator('[data-sd=step-title]')).toHaveValue(
    'Open workspace settings',
  )
  await editor.close()

  popup = await open()
  await popup.click('capture-start')
  await phase('recording')
  assert.equal(
    (await state()).captureTabId,
    tab.id,
    'The native popup never replaces the capture tab',
  )
  const sessionId = (await state()).captureSessionId
  await popup.close()
  await activate()
  await fixture.locator('#first').click()
  await expect
    .poll(async () => (await state()).capturedSteps?.length, {
      timeout: 30_000,
    })
    .toBe(1)
  popup = await open()
  await inspect(popup, 'popup-recording')
  await popup.click('capture-pause')
  await phase('paused')
  const paused = (await state()).captureReview.clock
  await popup.close()
  popup = await open()
  assert.deepEqual((await state()).captureReview.clock, paused)
  await inspect(popup, 'popup-paused')
  assert.deepEqual(
    await popup.evaluate(
      `chrome.runtime.sendMessage(${JSON.stringify({ type: 'OPEN_CAPTURE_REVIEW', sessionId })})`,
    ),
    { ok: false, error: 'Capture operation failed' },
    'Review cannot open while paused',
  )
  await popup.click('capture-pause')
  await phase('recording')
  await popup.close()
  await activate()
  await fixture.locator('#second').click()
  await expect
    .poll(async () => (await state()).capturedSteps?.length, {
      timeout: 30_000,
    })
    .toBe(2)
  assert.equal((await state()).captureSessionId, sessionId)

  popup = await open()
  await worker.evaluate(() => {
    const original = chrome.tabs.create.bind(chrome.tabs)
    globalThis.restorePopupCreate = () => {
      chrome.tabs.create = original
    }
    chrome.tabs.create = async () => {
      throw new Error('Fixture review launch failure')
    }
  })
  await popup.click('capture-review')
  await phase('review')
  await expect
    .poll(() =>
      popup.evaluate(
        'document.querySelector("#status").textContent.includes("retained")',
      ),
    )
    .toBe(true)
  await popup.close()
  popup = await open()
  await inspect(popup, 'popup-retained-review')
  assert.deepEqual(
    await popup.evaluate(
      'chrome.runtime.sendMessage({type:"OPEN_CAPTURE_REVIEW",sessionId:"stale-session"})',
    ),
    { ok: false, error: 'Capture operation failed' },
    'Private controls still require the current session',
  )
  assert.equal((await state()).capturedSteps.length, 2)
  let contentWorld
  for (const world of worlds.filter((world) => !world.auxData?.isDefault)) {
    const result = await session.send('Runtime.evaluate', {
      contextId: world.id,
      expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(url.host)}`,
      returnByValue: true,
    })
    if (result.result.value) contentWorld = world.id
  }
  assert(contentWorld, 'The actual extension content world is unavailable')
  const rejected = await session.send('Runtime.evaluate', {
    contextId: contentWorld,
    awaitPromise: true,
    returnByValue: true,
    expression: `chrome.runtime.sendMessage(${JSON.stringify({ type: 'OPEN_CAPTURE_REVIEW', sessionId })})`,
  })
  assert.deepEqual(
    rejected.result.value,
    { ok: false, error: 'Capture operation failed' },
    'A source-page sender cannot open private review',
  )
  await popup.click('capture-discard')
  for (const type of ['keyDown', 'keyUp'])
    await popup.call('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
  await expect
    .poll(() => popup.evaluate('!!document.querySelector("dialog[open]")'))
    .toBe(false)
  assert.equal((await state()).capturedSteps.length, 2)
  await worker.evaluate(() => globalThis.restorePopupCreate())
  const reviewOpened = context.waitForEvent('page')
  await popup.click('capture-open-review')
  const review = await reviewOpened
  await review.waitForLoadState()
  assert.equal(new URL(review.url()).searchParams.get('surface'), 'tab')
  await expect(review.locator('.capture-panel')).toHaveAttribute(
    'data-compact',
    'false',
  )
  await expect(review.locator('[data-sd=capture-select-step]')).toHaveCount(2)
  assert.deepEqual(
    (await new AxeBuilder({ page: review }).analyze()).violations.map(
      (v) => v.id,
    ),
    [],
    'Full-tab review axe',
  )
  await review
    .locator('[data-sd=capture-title]')
    .fill('Captured through the popup')
  const savedEditor = context.waitForEvent('page')
  await review.locator('[data-sd=capture-save]').click()
  const saved = await savedEditor
  await expect(saved.locator('[data-sd=editor-guide-details]')).toHaveText(
    'Captured through the popup',
  )
  await saved.reload()
  await expect(saved.locator('[data-sd=editor-save-status]')).toContainText(
    'v1',
  )
  await saved.close()
  await review.close()
  popup = await open()
  await expect
    .poll(() =>
      popup.evaluate(
        'document.querySelector("[data-sd=capture-recent]")?.textContent',
      ),
    )
    .toBe('Captured through the popup')
  await popup.close()
  popup = await open()
  const pairingOpened = context.waitForEvent('page')
  await popup.click('capture-pair')
  const pairing = await pairingOpened
  await expect(pairing.locator('[data-sd=pair-server]')).toBeVisible()
  const pairingUrl = new URL(pairing.url())
  assert.equal(
    pairingUrl.searchParams.get('source'),
    String(tab.id),
    'Actual action popup preserves the active web page',
  )
  assert.equal(pairingUrl.searchParams.get('origin'), base)
  assert.match(
    pairingUrl.searchParams.get('browser-session'),
    /^[a-f0-9-]{36}$/,
  )
  const popupStillOpen = (
    await session.send('Target.getTargets')
  ).targetInfos.some((target) => target.targetId === popup.targetId)
  if (popupStillOpen) await popup.close()
  await pairing.locator('[data-sd=pair-local]').click()
  await expect(pairing.locator('[data-sd=capture-source]')).toBeVisible()
  await expect(pairing.locator('[data-sd=capture-start]')).toBeEnabled()
  const selected = JSON.parse(
    await pairing.locator('[data-sd=capture-source]').inputValue(),
  )
  assert.equal(selected.tabId, tab.id)
  assert.equal(selected.origin, base)
  await pairing.close()
  assert.equal(uploads, 0)
  assert.deepEqual(errors, [])
  console.log(
    'Native popup verified: real action target, original E06 geometry/assets, live recent guides, durable keyboard preferences, library/editor tabs, capture across closure/reopen, pause/resume, retained review launch/retry, Escape, full-tab native save, light/dark/narrow axe and no upload.',
  )
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}

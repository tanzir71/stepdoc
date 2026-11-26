import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { extensionWorker } from './extension-worker.mjs'

// Local protocol fixture only. No production target, image processing or live service.
const credential = 'sd_native_private_destination_fixture'
const guides = new Map(),
  blobs = new Map(),
  posts = [],
  audit = []
let extensionId,
  mode = 'ok',
  drops = 0,
  genericWrites = 0
const escape = (text) =>
  String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;')
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  if (!url.pathname.includes('/api/')) {
    const match = /^\/workspace\/g\/([^/]+)\/edit$/.exec(url.pathname)
    const guide = match && guides.get(match[1])
    if (guide)
      assert(!req.headers.referer, 'Private controls URL reached the editor')
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      guide
        ? `<!doctype html><html lang="en"><head><title>Server editor fixture</title><link rel="icon" href="data:,"></head><body><header>Server editor fixture</header><main><h1>${escape(guide.title)}</h1><p>Version ${guide.version}</p></main><footer>Local protocol fixture</footer></body></html>`
        : '<!doctype html><html lang="en"><head><title>Capture source fixture</title><link rel="icon" href="data:,"></head><body><main><h1>Workflow fixture</h1><label>Email <input id="email" type="email" style="width:220px;height:32px"></label><button id="one">Open settings</button><button id="two">Apply settings</button></main></body></html>',
    )
    return
  }
  audit.push({
    path: url.pathname,
    auth: req.headers.authorization,
    cookie: req.headers.cookie,
    referrer: req.headers.referer,
  })
  const api = url.pathname.replace('/workspace/api/v1/', '')
  if (api === 'health') {
    assert(!req.headers.authorization && !req.headers.cookie)
    return send({
      target: 'node-postgres',
      version: 'fixture',
      schema: 'stepdoc/guide@1',
      capabilities: { maxUploadBytes: 64 * 1024 * 1024 },
    })
  }
  if (api === 'pairing/claim') {
    let text = ''
    for await (const part of req) text += part
    const claim = JSON.parse(text)
    assert.equal(claim.extensionId, extensionId)
    assert.equal(claim.code, 'K7Q-4MX')
    assert(!req.headers.authorization && !req.headers.cookie)
    return send(
      {
        id: 'native-device',
        token: credential,
        scopes: ['capture:write', 'guides:read'],
      },
      201,
    )
  }
  if (req.headers.authorization !== `Bearer ${credential}`) return send({}, 401)
  assert(
    !req.headers.cookie && !req.headers.referer,
    'Capture credential request leaked cookie/referrer',
  )
  if (mode === 'revoked')
    return send({ error: { message: 'PRIVATE_SERVER_ERROR' } }, 401)
  if (req.method !== 'GET' && api !== 'sessions') {
    genericWrites++
    return send({}, 403)
  }
  if (api === 'guides')
    return send({
      items: [...guides.values()].map((doc) => ({
        id: doc.id,
        title: doc.title,
        stepCount: doc.steps.length,
        status: doc.status,
        openRedactions: 0,
        verification: 'never-run',
        collectionId: null,
        thumb: null,
        updatedAt: doc.updatedAt,
      })),
      nextCursor: null,
    })
  if (api.startsWith('guides/'))
    return guides.has(api.slice(7))
      ? send(guides.get(api.slice(7)))
      : send({}, 404)
  if (api === 'sessions' && req.method === 'POST') {
    let text = ''
    for await (const part of req) text += part
    for (const value of [
      'PRIVATE_TYPED_NEVER_CAPTURED',
      'PRIVATE_QUERY',
      'PRIVATE_FRAGMENT',
      credential,
    ])
      assert(!text.includes(value), 'Private value in capture JSON')
    const doc = JSON.parse(text)
    assert.equal(doc.schema, 'stepdoc/guide@1')
    assert.equal(doc.status, 'draft')
    assert.equal(doc.version, 1)
    assert(!guides.has(doc.id), 'Retry posted the same capture twice')
    posts.push(structuredClone(doc))
    for (const step of doc.steps)
      if (step.screenshot) {
        for (const kind of ['original', 'rendered'])
          if (step.screenshot[kind]) {
            const match = /^data:(image\/(?:png|webp));base64,(.*)$/.exec(
              step.screenshot[kind],
            )
            assert(match)
            const key = `capture/${doc.id}/${step.id}/${kind}`
            blobs.set(key, Buffer.from(match[2], 'base64'))
            step.screenshot[kind] = key
          }
      }
    guides.set(doc.id, doc)
    if (mode === 'hold') return
    if (mode === 'drop') {
      drops++
      // Send response headers before cutting the acknowledgement short. A socket
      // closed before any response can be replayed transparently by Chromium.
      res.writeHead(201, { 'content-type': 'application/json' })
      res.write('{"guide":', () => res.destroy())
      return
    }
    return send({ guide: doc, editUrl: `/workspace/g/${doc.id}/edit` }, 201)
  }
  return send({}, 404)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const snapshots = new URL('../tests/destination/', import.meta.url)
const screens = new URL(
  update ? '../../../docs/v2/screens/' : '../../../test-results/screens/',
  import.meta.url,
)
await mkdir(snapshots, { recursive: true })
await mkdir(screens, { recursive: true })
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
  await context.addCookies([
    {
      name: 'sd_session',
      value: 'fixture-owner',
      url: base,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  const worker = await extensionWorker(context)
  extensionId = new URL(worker.url()).host
  const origin = `chrome-extension://${extensionId}`,
    failures = []
  context.on('page', (page) => {
    page.on('pageerror', () => failures.push('Page runtime error'))
    page.on('request', (request) => {
      if (
        ![base, origin, 'data:', 'blob:'].some((prefix) =>
          request.url().startsWith(prefix),
        )
      )
        failures.push('Nonlocal request')
    })
  })
  const source = await context.newPage()
  const sourceSession = await context.newCDPSession(source),
    worlds = []
  sourceSession.on('Runtime.executionContextCreated', ({ context }) =>
    worlds.push(context),
  )
  sourceSession.on('Runtime.executionContextsCleared', () => {
    worlds.length = 0
  })
  sourceSession.on(
    'Runtime.executionContextDestroyed',
    ({ executionContextId }) => {
      const index = worlds.findIndex((world) => world.id === executionContextId)
      if (index !== -1) worlds.splice(index, 1)
    },
  )
  await sourceSession.send('Runtime.enable')
  await source.goto(`${base}/source?PRIVATE_QUERY#PRIVATE_FRAGMENT`)
  const sourceTab = await worker.evaluate(
    async (base) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(base)),
    base,
  )
  const panel = await context.newPage()
  await panel.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('root').style.width = '400px'
    }),
  )
  await panel.goto(`${origin}/sidepanel.html?view=pair`)
  const hook = (name) => panel.locator(`[data-sd="${name}"]`)
  const state = () => worker.evaluate(() => chrome.storage.local.get(null))
  const message = (type, extra = {}) =>
    panel.evaluate(
      ({ type, extra }) => chrome.runtime.sendMessage({ type, ...extra }),
      { type, extra },
    )
  const waitPhase = (phase) =>
    expect
      .poll(async () => (await state()).captureReview?.phase, {
        timeout: 20_000,
      })
      .toBe(phase)
  const press = async (name) => {
    await expect(hook(name)).toBeEnabled()
    await hook(name).evaluate((button) => button.click())
  }
  async function size(width = 600, height = 900) {
    await source.bringToFront()
    for (let attempt = 0; attempt < 3; attempt++) {
      const box = await source.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        outerWidth,
        outerHeight,
      }))
      if (box.width === width && box.height === height) return
      await worker.evaluate(
        ({ id, width, height }) =>
          chrome.windows.update(id, { width, height, left: 0, top: 0 }),
        {
          id: sourceTab.windowId,
          width: box.outerWidth + width - box.width,
          height: box.outerHeight + height - box.height,
        },
      )
      await source.waitForFunction(
        ({ width, height }) => innerWidth === width && innerHeight === height,
        { width, height },
      )
    }
    throw new Error('Native window size unavailable')
  }
  await size()
  async function inspect(name, page = panel, width = 400, height = 900) {
    await page.bringToFront()
    await page.evaluate(() => document.fonts.ready)
    assert.deepEqual(
      (await new AxeBuilder({ page }).analyze()).violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      [],
      `Axe ${name}`,
    )
    assert(
      await page
        .locator('.capture-panel')
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
      `Panel overflow ${name}`,
    )
    let aria = await page.locator('.capture-panel').ariaSnapshot()
    aria =
      aria
        .replaceAll(base, '<server>')
        .replaceAll(new URL(base).host, '<server-host>')
        .replace(/capture-[a-f0-9-]{36}/g, 'capture-<session>') + '\n'
    const file = new URL(name + '.aria.txt', snapshots)
    if (update) await writeFile(file, aria)
    else
      assert.equal(
        aria,
        (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'),
        `Aria ${name}`,
      )
    await page.screenshot({
      path: fileURLToPath(new URL(`m11-${name}.png`, screens)),
      clip: { x: 0, y: 0, width, height },
    })
  }
  console.log('Pairing through the actual E05 controls')
  await hook('pair-server').fill(`${base}/workspace`)
  await hook('pair-code-1').evaluate((cell) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text', 'K7Q-4MX')
    cell.dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, clipboardData }),
    )
  })
  await hook('pair-submit').click()
  await expect(hook('pair-test')).toBeEnabled()
  await hook('pair-back').click()
  await hook('capture-destination-browser').focus()
  await panel.keyboard.press('ArrowRight')
  await expect(hook('capture-destination-server')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  assert.equal((await state()).captureDestination.kind, 'server')
  await hook('capture-pair').click()
  await expect(hook('pair-test')).toBeEnabled()
  await hook('pair-back').click()
  await expect(hook('capture-destination-server')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await inspect('destination-idle-light')
  const idleGeometry = await panel.evaluate(() => ({
    header: document.querySelector('header').getBoundingClientRect().height,
    track: document.querySelector('.sd-segment-group').getBoundingClientRect()
      .height,
  }))
  assert.deepEqual(idleGeometry, { header: 52, track: 32 })
  const popup = await context.newPage()
  await popup.setViewportSize({ width: 360, height: 560 })
  await popup.goto(`${origin}/popup.html`)
  await expect(
    popup.locator('[data-sd=capture-destination-server]'),
  ).toHaveAttribute('aria-selected', 'true')
  await inspect('destination-popup', popup, 360, 560)
  await popup.close()
  await size()
  let contentWorld
  await expect
    .poll(async () => {
      for (const world of worlds.filter((world) => !world.auxData?.isDefault)) {
        const result = await sourceSession.send('Runtime.evaluate', {
          contextId: world.id,
          expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`,
          returnByValue: true,
        })
        if (result.result.value) {
          contentWorld = world.id
          return true
        }
      }
      return false
    })
    .toBe(true)
  const forged = async (command) =>
    (
      await sourceSession.send('Runtime.evaluate', {
        contextId: contentWorld,
        expression: `chrome.runtime.sendMessage(${JSON.stringify(command)})`,
        awaitPromise: true,
        returnByValue: true,
      })
    ).result.value
  for (const type of [
    'SET_CAPTURE_DESTINATION',
    'SAVE_CAPTURE',
    'CAPTURE_SERVER_RECENT',
    'CANCEL',
  ])
    assert.equal(
      (await forged({ type, destination: (await state()).captureDestination }))
        .ok,
      false,
      `Source-world ${type}`,
    )
  async function record(title) {
    await source.bringToFront()
    await worker.evaluate(async ({ id, windowId }) => {
      await chrome.windows.update(windowId, { focused: true })
      await chrome.tabs.update(id, { active: true })
    }, sourceTab)
    await source.locator('#email').fill('')
    await press('capture-start')
    await waitPhase('recording')
    await source.locator('#email').fill('PRIVATE_TYPED_NEVER_CAPTURED')
    await source.locator('#one').click()
    await expect
      .poll(async () => (await state()).capturedSteps?.length, {
        timeout: 20_000,
      })
      .toBe(2)
    await press('capture-review')
    await waitPhase('review')
    await panel.getByRole('textbox', { name: 'Guide title' }).fill(title)
    const value = await state()
    assert.equal(value.captureReview.destination.kind, 'server')
    assert.deepEqual(
      value.capturedSteps.map((step) => step.action),
      ['fill', 'click'],
      'A typed field precedes its subsequent pointer action',
    )
    assert(!JSON.stringify(value).includes('PRIVATE_TYPED_NEVER_CAPTURED'))
    assert(!JSON.stringify(value).includes('PRIVATE_QUERY'))
    assert(value.capturedSteps.some((step) => step.value?.kind === 'secret'))
    return value
  }
  console.log('Saving a real paired capture and opening its server editor')
  const before = await record('Paired workflow')
  await panel.locator('[data-sd=capture-destination]').selectOption('browser')
  await panel.locator('[data-sd=capture-destination]').selectOption('server')
  await inspect('destination-review-light')
  const glyph = panel.locator('[data-asset=capture-destination-chevron]')
  assert.deepEqual(
    await glyph.evaluate((el) => ({
      width: el.offsetWidth,
      height: el.offsetHeight,
    })),
    { width: 12, height: 12 },
  )
  const svgRoot = (
    await readFile(
      new URL('../../../packages/ui/assets/9e248.svg', import.meta.url),
      'utf8',
    )
  ).match(/<svg\b[^>]*>/)[0]
  assert(/width="12"/.test(svgRoot) && /height="12"/.test(svgRoot))
  const glyphBox = await glyph.boundingBox(),
    png = (await panel.screenshot()).toString('base64')
  assert(
    await panel.evaluate(
      async ({ png, box }) => {
        const image = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${png}`)).blob(),
        )
        const canvas = new OffscreenCanvas(image.width, image.height),
          ctx = canvas.getContext('2d')
        ctx.drawImage(image, 0, 0)
        image.close()
        const data = ctx.getImageData(box.x, box.y, box.width, box.height).data,
          colors = new Set()
        for (let i = 0; i < data.length; i += 4)
          colors.add(data.slice(i, i + 3).join(','))
        return colors.size > 1
      },
      { png, box: glyphBox },
    ),
    'Original destination chevron paints',
  )
  await panel.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await inspect('destination-review-dark')
  await panel.evaluate(() => {
    document.documentElement.dataset.theme = 'light'
    document.getElementById('root').style.width = '320px'
  })
  await inspect('destination-review-narrow', panel, 320)
  await panel.evaluate(() => {
    document.getElementById('root').style.width = '400px'
  })
  const opened = context.waitForEvent('page')
  await press('capture-save')
  const editor = await opened
  await editor.waitForLoadState()
  await expect(
    editor.getByRole('heading', { name: 'Paired workflow' }),
  ).toBeVisible()
  await waitPhase('idle')
  assert.equal(posts.length, 1)
  assert.equal(
    editor.url(),
    `${base}/workspace/g/capture-${before.captureSessionId}/edit`,
  )
  await expect(hook('capture-recent')).toHaveAttribute('href', editor.url())
  await expect(
    panel.getByRole('link', { name: 'Open library', exact: true }),
  ).toHaveAttribute('href', `${base}/workspace/`)
  for (const [i, step] of posts[0].steps.entries())
    assert.equal(
      step.screenshot.original,
      before.steps[i].screenshot,
      'Upload source is the retained already-redacted frame',
    )
  assert(
    guides
      .get(posts[0].id)
      .steps.some((step) =>
        step.redactions.some((redaction) => redaction.status === 'applied'),
      ),
  )
  assert([...blobs.values()].every((bytes) => bytes.length > 0))
  await editor.close()
  const recentOpened = context.waitForEvent('page')
  await hook('capture-recent').click()
  const recentEditor = await recentOpened
  await recentEditor.waitForLoadState()
  await expect(
    recentEditor.getByRole('heading', { name: 'Paired workflow' }),
  ).toBeVisible()
  assert.equal(recentEditor.url(), `${base}/workspace/g/${posts[0].id}/edit`)
  await recentEditor.close()
  console.log(
    'Recovering an unacknowledged commit without overwriting a later server edit',
  )
  const second = await record('Retained paired workflow')
  mode = 'drop'
  await press('capture-save')
  await waitPhase('review')
  await expect(panel.getByRole('status')).toContainText(
    'Your review is retained',
  )
  await expect(
    panel.getByText('Server save is unconfirmed.', { exact: false }),
  ).toBeVisible()
  await expect(
    panel.getByRole('textbox', { name: 'Guide title' }),
  ).toBeDisabled()
  await expect(panel.locator('[data-sd=capture-destination]')).toBeDisabled()
  await expect(hook('capture-keep-local')).toBeEnabled()
  assert((await state()).captureReview.remoteAttempt)
  assert.equal(drops, 1)
  await inspect('destination-retained')
  const secondId = `capture-${second.captureSessionId}`
  guides.get(secondId).version = 2
  guides.get(secondId).title = 'Edited on the server'
  mode = 'ok'
  await worker.evaluate(() => {
    globalThis.originalDestinationCreate = chrome.tabs.create
    chrome.tabs.create = async () => {
      throw new Error('PRIVATE_TAB_FAILURE')
    }
  })
  await press('capture-save')
  await waitPhase('review')
  await expect(panel.getByRole('status')).toContainText('The guide is saved')
  assert.equal((await state()).captureReview.remoteSaved.id, secondId)
  await expect(
    panel.getByText('Saved on the server.', { exact: false }),
  ).toBeVisible()
  assert.equal(posts.length, 2)
  await inspect('destination-editor-retry')
  const metadata = await state()
  for (const value of [
    credential,
    'PRIVATE_TAB_FAILURE',
    'PRIVATE_SERVER_ERROR',
  ])
    assert(
      !JSON.stringify(metadata).includes(value),
      'Secret/native error in retained state',
    )
  await worker.evaluate(() => {
    chrome.tabs.create = globalThis.originalDestinationCreate
    delete globalThis.originalDestinationCreate
  })
  const reopened = context.waitForEvent('page')
  await press('capture-save')
  const recoveredEditor = await reopened
  await recoveredEditor.waitForLoadState()
  await expect(
    recoveredEditor.getByRole('heading', { name: 'Edited on the server' }),
  ).toBeVisible()
  await waitPhase('idle')
  assert.equal(posts.length, 2)
  await recoveredEditor.close()
  console.log('Cancelling an in-flight save without restoring its old review')
  const cancelled = await record('Cancelled server save')
  mode = 'hold'
  await press('capture-save')
  await expect.poll(() => posts.length).toBe(3)
  assert.equal(posts[2].id, `capture-${cancelled.captureSessionId}`)
  assert.equal((await message('CANCEL')).ok, true)
  await waitPhase('idle')
  await expect(hook('capture-start')).toBeEnabled()
  assert.deepEqual((await state()).capturedSteps, [])
  console.log(
    'Keeping a revoked-server capture local, even with an unavailable credential store',
  )
  const third = await record('Local recovery')
  mode = 'revoked'
  await press('capture-save')
  await waitPhase('review')
  await expect(panel.getByRole('status')).toContainText(
    'no longer has server access',
  )
  assert.equal((await state()).captureReview.remoteAttempt, undefined)
  await expect(panel.locator('[data-sd=capture-destination]')).toBeEnabled()
  await inspect('destination-revoked')
  await panel.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('stepdoc-connections-v1', 1)
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction('state', 'readwrite')
          tx.objectStore('state').put({ broken: true }, 'current')
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onabort = reject
        }
      }),
  )
  await press('capture-keep-local')
  await waitPhase('idle')
  assert.equal(posts.length, 3)
  await hook('capture-destination-browser').click()
  await expect(hook('capture-destination-browser')).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const local = await context.newPage()
  await local.goto(
    `${origin}/app.html?route=${encodeURIComponent(`/g/capture-${third.captureSessionId}/edit?step=1`)}`,
  )
  await expect(
    local.getByRole('heading', { name: 'Local recovery', exact: true }),
  ).toBeVisible()
  await local.reload()
  await expect(
    local.getByRole('heading', { name: 'Local recovery', exact: true }),
  ).toBeVisible()
  assert.equal(genericWrites, 0, 'Capture used a generic guide write endpoint')
  assert.equal(posts.length, 3)
  assert(
    audit
      .filter((request) => request.auth)
      .every((request) => !request.cookie && !request.referrer),
  )
  assert.deepEqual(failures, [])
  console.log(
    'Native paired capture verified: actual E05 pairing; E01/E04/E06 destination controls; trusted capture and retained redacted bytes; scoped upload/server editor; unknown-commit retry preserving a newer revision; durable editor retry; revoked/private-store failure → native local recovery; source-world denial; light/dark/narrow aria/axe and original chevron pixels. No live server used.',
  )
} finally {
  await context?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

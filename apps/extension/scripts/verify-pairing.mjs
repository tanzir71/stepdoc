import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { extensionWorker } from './extension-worker.mjs'

// Local protocol fixture; this is not a shipped server or a contract-suite substitute.
const credential = 'sd_native_private_pairing_fixture'
const health = {
  target: 'node-postgres',
  version: 'fixture',
  schema: 'stepdoc/guide@1',
  capabilities: { maxUploadBytes: 1000 },
}
const codes = new Set(['K7Q-4MX', 'R3P-8ND', 'L8T-6WX'])
const audit = [],
  claims = [],
  held = []
let extensionId,
  readStatus = 200,
  hold = false
const server = createServer(async (req, res) => {
  const send = (value, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  if (!req.url.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(
      '<!doctype html><html lang="en"><head><title>Pairing source fixture</title><link rel="icon" href="data:,"></head><body><main><h1>Source page</h1><button>Continue</button></main></body></html>',
    )
    return
  }
  audit.push({
    path: req.url,
    auth: req.headers.authorization,
    cookie: req.headers.cookie,
    referrer: req.headers.referer,
    origin: req.headers.origin,
  })
  if (req.url === '/api/v1/health') return send(health)
  if (req.url === '/api/v1/pairing/claim') {
    let body = ''
    for await (const chunk of req) body += chunk
    const data = JSON.parse(body)
    claims.push(data)
    if (data.extensionId !== extensionId || !codes.delete(data.code))
      return send(
        { error: { code: 'invalid_code', message: 'PRIVATE_SERVER_ERROR' } },
        400,
      )
    const reply = () =>
      send(
        {
          id: 'fixture-device',
          token: credential,
          scopes: ['capture:write', 'guides:read'],
        },
        201,
      )
    if (hold) held.push(reply)
    else reply()
    return
  }
  if (req.url.startsWith('/api/v1/guides')) {
    if (req.headers.authorization !== `Bearer ${credential}`)
      return send({}, 401)
    return send(
      readStatus === 200
        ? { items: [], nextCursor: null }
        : { error: { code: 'revoked', message: 'PRIVATE_SERVER_ERROR' } },
      readStatus,
    )
  }
  send({}, 404)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const snapshots = new URL('../tests/pairing/', import.meta.url)
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
    args: [
      '--disable-gpu',
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
    ],
  })
  const worker = await extensionWorker(context)
  extensionId = new URL(worker.url()).host
  const origin = `chrome-extension://${extensionId}`
  const failures = []
  context.on('page', (page) => {
    page.on('pageerror', () => failures.push('Private page runtime error'))
    page.on('request', (req) => {
      if (
        ![origin, base, 'data:', 'blob:'].some((prefix) =>
          req.url().startsWith(prefix),
        )
      )
        failures.push('Nonlocal request')
    })
  })
  const panel = await context.newPage()
  await panel.addInitScript(() => {
    globalThis.pairEvents = []
    document.addEventListener('DOMContentLoaded', () => {
      chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'PAIR_STATE' || message.type === 'CONTENT_STATE')
          globalThis.pairEvents.push(message)
      })
    })
  })
  await panel.setViewportSize({ width: 400, height: 900 })
  await panel.goto(`${origin}/sidepanel.html?view=pair`)
  const hook = (name) => panel.locator(`[data-sd="${name}"]`)
  const message = (command) =>
    panel.evaluate((command) => chrome.runtime.sendMessage(command), command)
  const state = async () => (await message({ type: 'PAIR_STATUS' })).state
  await expect(hook('pair-server')).toBeEnabled()
  async function inspect(name) {
    await panel.evaluate(() => document.fonts.ready)
    assert.deepEqual(
      (await new AxeBuilder({ page: panel }).analyze()).violations.map((v) => ({
        id: v.id,
        targets: v.nodes.map((n) => n.target),
      })),
      [],
      `Axe ${name}`,
    )
    assert(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `Overflow ${name}`,
    )
    const aria =
      (await panel.locator('.pair-panel').ariaSnapshot()).replaceAll(
        base,
        '<server>',
      ) + '\n'
    const path = new URL(`${name}.aria.txt`, snapshots)
    if (update) await writeFile(path, aria)
    else
      assert.equal(
        aria,
        (await readFile(path, 'utf8')).replaceAll('\r\n', '\n'),
        `Aria ${name}`,
      )
  }
  await hook('pair-server').fill('https://ops.northwind.example')
  console.log('Inspecting E05 form and original assets')
  // Whole-code paste uses the actual React input event; no production test hook.
  async function fillCode(value) {
    await hook('pair-code-1').evaluate((cell, value) => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text', value)
      cell.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, clipboardData }),
      )
    }, value)
    await expect(hook('pair-code-6')).toBeFocused()
  }
  await fillCode('k7q-4mx')
  await hook('pair-code-6').press('ArrowLeft')
  await expect(hook('pair-code-5')).toBeFocused()
  await hook('pair-code-5').press('ArrowRight')
  await expect(hook('pair-code-6')).toBeFocused()
  const geometry = await panel.evaluate(() => {
    const box = (selector) => {
      const r = document.querySelector(selector).getBoundingClientRect()
      return { x: r.x, y: r.y, width: r.width, height: r.height }
    }
    return {
      header: box('header'),
      heading: box('h1'),
      code: box('[data-sd=pair-code-1]'),
      submit: box('[data-sd=pair-submit]'),
      local: box('.pair-local'),
      notice: box('.pair-token'),
      assets: [...document.querySelectorAll('[data-asset]')].map((el) => ({
        name: el.dataset.asset,
        width: el.offsetWidth,
        height: el.offsetHeight,
      })),
    }
  })
  assert.equal(geometry.header.height, 52)
  assert.deepEqual(geometry.heading, { x: 16, y: 76, width: 368, height: 28 })
  assert.deepEqual(geometry.code, { x: 16, y: 268, width: 44, height: 52 })
  assert.equal(geometry.submit.y, 338)
  assert.deepEqual(geometry.local, { x: 16, y: 430, width: 368, height: 132 })
  assert.deepEqual(geometry.notice, { x: 16, y: 580, width: 368, height: 64 })
  for (const [name, size] of [
    ['sliders', 16],
    ['pair-link', 16],
    ['pair-monitor', 18],
    ['pair-local', 14],
    ['pair-lock', 14],
  ])
    assert(
      geometry.assets.some(
        (asset) =>
          asset.name === name && asset.width === size && asset.height === size,
      ),
      `Original asset dimensions: ${name}`,
    )
  const pixels = (await panel.screenshot()).toString('base64')
  const painted = await panel.evaluate(async (pixels) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${pixels}`)).blob(),
    )
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
      ctx = canvas.getContext('2d')
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return [...document.querySelectorAll('[data-asset],.sd-logo img')]
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => {
        const r = el.getBoundingClientRect(),
          data = ctx.getImageData(r.x, r.y, r.width, r.height).data,
          colors = new Set()
        for (let i = 0; i < data.length; i += 4)
          colors.add(data.slice(i, i + 3).join(','))
        return colors.size > 1
      })
  }, pixels)
  assert.equal(painted.length, 6)
  assert(painted.every(Boolean), 'Every original E05 asset paints')
  await inspect('pair-form')
  for (const theme of ['light', 'dark']) {
    await panel.evaluate(
      (theme) =>
        localStorage.setItem(
          'stepdoc.preferences.v1',
          JSON.stringify({ version: 1, theme, collapsed: false }),
        ),
      theme,
    )
    await panel.reload()
    await expect(panel.locator('html')).toHaveAttribute('data-theme', theme)
    await hook('pair-server').fill('https://ops.northwind.example')
    await fillCode('K7Q-4MX')
    await inspect('pair-form')
    await panel.screenshot({
      path: fileURLToPath(new URL(`m11-pair-${theme}.png`, screens)),
    })
  }
  await panel.setViewportSize({ width: 320, height: 700 })
  await inspect('pair-narrow')
  await panel.setViewportSize({ width: 400, height: 900 })
  await hook('pair-server').fill(base)
  console.log('Checking private claim, reopen and connection recovery')
  await hook('pair-submit').click()
  await expect(hook('pair-test')).toBeEnabled()
  assert.equal((await state()).connection.status, 'paired')
  assert.equal(claims.length, 1)
  assert.deepEqual(Object.keys(claims[0]).sort(), [
    'code',
    'deviceName',
    'extensionId',
  ])
  assert.equal(claims[0].extensionId, extensionId)
  assert.equal(claims[0].deviceName, 'StepDoc chrome')
  await panel.reload()
  await expect(hook('pair-test')).toBeEnabled()
  assert.equal(
    (await state()).connection.status,
    'paired',
    'Private IDB survives reopening the controls',
  )
  await hook('pair-test').click()
  await expect(hook('pair-status')).toHaveText('Connection checked.')
  assert.equal((await state()).connection.status, 'ready')
  await inspect('pair-connected')
  assert.equal(
    await hook('pair-devices').getAttribute('href'),
    `${base}/settings/devices`,
  )
  await expect(hook('pair-devices')).toHaveAttribute(
    'referrerpolicy',
    'no-referrer',
  )
  readStatus = 401
  await hook('pair-test').click()
  await expect(hook('pair-status')).toContainText('no longer has server access')
  assert.equal((await state()).connection.status, 'revoked')
  await inspect('pair-revoked')
  readStatus = 503
  await hook('pair-test').click()
  await expect(hook('pair-status')).toContainText('could not be reached')
  assert.equal((await state()).connection.status, 'unavailable')
  readStatus = 200
  await hook('pair-test').click()
  await expect(hook('pair-status')).toHaveText('Connection checked.')

  // Private-origin IDB inspection proves persistence without returning a credential.
  console.log('Checking private vault and public projections')
  async function vault(action) {
    return worker.evaluate(
      async ({ action, credential }) => {
        const db = await new Promise((resolve, reject) => {
          const open = indexedDB.open('stepdoc-connections-v1')
          open.onsuccess = () => resolve(open.result)
          open.onerror = reject
        })
        try {
          return await new Promise((resolve, reject) => {
            const tx = db.transaction(
                'state',
                action === 'read' ? 'readonly' : 'readwrite',
              ),
              store = tx.objectStore('state'),
              get = store.get('current')
            let result
            get.onsuccess = () => {
              const value = get.result
              result = {
                private: value?.connection?.token === credential,
                generation: value?.generation,
                connection: !!value?.connection,
              }
              if (action === 'corrupt')
                store.put({ version: 999, token: credential }, 'current')
              if (action === 'race')
                store.put(
                  { ...value, generation: crypto.randomUUID() },
                  'current',
                )
            }
            tx.oncomplete = () => resolve(result)
            tx.onabort = reject
          })
        } finally {
          db.close()
        }
      },
      { action, credential },
    )
  }
  assert(
    (await vault('read')).private,
    'Credential remains private after read failures',
  )
  const leaked = JSON.stringify([
    await state(),
    await message({ type: 'GET_STATE' }),
    await message({ type: 'CONTENT_STATE' }),
    await worker.evaluate(() => chrome.storage.local.get(null)),
    await panel.evaluate(() => globalThis.pairEvents),
  ])
  assert(
    await panel.evaluate(() =>
      globalThis.pairEvents.some((message) => message.type === 'PAIR_STATE'),
    ),
    'Actual private state broadcasts are observed after reload',
  )
  for (const value of [credential, 'K7Q-4MX', 'PRIVATE_SERVER_ERROR'])
    assert(
      !leaked.includes(value),
      'Public state/storage/events contain no credential, code or server error',
    )

  // Exercise actual source content-world authorization and origin-scoped IDB.
  console.log('Checking source-world command and database isolation')
  const source = await context.newPage(),
    session = await context.newCDPSession(source),
    worlds = []
  session.on('Runtime.executionContextCreated', ({ context }) =>
    worlds.push(context),
  )
  session.on('Runtime.executionContextsCleared', () => {
    worlds.length = 0
  })
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    const index = worlds.findIndex((world) => world.id === executionContextId)
    if (index !== -1) worlds.splice(index, 1)
  })
  await session.send('Runtime.enable')
  await source.goto(`${base}/source`)
  let contentWorld
  await expect
    .poll(async () => {
      for (const world of worlds.filter((world) => !world.auxData?.isDefault)) {
        const result = await session.send('Runtime.evaluate', {
          contextId: world.id,
          expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`,
          returnByValue: true,
        })
        if (result.result.value) contentWorld = world.id
      }
      return !!contentWorld
    })
    .toBe(true)
  const sourceEval = async (expression) => {
    const result = await session.send('Runtime.evaluate', {
      contextId: contentWorld,
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    assert(!result.exceptionDetails, 'Content-world evaluation succeeds')
    return result.result.value
  }
  for (const type of [
    'PAIR_STATUS',
    'PAIR_CONNECT',
    'PAIR_TEST',
    'PAIR_CANCEL',
    'PAIR_FORGET',
  ])
    assert.deepEqual(
      await sourceEval(
        `chrome.runtime.sendMessage(${JSON.stringify({ type })})`,
      ),
      { ok: false, error: 'forbidden' },
      `Reject source ${type}`,
    )
  assert.equal(
    await sourceEval(
      `new Promise((resolve,reject)=>{const open=indexedDB.open('stepdoc-connections-v1');open.onsuccess=()=>{const db=open.result;const isolated=!db.objectStoreNames.contains('state');db.close();resolve(isolated)};open.onerror=()=>reject(new Error('Host IDB unavailable'))})`,
    ),
    true,
    'Same IDB name in a content script cannot open the private extension vault',
  )
  const sourceState = JSON.stringify([
    await sourceEval('chrome.runtime.sendMessage({type:"GET_STATE"})'),
    await sourceEval('chrome.runtime.sendMessage({type:"CONTENT_STATE"})'),
  ])
  assert(!sourceState.includes(credential))
  const forged = await state()
  console.log('Checking source-world forged broadcast')
  forged.sequence += 1000
  forged.connection.server = 'https://forged.example/api/v1/'
  await sourceEval(
    `(()=>{void chrome.runtime.sendMessage(${JSON.stringify({ type: 'PAIR_STATE', state: forged })}).catch(()=>{});return true})()`,
  )
  await expect
    .poll(() =>
      panel.evaluate(() =>
        globalThis.pairEvents.some(
          (message) =>
            message.state?.connection?.server ===
            'https://forged.example/api/v1/',
        ),
      ),
    )
    .toBe(true)
  await expect(panel.locator('.pair-server-name')).toHaveText(`${base}/api/v1/`)
  assert(
    !(await panel
      .locator('body')
      .textContent()
      .then((text) => text.includes(credential))),
    'Private credential never appears in UI text',
  )

  await hook('pair-forget').click()
  console.log('Checking Forget dialog, one-use code and cancellation')
  await expect(panel.getByRole('dialog')).toBeVisible()
  await inspect('pair-forget-dialog')
  await panel.keyboard.press('Escape')
  await expect(panel.getByRole('dialog')).toHaveCount(0)
  assert((await vault('read')).private)
  await hook('pair-forget').click()
  await hook('pair-forget-confirm').click()
  await expect(hook('pair-server')).toBeVisible()
  assert.equal((await vault('read')).connection, false)
  await hook('pair-server').fill(base)
  await fillCode('K7Q-4MX')
  await hook('pair-submit').click()
  await expect(hook('pair-status')).toContainText('code could not be used')
  for (let i = 1; i <= 6; i++)
    await expect(hook(`pair-code-${i}`)).toHaveValue('')

  hold = true
  const peer = await context.newPage()
  await peer.goto(`${origin}/sidepanel.html?view=pair`)
  await expect(peer.locator('[data-sd=pair-server]')).toBeEnabled()
  await fillCode('R3P-8ND')
  await hook('pair-submit').click()
  await expect.poll(() => held.length).toBe(1)
  await expect(peer.locator('[data-sd=pair-cancel]')).toBeVisible()
  await expect(peer.locator('[data-sd=pair-server]')).toBeDisabled()
  const pending = await state()
  assert.equal(pending.pending.kind, 'connect')
  assert.equal(
    (await message({ type: 'START_CAPTURE' })).ok,
    false,
    'Pairing blocks capture start',
  )
  assert.equal(
    (await message({ type: 'GUIDE_START', id: 'not-loaded' })).ok,
    false,
    'Pairing blocks walkthrough start',
  )
  await hook('pair-cancel').click()
  await expect(hook('pair-status')).toContainText('Stopped pairing')
  await expect(peer.locator('[data-sd=pair-server]')).toBeEnabled()
  await peer.close()
  held.shift()()
  await expect.poll(async () => (await state()).pending).toBeNull()
  assert.equal(
    (await vault('read')).connection,
    false,
    'Late response cannot persist a cancelled credential',
  )
  hold = false
  await fillCode('L8T-6WX')
  await hook('pair-submit').click()
  await expect(hook('pair-test')).toBeEnabled()
  const old = await state()
  console.log('Checking generation conflicts and corrupt-store recovery')
  await vault('race')
  assert.deepEqual(
    await message({ type: 'PAIR_FORGET', expectedGeneration: old.generation }),
    { ok: false, error: 'conflict' },
  )
  assert(
    (await vault('read')).private,
    'Stale window cannot forget a newer credential',
  )
  await vault('corrupt')
  await panel.reload()
  await expect(hook('pair-retry')).toBeVisible()
  assert.equal((await state()).generation, null)
  await hook('pair-forget').click()
  await hook('pair-forget-confirm').click()
  await expect(hook('pair-submit')).toBeVisible()
  assert.equal(
    (await state()).connection,
    null,
    'Corrupt vault can be reset locally',
  )
  assert.deepEqual(
    await message({ type: 'PAIR_FORGET', expectedGeneration: null }),
    { ok: false, error: 'conflict' },
    'Corrupt recovery cannot overwrite a new valid generation',
  )
  // A real v1 start is held before camera collection, proving the reverse race.
  await worker.evaluate(() => {
    const query = chrome.tabs.query.bind(chrome.tabs)
    globalThis.restorePairQuery = () => {
      chrome.tabs.query = query
    }
    chrome.tabs.query = () =>
      new Promise((_resolve, reject) => {
        globalThis.rejectPairQuery = () => {
          globalThis.restorePairQuery()
          reject(new Error('Fixture start unavailable'))
        }
      })
  })
  await panel.evaluate(() => {
    globalThis.blockedCaptureStart = chrome.runtime.sendMessage({
      type: 'START',
    })
  })
  await expect
    .poll(() =>
      worker.evaluate(() => typeof globalThis.rejectPairQuery === 'function'),
    )
    .toBe(true)
  assert.deepEqual(
    await message({
      type: 'PAIR_CONNECT',
      attemptId: randomUUID(),
      expectedGeneration: (await state()).generation,
      server: base,
      code: 'NEW-123',
    }),
    { ok: false, error: 'busy' },
  )
  await worker.evaluate(() => globalThis.rejectPairQuery())
  assert.equal(
    (await panel.evaluate(() => globalThis.blockedCaptureStart)).ok,
    false,
  )
  // Review-phase guard without invoking any camera or remote upload.
  await worker.evaluate(() =>
    chrome.storage.local.set({ captureReview: { phase: 'review' } }),
  )
  assert.deepEqual(
    await message({
      type: 'PAIR_CONNECT',
      attemptId: randomUUID(),
      expectedGeneration: (await state()).generation,
      server: base,
      code: 'NEW-123',
    }),
    { ok: false, error: 'busy' },
  )
  await worker.evaluate(() => chrome.storage.local.remove('captureReview'))
  await panel.goto(`${origin}/sidepanel.html?view=pair`)
  await hook('pair-local').click()
  await expect(panel).toHaveURL(/view=idle/)
  await hook('capture-pair').click()
  await expect(panel).toHaveURL(/view=pair/)
  await hook('pair-back').click()
  await expect(panel).toHaveURL(/view=idle/)

  // The compact entry opens a private full-tab E05 instead of squeezing the form.
  console.log('Checking local and compact full-tab navigation')
  await panel.goto(`${origin}/popup.html`)
  const opened = context.waitForEvent('page')
  await hook('capture-pair').click()
  const full = await opened
  await expect(full).toHaveURL(/popup.html\?surface=tab&view=pair/)
  await expect(full.locator('[data-sd=pair-server]')).toBeVisible()
  assert.equal(
    await full.locator('.pair-panel').getAttribute('data-full-tab'),
    'true',
  )
  for (const request of audit) {
    assert.equal(
      request.cookie,
      undefined,
      'Pairing/bearer HTTP sends no cookies',
    )
    assert.equal(request.referrer, undefined, 'No private page referrer')
    if (request.origin)
      assert.equal(request.origin, origin, 'Actual extension origin')
    if (!request.path.startsWith('/api/v1/guides'))
      assert.equal(
        request.auth,
        undefined,
        'Health/code exchange remains anonymous',
      )
  }
  assert.deepEqual(failures, [])
  console.log(
    'Native E05 verified: exact Figma geometry/original painted assets; light/dark/narrow/dialog axe and trees; keyboard/paste; actual health/claim/read; private IDB reopen, content-world isolation and sender rejection; revoked/unavailable recovery, immediate cancel/late reply, generation conflicts, corrupt-store reset and local/full-tab navigation. No capture upload or live server used.',
  )
} finally {
  await context?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

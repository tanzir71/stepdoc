import { extensionWorker } from './extension-worker.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { readFile, readdir, stat } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const output = new URL('../.output/', import.meta.url)
const defaultGpu = process.argv.includes('--default-gpu')
for (const target of ['chrome', 'edge', 'firefox']) {
  const dir = new URL(`${target}-mv3/`, output)
  const manifest = JSON.parse(
    await readFile(new URL('manifest.json', dir), 'utf8'),
  )
  assert.equal(manifest.manifest_version, 3)
  assert(
    !manifest.permissions.includes('offscreen'),
    'Unused permission retained',
  )
  assert(!manifest.content_security_policy, 'Default extension CSP weakened')
  assert.deepEqual(
    manifest.web_accessible_resources,
    [
      {
        resources: [
          'assets/418d0-*.svg',
          'assets/0e7f2-*.svg',
          'assets/f9a9e-*.svg',
          'assets/36d61-*.svg',
          'assets/cf8f1-*.svg',
        ],
        matches: ['<all_urls>'],
      },
    ],
    'Only the five original walkthrough/pill glyphs may be public; app resources remain private',
  )
  assert.equal(manifest.content_scripts[0].run_at, 'document_start')
  if (target === 'firefox') {
    assert.equal(manifest.action.default_popup, 'popup.html')
    assert.deepEqual(manifest.background.scripts, ['background.js'])
    assert(!manifest.side_panel && !manifest.permissions.includes('sidePanel'))
  } else {
    assert.equal(manifest.side_panel.default_path, 'sidepanel.html')
    assert.equal(manifest.background.service_worker, 'background.js')
    assert(!manifest.action.default_popup)
  }
  const files = (await readdir(dir, { recursive: true })).map((file) =>
    file.replaceAll('\\', '/'),
  )
  assert(files.includes('app.html'))
  assert(files.includes('popup.html'), 'The private fallback page is missing')
  assert(
    !files.some((file) => /fixtures|e2e|\.test\./.test(file)),
    'Test source packaged',
  )
  const assetSource = await readFile(
    new URL('../../../packages/ui/src/assets.ts', import.meta.url),
    'utf8',
  )
  const vectors = [
    ...new Set(
      [
        ...assetSource.matchAll(
          /from ['"]\.\.\/assets\/([^'"]+\.svg)\?url(?:&no-inline)?['"]/g,
        ),
      ].map((match) => match[1]),
    ),
  ]
  assert(vectors.length > 0, 'Source vector inventory missing')
  for (const vector of vectors) {
    const stem = vector.slice(0, -4)
    const built = files.find(
      (file) => file.startsWith(`assets/${stem}-`) && file.endsWith('.svg'),
    )
    assert(built, `Original vector not packaged: ${vector}`)
    assert.deepEqual(
      await readFile(new URL(built, dir)),
      await readFile(
        new URL(`../../../packages/ui/assets/${vector}`, import.meta.url),
      ),
    )
  }
  assert.equal(files.filter((file) => file.endsWith('.woff2')).length, 2)
  assert(
    files.some((file) => /image\.worker-.*\.js$/.test(file)),
    'Image worker missing',
  )
  assert(
    files.some((file) => /worker-.*\.js$/.test(file)),
    'Export worker missing',
  )
  for (const file of files.filter((file) =>
    /\.(js|css|svg|woff2)$/.test(file),
  )) {
    assert((await stat(new URL(file, dir))).size > 0, 'Empty runtime resource')
    if (/\.(js|css)$/.test(file)) {
      const text = await readFile(new URL(file, dir), 'utf8')
      assert(
        !text.includes('figma.com/api/mcp/asset'),
        'Temporary asset URL packaged',
      )
      assert(
        !/new Function\(/.test(text),
        'Dynamic compiler violates extension CSP',
      )
      assert(!/new URL\("\.\/.*\.ts"/.test(text), 'Uncompiled worker packaged')
    }
  }
}

let uploaded
let rejectUpload = false
const server = createServer(async (req, res) => {
  if (req.url === '/api/sessions' && req.method === 'POST') {
    let body = ''
    for await (const chunk of req) body += chunk
    uploaded = JSON.parse(body)
    res.writeHead(rejectUpload ? 503 : 200, {
      'content-type': 'application/json',
    })
    res.end(
      JSON.stringify(
        rejectUpload
          ? { error: 'Local stub unavailable' }
          : { id: 'legacy-capture' },
      ),
    )
    return
  }
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url === '/frame') {
    res.end(
      '<!doctype html><html lang="en"><head><title>Frame fixture</title></head><body><button id="frame-action">Frame action</button></body></html>',
    )
    return
  }
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local capture fixture</title></head><body>
    <main><h1>Capture fixture</h1><label>Password <input type="password" autocomplete="current-password" style="width:200px;height:40px"></label>
    <button id="fixture-save">Save fixture</button>
    <button id="dialog-action" onclick="document.getElementById('confirmation').hidden=false">Open confirmation</button><div id="confirmation" role="dialog" aria-label="Confirm change" hidden></div>
    <label>Project title<input id="project-field" type="text" style="width:240px;height:40px;background:repeating-linear-gradient(90deg,black 0px,black 1px,white 1px,white 2px)"></label>
    <label>Invoice email<input id="email-field" type="email"></label><label>Card number<input id="card-field" autocomplete="cc-number"></label>
    <label>Notes<textarea id="notes-field"></textarea></label><label>Plan<select id="plan-field"><option>Personal plan</option><option>Team plan</option></select></label>
    <div id="capture-host"></div><iframe id="capture-frame" src="/frame" title="Capture frame"></iframe>
    <button id="spa-action" onclick="history.pushState(null,'','/next?private=PRIVATE_QUERY#PRIVATE_FRAGMENT')">Next screen</button>
    </main><script>document.getElementById('capture-host').attachShadow({mode:'open'}).innerHTML='<button id="shadow-action">Shadow action</button>';</script></body></html>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
let context
try {
  const base = `http://127.0.0.1:${server.address().port}`
  const extensionDir = fileURLToPath(new URL('chrome-mv3/', output))
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    downloadsPath: fileURLToPath(
      new URL('../../../test-results/extension-downloads/', import.meta.url),
    ),
    viewport: { width: 1440, height: 900 },
    args: [
      ...(defaultGpu ? [] : ['--disable-gpu']),
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  })
  const browserSession = await context.browser().newBrowserCDPSession()
  const { arguments: startupArguments } = await browserSession.send(
    'Browser.getBrowserCommandLine',
  )
  assert.equal(startupArguments.includes('--disable-gpu'), !defaultGpu)
  const { gpu } = await browserSession.send('SystemInfo.getInfo')
  console.log('Capture rendering configuration', {
    defaultGpu,
    compositing: gpu.featureStatus?.gpu_compositing,
    renderer: gpu.auxAttributes?.glRenderer,
  })
  await browserSession.detach()
  context.setDefaultTimeout(15_000)
  async function openedPage(action) {
    const previous = new Set(context.pages())
    await action()
    // STOP acknowledges after upload/tab creation. Observe its resulting page
    // without leaving an independently rejecting event promise during the action.
    await expect
      .poll(
        () => context.pages().filter((page) => !previous.has(page)).length,
        { timeout: 15_000 },
      )
      .toBe(1)
    return context.pages().find((page) => !previous.has(page))
  }
  const failures = []
  context.on('page', (page) =>
    page.on('pageerror', (error) => failures.push(error.message)),
  )
  const worker = await extensionWorker(context)
  const workerUrl = new URL(worker.url())
  const origin = `${workerUrl.protocol}//${workerUrl.host}`
  assert(
    origin.startsWith('chrome-extension://'),
    'Built service worker did not load',
  )
  // Chromium announces the service worker before its extension API bindings are
  // ready. Keep the behavior assertion, waiting for the actual initialized API.
  await expect
    .poll(
      () => worker.evaluate(() => chrome.sidePanel?.getPanelBehavior() ?? null),
      { timeout: 15_000 },
    )
    .toEqual({ openPanelOnActionClick: true })
  const panel = await context.newPage()
  await panel.goto(`${origin}/sidepanel.html`)
  await expect(
    panel.getByRole('heading', { name: 'StepDoc', exact: true }),
  ).toBeVisible()
  await expect(panel.getByRole('status')).toHaveText('Ready to capture')
  const app = await openedPage(() =>
    panel.getByRole('link', { name: 'Open library' }).click(),
  )
  await app.waitForLoadState()
  assert.equal(app.url(), `${origin}/app.html`)
  app.on('request', (request) => {
    if (
      !request.url().startsWith(origin) &&
      !request.url().startsWith('blob:') &&
      !request.url().startsWith('data:')
    )
      failures.push('Non-local app resource requested')
  })
  app.on('requestfailed', (request) =>
    failures.push(`App resource failed: ${request.url()}`),
  )
  await expect(
    app.getByRole('heading', { name: 'Your library is ready' }),
  ).toBeVisible()
  await app.locator('[data-sd="library-create"]').click()
  await expect(
    app.getByRole('dialog', { name: 'Create a guide' }),
  ).toBeVisible()
  await app.keyboard.press('Escape')
  await expect
    .poll(() => new URL(app.url()).searchParams.get('route'))
    .toBe('/')
  await app.locator('[data-sd="library-create"]').click()
  await app
    .getByRole('textbox', { name: 'Guide title' })
    .fill('Extension origin guide')
  await app
    .getByRole('textbox', { name: 'First instruction' })
    .fill('Open browser settings')
  await app.locator('[data-sd="guide-create-submit"]').click()
  await expect(
    app.getByRole('heading', { name: 'Extension origin guide', exact: true }),
  ).toBeVisible()
  const previewUrl = app.url()
  assert.match(
    new URL(previewUrl).searchParams.get('route'),
    /^\/g\/extension-origin-guide-/,
  )
  const editHref = await app
    .locator('[data-sd="guide-edit"]')
    .getAttribute('href')
  assert.match(editHref, /^\/app\.html\?route=/, 'Native link is not file-safe')
  await app.locator('[data-sd="guide-edit"]').click()
  await expect(app.locator('[data-sd="step-title"]')).toBeVisible()
  const editorUrl = app.url()
  await app.reload()
  await expect(app.locator('[data-sd="step-title"]')).toHaveValue(
    'Open browser settings',
  )
  // A native link opened in another tab must resolve to the same stored guide.
  const second = await context.newPage()
  await second.goto(new URL(editHref, origin).href)
  await expect(second.locator('[data-sd="step-title"]')).toHaveValue(
    'Open browser settings',
  )
  await second.close()
  await app.goBack()
  await expect(
    app.getByRole('heading', { name: 'Extension origin guide', exact: true }),
  ).toBeVisible()
  await app.goForward()
  await expect(app.locator('[data-sd="step-title"]')).toBeVisible()
  assert.equal(app.url(), editorUrl)
  // Freeze before editing, with one fixed epoch rather than a one-second CDP
  // round-trip race. The advance happens while the editor has no dirty draft.
  const editClock = Date.now()
  await app.clock.install({ time: editClock - 60_000 })
  await app.clock.pauseAt(editClock)
  await app.locator('[data-sd="step-title"]').fill('Unsaved extension edit')
  await app.goBack()
  await expect(
    app.getByRole('dialog', { name: 'Save before leaving?' }),
  ).toBeVisible()
  await app.locator('[data-sd="editor-leave-stay"]').click()
  assert.equal(app.url(), editorUrl)
  await app.locator('[data-sd="editor-library"]').click()
  await app.locator('[data-sd="editor-leave-discard"]').click()
  await app.clock.resume()
  await app.goto(editorUrl)
  await expect(app.locator('[data-sd="step-title"]')).toHaveValue(
    'Open browser settings',
  )
  await app.locator('[data-sd="step-title"]').fill('Edited at extension origin')
  await app.keyboard.press('Control+s')
  await expect(
    app.getByRole('button', { name: /^Saved, version/ }),
  ).toBeVisible()
  await app.locator('[data-sd="editor-image-file"]').setInputFiles({
    name: 'fixture.png',
    mimeType: 'image/png',
    buffer: await readFile(
      new URL('../../app/e2e/fixtures/editor-original.png', import.meta.url),
    ),
  })
  await expect(
    app
      .getByText('Image processed in this browser and saved.', { exact: true })
      .first(),
  ).toBeVisible()
  await app.reload()
  await expect(app.locator('.editor-image>img')).toBeVisible()
  await expect(app.locator('[data-sd="step-title"]')).toHaveValue(
    'Edited at extension origin',
  )
  for (const theme of ['light', 'dark']) {
    await app.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    )
    const report = await new AxeBuilder({ page: app })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    assert.deepEqual(
      report.violations.map((item) => item.id),
      [],
      `${theme} extension editor accessibility`,
    )
  }
  await app.locator('[data-sd="export-open"]').click()
  await expect(
    app.getByRole('dialog', { name: 'Export & publish' }),
  ).toBeVisible()
  assert.match(new URL(app.url()).searchParams.get('route'), /\/export\?/)
  await app.reload()
  await expect(
    app.getByRole('dialog', { name: 'Export & publish' }),
  ).toBeVisible()
  await app.locator('[data-sd="export-close"]').click()
  await expect
    .poll(() => new URL(app.url()).searchParams.get('route'))
    .toMatch(/\/edit\?/)
  // Test the compiled export worker, including local font/raster reads, under MV3 CSP.
  await app.locator('[data-sd="export-open"]').click()
  for (const name of ['PDF', 'Markdown', 'guide.json'])
    await app.getByRole('checkbox', { name, exact: true }).uncheck()
  await app.getByRole('checkbox', { name: 'DOCX', exact: true }).check()
  const download = app.waitForEvent('download')
  await app.locator('[data-sd="export-download"]').click()
  const docx = await download
  assert.match(docx.suggestedFilename(), /\.docx$/)
  assert((await stat(await docx.path())).size > 1000)
  await app.keyboard.press('Escape')
  // Exercise the actual injected content script, screenshot compositor, queue and
  // v1 HTTP upload. Only the destination server is a local stub.
  const fixture = await context.newPage()
  await fixture.goto(`${base}/fixture`)
  await worker.evaluate(
    (url) => chrome.storage.local.set({ appUrl: url }),
    base,
  )
  // The inverse ordering matters too: a ready top frame does not establish
  // that its child producer has received the tab-wide recording state.
  await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id })
    const child = frames.find((frame) => frame.parentFrameId === 0)
    if (!child) throw new Error('Native child frame unavailable')
    globalThis.sdHeldChild = { tabId: tab.id, childId: child.frameId, count: 0 }
    globalThis.sdChildSend = chrome.tabs.sendMessage
    const send = chrome.tabs.sendMessage.bind(chrome.tabs)
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      if (
        tabId === globalThis.sdHeldChild.tabId &&
        message.type === 'STATE' && message.recording &&
        options?.frameId === undefined
      ) {
        globalThis.sdHeldChild.count++
        globalThis.sdHeldChild.message = message
        return send(tabId, message, { frameId: 0 })
      }
      return send(tabId, message, options)
    }
  }, fixture.url())
  await fixture.bringToFront()
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' })),
    { ok: true },
  )
  await fixture.frameLocator('#capture-frame')
    .getByRole('button', { name: 'Frame action' }).click()
  await expect.poll(async () => worker.evaluate(async () =>
    (await chrome.storage.local.get('capturedSteps')).capturedSteps?.length,
  )).toBe(1)
  const childStart = await worker.evaluate(async () => {
    const held = globalThis.sdHeldChild
    chrome.tabs.sendMessage = globalThis.sdChildSend
    await chrome.tabs.sendMessage(held.tabId, held.message, { frameId: held.childId })
    delete globalThis.sdChildSend
    delete globalThis.sdHeldChild
    const { capturedSteps } = await chrome.storage.local.get('capturedSteps')
    return { delayed: held.count, frame: capturedSteps[0].target?.frame }
  })
  assert(childStart.delayed > 0)
  assert.deepEqual(childStart.frame, ['#capture-frame'])
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' })),
    { ok: true },
  )
  console.log('Start armed the child producer before acknowledging a top-first broadcast')
  // A tab-wide send can acknowledge through a child before the top-frame
  // producer receives STATE. Hold that delivery while keeping the real child
  // response; a successful Start must explicitly arm the top frame first.
  await worker.evaluate(async (url) => {
    const tab = (await chrome.tabs.query({})).find((tab) => tab.url === url)
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id })
    const child = frames.find((frame) => frame.parentFrameId === 0)
    if (!child) throw new Error('Native child frame unavailable')
    globalThis.sdHeldSource = { tabId: tab.id, count: 0 }
    globalThis.sdSourceSend = chrome.tabs.sendMessage
    const send = chrome.tabs.sendMessage.bind(chrome.tabs)
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      if (
        tabId === globalThis.sdHeldSource.tabId &&
        message.type === 'STATE' && message.recording &&
        options?.frameId === undefined
      ) {
        globalThis.sdHeldSource.count++
        globalThis.sdHeldSource.message = message
        return send(tabId, message, { frameId: child.frameId })
      }
      return send(tabId, message, options)
    }
  }, fixture.url())
  // START chooses the active source tab, not the URL in the legacy message.
  // Focus that source explicitly after the preceding editor/download checks.
  await fixture.bringToFront()
  assert.deepEqual(
    await panel.evaluate(
      (url) => chrome.runtime.sendMessage({ type: 'START', url }),
      fixture.url(),
    ),
    { ok: true },
  )
  assert.deepEqual(
    await worker.evaluate(async () => {
      const state = await chrome.storage.local.get([
        'recording',
        'captureReview',
        'captureTabId',
        'captureError',
      ])
      const [active] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      })
      return {
        recording: state.recording,
        phase: state.captureReview?.phase,
        activeSource: state.captureTabId === active?.id,
        failed: !!state.captureError,
      }
    }),
    {
      recording: true,
      phase: 'recording',
      activeSource: true,
      failed: false,
    },
  )
  await fixture.bringToFront()
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  try {
    await expect
      .poll(async () =>
        worker.evaluate(
          async () =>
            (await chrome.storage.local.get('steps')).steps?.length ?? 0,
        ),
      )
      .toBeGreaterThan(0)
  } catch (error) {
    console.error(
      'Legacy capture metadata',
      await worker.evaluate(async () => {
        const state = await chrome.storage.local.get([
          'recording',
          'captureReview',
          'captureError',
          'steps',
          'capturedSteps',
        ])
        return {
          recording: state.recording,
          phase: state.captureReview?.phase,
          failed: !!state.captureError,
          legacyCount: state.steps?.length ?? 0,
          guideCount: state.capturedSteps?.length ?? 0,
        }
      }),
    )
    throw error
  }
  const heldDeliveries = await worker.evaluate(async () => {
    const held = globalThis.sdHeldSource
    chrome.tabs.sendMessage = globalThis.sdSourceSend
    if (held.message)
      await chrome.tabs.sendMessage(held.tabId, held.message, { frameId: 0 })
    delete globalThis.sdSourceSend
    delete globalThis.sdHeldSource
    return held.count
  })
  assert(heldDeliveries > 0, 'Top-frame delivery ordering was not exercised')
  console.log('Start armed the top-frame producer before acknowledging a child-first broadcast')
  const captured = await worker.evaluate(
    async () => (await chrome.storage.local.get('steps')).steps,
  )
  assert(captured.some((step) => step.elementMeta.selector === '#fixture-save'))
  assert(
    captured.every((step) =>
      /^data:image\/(?:png|webp);base64,/.test(step.screenshot),
    ),
  )
  const legacyGuide = await openedPage(async () => {
    assert.deepEqual(
      await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })),
      { ok: true },
    )
  })
  await legacyGuide.waitForURL(`${base}/guides/legacy-capture/edit`)
  assert.equal(uploaded.sourceUrl, fixture.url())
  assert(
    uploaded.steps.some(
      (step) => step.elementMeta.selector === '#fixture-save',
    ),
  )
  assert.equal(
    await worker.evaluate(
      async () => (await chrome.storage.local.get('steps')).steps,
    ),
    undefined,
  )
  // Capture real trusted input/selection/shadow/frame/SPA events. The content
  // script runs in its isolated world; the separate native core check installs
  // throwing value-getter proxies in the library's own execution world.
  // Cancel while the second capture is throttled, then immediately restart.
  // The old drain/error response must not own or stop the new session.
  await fixture.bringToFront()
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' })),
    { ok: true },
  )
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  await expect
    .poll(async () =>
      worker.evaluate(
        async () =>
          (await chrome.storage.local.get('capturedSteps')).capturedSteps
            ?.length ?? 0,
      ),
    )
    .toBe(1)
  const oldId = await worker.evaluate(
    async () =>
      (await chrome.storage.local.get('capturedSteps')).capturedSteps[0].id,
  )
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' }))
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' })),
    { ok: true },
  )
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  await expect
    .poll(async () =>
      worker.evaluate(async () => {
        const state = await chrome.storage.local.get([
          'capturedSteps',
          'captureError',
          'recording',
        ])
        return state.captureError
          ? 'failed'
          : state.recording && state.capturedSteps?.length === 1
            ? 'ready'
            : 'waiting'
      }),
    )
    .toBe('ready')
  assert.notEqual(
    await worker.evaluate(
      async () =>
        (await chrome.storage.local.get('capturedSteps')).capturedSteps[0].id,
    ),
    oldId,
  )
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' }))
  await fixture.goto(`${base}/contract?private=PRIVATE_QUERY#PRIVATE_FRAGMENT`)
  await fixture.bringToFront()
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' })),
    { ok: true },
  )
  await fixture.getByRole('button', { name: 'Open confirmation' }).click()
  await fixture
    .getByRole('textbox', { name: 'Project title' })
    .fill('PRIVATE_TYPED_PROJECT')
  await fixture
    .getByRole('textbox', { name: 'Invoice email' })
    .fill('PRIVATE_TYPED_EMAIL')
  await fixture.locator('#card-field').fill('PRIVATE_TYPED_CARD')
  await fixture
    .getByRole('textbox', { name: 'Notes' })
    .fill('PRIVATE_TYPED_NOTES')
  await fixture.getByRole('combobox', { name: 'Plan' }).focus()
  await fixture.getByRole('combobox', { name: 'Plan' }).press('ArrowDown')
  await fixture.getByRole('combobox', { name: 'Plan' }).press('Enter')
  await expect(fixture.locator('#plan-field option:checked')).toHaveText(
    'Team plan',
  )
  await fixture.getByRole('button', { name: 'Shadow action' }).click()
  await fixture
    .frameLocator('#capture-frame')
    .getByRole('button', { name: 'Frame action' })
    .click()
  await fixture.getByRole('button', { name: 'Next screen' }).click()
  // A queued capture can broadcast recorder state immediately after pushState,
  // before the source's URL timer runs. That refresh must not consume navigation.
  await worker.evaluate(async () => {
    const state = await chrome.storage.local.get([
      'recording',
      'captureSessionId',
      'captureTabId',
      'captureBlurMode',
      'captureManualCount',
      'captureReview',
      'capturedSteps',
    ])
    await chrome.tabs.sendMessage(
      state.captureTabId,
      {
        type: 'STATE',
        recording: state.recording,
        sessionId: state.captureSessionId,
        blurMode: state.captureBlurMode,
        manualCount: state.captureManualCount,
        capturePill: {
          sessionId: state.captureSessionId,
          phase: state.captureReview.phase,
          count: state.capturedSteps.length,
          clock: state.captureReview.clock,
        },
      },
      { frameId: 0 },
    )
  })
  await expect
    .poll(
      async () =>
        worker.evaluate(async () => {
          const state = await chrome.storage.local.get([
            'capturedSteps',
            'captureError',
          ])
          return state.captureError
            ? 'failed'
            : state.capturedSteps?.some(
                  (step) =>
                    step.action === 'navigate' && step.url.endsWith('/next'),
                )
              ? 'ready'
              : 'waiting'
        }),
      { timeout: 25_000 },
    )
    .toBe('ready')
  const contract = await worker.evaluate(() =>
    chrome.storage.local.get([
      'steps',
      'capturedSteps',
      'startedUrl',
      'captureError',
    ]),
  )
  assert.equal(contract.captureError, null)
  assert.equal(contract.startedUrl, `${base}/contract`)
  for (const [name, kind] of [
    ['Project title', 'variable'],
    ['Invoice email', 'secret'],
    ['Card number', 'secret'],
    ['Notes', 'variable'],
  ]) {
    assert(
      contract.capturedSteps.some(
        (step) =>
          step.action === 'fill' &&
          step.target.name === name &&
          step.value.kind === kind,
      ),
      `Committed ${name} uses a reference`,
    )
  }
  assert(
    contract.capturedSteps.some(
      (step) => step.action === 'select' && step.value.literal === 'Team plan',
    ),
  )
  assert(
    contract.capturedSteps.some(
      (step) => step.action === 'press' && step.key === 'Enter',
    ),
  )
  assert(
    contract.capturedSteps.some(
      (step) =>
        step.target?.name === 'Shadow action' &&
        step.target.shadowPath[0] === '#capture-host',
    ),
  )
  assert(
    contract.capturedSteps.some(
      (step) =>
        step.target?.name === 'Frame action' &&
        step.target.frame[0] === '#capture-frame',
    ),
  )
  assert(
    contract.capturedSteps.some(
      (step) =>
        step.target?.name === 'Open confirmation' &&
        step.expect?.visible?.name === 'Confirm change',
    ),
  )
  assert(
    contract.capturedSteps.some(
      (step) => step.expect?.urlMatches === `${base}/next`,
    ),
  )
  assert.equal(
    contract.capturedSteps.filter(
      (step) => step.action === 'navigate' && step.url === `${base}/next`,
    ).length,
    1,
  )
  assert(
    contract.capturedSteps.every((step, index) => step.index === index + 1),
  )
  for (const secret of [
    'PRIVATE_TYPED_PROJECT',
    'PRIVATE_TYPED_EMAIL',
    'PRIVATE_TYPED_CARD',
    'PRIVATE_TYPED_NOTES',
    'PRIVATE_QUERY',
    'PRIVATE_FRAGMENT',
  ])
    assert(
      !JSON.stringify(contract).includes(secret),
      'Captured storage contains a typed/query value',
    )
  // The source fixture has one-pixel black/white stripes. Mandatory client
  // field masks remove them before even the queue's reusable image is stored.
  const fieldTransitions = (dataUrl) =>
    fixture.evaluate(async (dataUrl) => {
      const image = await createImageBitmap(await (await fetch(dataUrl)).blob())
      const canvas = new OffscreenCanvas(image.width, image.height),
        ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      image.close()
      const rect = document
        .querySelector('#project-field')
        .getBoundingClientRect()
      const pixels = ctx.getImageData(
        Math.ceil(rect.x) + 12,
        Math.ceil(rect.y) + 5,
        80,
        1,
      ).data
      const red = Array.from(
        { length: pixels.length / 4 },
        (_, index) => pixels[index * 4],
      )
      return red
        .slice(1)
        .filter((value, index) => Math.abs(value - red[index]) > 60).length
    }, dataUrl)
  assert(
    (await fieldTransitions(contract.steps.at(-1).screenshot)) < 15,
    'Raw one-pixel field stripes reached stored capture image',
  )
  const reloadState = () =>
    worker.evaluate(async (url) => {
      const state = await chrome.storage.local.get([
        'capturedSteps',
        'captureError',
        'recording',
        'captureReview',
      ])
      return {
        count: (state.capturedSteps ?? []).filter(
          (step) => step.action === 'navigate' && step.url === url,
        ).length,
        error: state.captureError,
        recording: state.recording,
        phase: state.captureReview?.phase,
      }
    }, `${base}/next`)
  const sourceDocument = () =>
    worker.evaluate(async () => {
      const { captureTabId } = await chrome.storage.local.get('captureTabId')
      const frames = await chrome.webNavigation.getAllFrames({
        tabId: captureTabId,
      })
      return frames.find((frame) => frame.frameId === 0)?.documentId
    })
  let documentId = await sourceDocument()
  assert(documentId, 'Source document identity missing before reload')
  for (let reload = 1; reload <= 3; reload++) {
    await fixture.bringToFront()
    await fixture.reload()
    try {
      await expect.poll(reloadState).toEqual({
        count: reload + 1,
        error: null,
        recording: true,
        phase: 'recording',
      })
      await expect(
        panel.locator('[data-sd="capture-review"]'),
      ).toBeEnabled()
    } catch (error) {
      console.log('Reload capture diagnostic', {
        reload,
        ...(await reloadState()),
      })
      throw error
    }
    const nextDocument = await sourceDocument()
    assert(nextDocument && nextDocument !== documentId)
    documentId = nextDocument
    const reloadImage = await worker.evaluate(
      async () =>
        (await chrome.storage.local.get('steps')).steps.at(-1).screenshot,
    )
    assert(
      (await fieldTransitions(reloadImage)) < 15,
      'Reloaded document reached storage without client field masks',
    )
    console.log(`Capture document replacement verified: reload ${reload}`)
  }
  const reloadedSteps = await worker.evaluate(
    async () => (await chrome.storage.local.get('capturedSteps')).capturedSteps,
  )
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })),
    { ok: true },
  )
  assert(!JSON.stringify(uploaded).includes('PRIVATE_TYPED_'))
  assert(
    uploaded.steps.some(
      (step) =>
        step.elementMeta?.label === 'Invoice email' &&
        step.elementMeta.inputType === 'email',
    ),
  )
  assert(
    uploaded.steps.some(
      (step) =>
        step.elementMeta?.label === 'Card number' &&
        step.elementMeta.inputType === 'password',
    ),
  )
  assert.deepEqual(
    uploaded.steps.map((step) => step.text),
    reloadedSteps.map((step) => step.title),
  )
  // A metadata-limit failure must stop and block upload, preserving only prior
  // already-redacted steps and exposing a data-free status to the capture UI.
  await fixture.bringToFront()
  await fixture.goto(`${base}/failure`)
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' })),
    { ok: true },
  )
  await fixture
    .locator('#fixture-save')
    .evaluate((button) =>
      button.setAttribute('aria-label', 'PRIVATE'.repeat(100)),
    )
  await fixture.locator('#fixture-save').click()
  await expect
    .poll(async () =>
      worker.evaluate(
        async () =>
          (await chrome.storage.local.get('captureError')).captureError,
      ),
    )
    .toMatch(/metadata or privacy masks/)
  await expect(panel.getByRole('status')).toHaveText(
    /metadata or privacy masks/,
  )
  const previousUpload = JSON.stringify(uploaded)
  assert.equal(
    (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })))
      .ok,
    false,
  )
  assert.equal(JSON.stringify(uploaded), previousUpload)
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' }))
  await fixture.goto(`${base}/fixture`)
  // Switch away and back while the real screenshot API is in flight. An active
  // tab check alone after capture cannot detect this; activation epochs must.
  const other = await context.newPage()
  await other.goto(`${base}/other-tab`)
  const otherId = await worker.evaluate(
    async (prefix) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(prefix))
        .id,
    `${base}/other-tab`,
  )
  await fixture.bringToFront()
  const fixtureId = await worker.evaluate(
    async () =>
      (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id,
  )
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' })),
    { ok: true },
  )
  await worker.evaluate(
    ({ otherId, fixtureId }) => {
      const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
      globalThis.sdTestCaptureOriginal = chrome.tabs.captureVisibleTab
      globalThis.sdTestCaptureSwitched = false
      chrome.tabs.captureVisibleTab = async (...args) => {
        await chrome.tabs.update(otherId, { active: true })
        const raw = await original(...args)
        await chrome.tabs.update(fixtureId, { active: true })
        globalThis.sdTestCaptureSwitched = true
        return raw
      }
    },
    { otherId, fixtureId },
  )
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  await expect
    .poll(() => worker.evaluate(() => globalThis.sdTestCaptureSwitched))
    .toBe(true)
  await expect
    .poll(async () =>
      worker.evaluate(
        async () =>
          (await chrome.storage.local.get('captureError')).captureError,
      ),
    )
    .toMatch(/selected tab changed/)
  assert.deepEqual(
    await worker.evaluate(
      async () => (await chrome.storage.local.get('steps')).steps,
    ),
    [],
  )
  const beforeBlockedUpload = JSON.stringify(uploaded)
  assert.equal(
    (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })))
      .ok,
    false,
  )
  assert.equal(JSON.stringify(uploaded), beforeBlockedUpload)
  await worker.evaluate(() => {
    chrome.tabs.captureVisibleTab = globalThis.sdTestCaptureOriginal
    delete globalThis.sdTestCaptureOriginal
    delete globalThis.sdTestCaptureSwitched
  })
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' }))
  await other.close()
  // A failed upload must remain retryable in the service worker; blob URL APIs
  // are unavailable there. The recovery download contains already-redacted data.
  rejectUpload = true
  await fixture.bringToFront()
  assert.deepEqual(
    await panel.evaluate(
      (url) => chrome.runtime.sendMessage({ type: 'START', url }),
      fixture.url(),
    ),
    { ok: true },
  )
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  try {
    await expect
      .poll(async () =>
        worker.evaluate(
          async () =>
            (await chrome.storage.local.get('steps')).steps?.length ?? 0,
        ),
      )
      .toBeGreaterThan(0)
  } catch (error) {
    console.log(
      'Upload-recovery capture diagnostic',
      await worker.evaluate(async () => {
        const state = await chrome.storage.local.get([
          'recording',
          'captureError',
          'captureReview',
          'captureTabId',
          'steps',
          'capturedSteps',
        ])
        const [active] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        })
        return {
          recording: state.recording,
          error: state.captureError,
          phase: state.captureReview?.phase,
          count: state.steps?.length,
          metadataCount: state.capturedSteps?.length,
          activeSource: active?.id === state.captureTabId,
        }
      }),
    )
    throw error
  }
  assert.equal(
    (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })))
      .ok,
    false,
  )
  assert(
    await worker.evaluate(
      async () =>
        !!(await chrome.storage.local.get('pendingSession')).pendingSession,
    ),
  )
  rejectUpload = false
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'RETRY' })),
    { ok: true },
  )
  assert.equal(
    await worker.evaluate(
      async () =>
        (await chrome.storage.local.get('pendingSession')).pendingSession,
    ),
    undefined,
  )
  // RETRY opens its server editor. Select the actual capture fixture before
  // testing Start/Cancel; the newly created editor may still be loading.
  await fixture.bringToFront()
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' })),
    { ok: true },
  )
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' })),
    { ok: true },
  )
  assert.equal(
    (
      await panel.evaluate(() =>
        chrome.runtime.sendMessage({ type: 'GET_STATE' }),
      )
    ).recording,
    false,
  )
  // The producer can apply STATE but never reply (for example a torn-down
  // response channel). Cancellation must settle after the bounded handshake,
  // and a late acknowledgement must not resurrect the canceled session.
  const beforeHandshakeFailure = JSON.stringify(uploaded)
  await fixture.bringToFront()
  await worker.evaluate(() => {
    globalThis.sdAckSend = chrome.tabs.sendMessage
    const send = chrome.tabs.sendMessage.bind(chrome.tabs)
    chrome.tabs.sendMessage = async (tabId, message, options) => {
      if (message.type === 'STATE' && message.recording && options?.frameId === 0) {
        await send(tabId, message, options)
        globalThis.sdAckHeld = true
        return new Promise((resolve) => { globalThis.sdAckRelease = resolve })
      }
      return send(tabId, message, options)
    }
  })
  const pendingStart = panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'START' }),
  ).catch((error) => {
    const message = error instanceof Error ? error.message : ''
    console.log('Held-handshake Start transport failure', {
      channelClosed: /message (?:port|channel).*closed|channel closed/i.test(message),
      targetClosed: /target.*closed/i.test(message),
      contextDestroyed: /context.*destroyed/i.test(message),
      timeout: /timeout|timed out/i.test(message),
    })
    return null
  })
  await expect.poll(() => worker.evaluate(() => globalThis.sdAckHeld)).toBe(true)
  const pendingCancel = panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'CANCEL' }),
  ).catch(() => null)
  const startReply = await pendingStart
  if (!startReply)
    console.log('Held-handshake state', await worker.evaluate(async () => {
      const state = await chrome.storage.local.get([
        'recording', 'captureError', 'captureReview', 'steps',
      ])
      return {
        recording: state.recording, failed: !!state.captureError,
        phase: state.captureReview?.phase, count: state.steps?.length,
      }
    }).catch(() => ({ workerUnavailable: true })))
  assert.deepEqual(startReply, {
    ok: false, error: 'Capture operation failed',
  })
  assert.deepEqual(await pendingCancel, { ok: true })
  await worker.evaluate(() => {
    chrome.tabs.sendMessage = globalThis.sdAckSend
    globalThis.sdAckRelease({ ok: true })
    delete globalThis.sdAckSend
    delete globalThis.sdAckRelease
    delete globalThis.sdAckHeld
  })
  const canceledState = await worker.evaluate(async () => {
    const state = await chrome.storage.local.get([
      'recording', 'captureError', 'captureReview', 'steps',
    ])
    return {
      recording: state.recording, error: state.captureError,
      phase: state.captureReview?.phase, count: state.steps?.length,
    }
  })
  assert.deepEqual(canceledState, {
    recording: false, error: null, phase: 'idle', count: 0,
  })
  assert.equal(JSON.stringify(uploaded), beforeHandshakeFailure)
  await panel.bringToFront()
  await expect(panel.locator('[data-sd="capture-start"]')).toBeEnabled()
  await fixture.bringToFront()
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' })),
    { ok: true },
  )
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  await expect.poll(async () => worker.evaluate(async () =>
    (await chrome.storage.local.get('steps')).steps?.length,
  )).toBe(1)
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' })),
    { ok: true },
  )
  console.log('Source handshake timeout, cancellation, late reply and new-session recovery verified')
  assert.deepEqual(failures, [], 'Extension runtime failed')
  console.log(
    'Built-extension verification passed: three manifests/assets, native local library/editor/history/image/export workers, two-theme axe, trusted fill/select/key/frame/shadow/SPA metadata, reference-only storage, field pixels, acknowledged Starts and three distinct same-URL reloads with ready controls/masked pixels, fail-closed capture, legacy upload/recovery/retry/cancel.',
  )
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}

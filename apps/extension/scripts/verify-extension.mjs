import { extensionWorker } from './extension-worker.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { readFile, readdir, stat } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const output = new URL('../.output/', import.meta.url)
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
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  })
  context.setDefaultTimeout(15_000)
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
  const appOpened = context.waitForEvent('page')
  await panel.getByRole('link', { name: 'Open library' }).click()
  const app = await appOpened
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
  await app.clock.install()
  await app.clock.pauseAt(await app.evaluate(() => Date.now() + 1000))
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
  await panel.evaluate(
    (url) => chrome.runtime.sendMessage({ type: 'START', url }),
    fixture.url(),
  )
  await fixture.bringToFront()
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  await expect
    .poll(async () =>
      worker.evaluate(
        async () =>
          (await chrome.storage.local.get('steps')).steps?.length ?? 0,
      ),
    )
    .toBeGreaterThan(0)
  const captured = await worker.evaluate(
    async () => (await chrome.storage.local.get('steps')).steps,
  )
  assert(captured.some((step) => step.elementMeta.selector === '#fixture-save'))
  assert(
    captured.every((step) =>
      /^data:image\/(?:png|webp);base64,/.test(step.screenshot),
    ),
  )
  const opened = context.waitForEvent('page')
  assert.deepEqual(
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })),
    { ok: true },
  )
  const legacyGuide = await opened
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
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }))
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
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }))
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
  const transitions = await fixture.evaluate(async (dataUrl) => {
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
  }, contract.steps.at(-1).screenshot)
  assert(
    transitions < 15,
    'Raw one-pixel field stripes reached stored capture image',
  )
  await fixture.reload()
  await expect
    .poll(async () =>
      worker.evaluate(
        async (url) =>
          (
            await chrome.storage.local.get('capturedSteps')
          ).capturedSteps.filter(
            (step) => step.action === 'navigate' && step.url === url,
          ).length,
        `${base}/next`,
      ),
    )
    .toBe(2)
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
  await fixture.goto(`${base}/failure`)
  await fixture.bringToFront()
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }))
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
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }))
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
  await panel.evaluate(
    (url) => chrome.runtime.sendMessage({ type: 'START', url }),
    fixture.url(),
  )
  await fixture.getByRole('button', { name: 'Save fixture' }).click()
  await expect
    .poll(async () =>
      worker.evaluate(
        async () =>
          (await chrome.storage.local.get('steps')).steps?.length ?? 0,
      ),
    )
    .toBeGreaterThan(0)
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
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }))
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
  assert.deepEqual(failures, [], 'Extension runtime failed')
  console.log(
    'Built-extension verification passed: three manifests/assets, native local library/editor/history/image/export workers, two-theme axe, trusted fill/select/key/frame/shadow/SPA metadata, reference-only storage, field pixels, fail-closed capture, legacy upload/recovery/retry/cancel.',
  )
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}

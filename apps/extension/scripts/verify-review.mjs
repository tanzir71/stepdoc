import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

let uploads = 0
const server = createServer((req, res) => {
  if (req.url.startsWith('/api/')) uploads++
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(`<!doctype html><html lang="en"><head><title>Local workflow fixture</title><link rel="icon" href="data:,"></head><body>
    <main><h1>Local workflow</h1><button id="one">Open settings</button><button id="two">Apply settings</button><button id="three">Confirm settings</button>
    <label>Private email <input type="email" id="private"></label><p>redaction@example.test</p>
    <button id="mask" style="display:block;width:220px;height:50px;background:repeating-linear-gradient(90deg,black 0,black 1px,white 1px,white 2px)">Manual mask</button></main></body></html>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const screens = new URL(
  update ? '../../../docs/v2/screens/' : '../../../test-results/screens/',
  import.meta.url,
)
const snapshots = new URL('../tests/review/', import.meta.url)
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
  let [worker] = context.serviceWorkers()
  worker ??= await context.waitForEvent('serviceworker')
  const workerUrl = new URL(worker.url()),
    origin = `${workerUrl.protocol}//${workerUrl.host}`
  const failures = []
  context.on('page', (page) => {
    page.on('pageerror', (error) => failures.push(error.message))
    page.on('request', (request) => {
      if (
        ![base, origin, 'data:', 'blob:'].some((prefix) =>
          request.url().startsWith(prefix),
        )
      )
        failures.push('Unexpected nonlocal request')
    })
  })
  const fixture = await context.newPage()
  await fixture.goto(`${base}/workflow?PRIVATE_QUERY#PRIVATE_FRAGMENT`)
  const fixtureTab = await worker.evaluate(
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
  await panel.goto(`${origin}/sidepanel.html`)
  const panelTab = await worker.evaluate(
    async (origin) =>
      (await chrome.tabs.query({})).find((tab) =>
        tab.url?.startsWith(`${origin}/sidepanel.html`),
      ),
    origin,
  )
  assert.equal(panelTab.windowId, fixtureTab.windowId)
  const panelWindow = { id: fixtureTab.windowId }
  const panelSession = await context.newCDPSession(panel)
  // Use the actual window size. Per-tab viewport emulation is reset by native
  // captureVisibleTab on Windows. The private root hosts a real 400px panel.
  async function sizeWindow(page, windowId, width, height) {
    await page.bringToFront()
    for (let attempt = 0; attempt < 3; attempt++) {
      const bounds = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        outerWidth,
        outerHeight,
      }))
      if (bounds.width === width && bounds.height === height) return
      const resized = await worker.evaluate(
        ({ windowId, width, height }) =>
          chrome.windows.update(windowId, { width, height, left: 0, top: 0 }),
        {
          windowId,
          width: bounds.outerWidth + width - bounds.width,
          height: bounds.outerHeight + height - bounds.height,
        },
      )
      await page.waitForFunction(
        ({ width, height }) => innerWidth === width && innerHeight === height,
        { width, height },
        { polling: 50 },
      )
    }
    throw new Error('Native window size unavailable')
  }
  await sizeWindow(fixture, fixtureTab.windowId, 600, 900)
  async function selectFixture() {
    await worker.evaluate(async ({ windowId, id }) => {
      await chrome.windows.update(windowId, { focused: true })
      await chrome.tabs.update(id, { active: true })
    }, fixtureTab)
    await fixture.bringToFront()
  }
  const state = () => worker.evaluate(() => chrome.storage.local.get(null))
  const message = (type, extra = {}) =>
    panel.evaluate(
      ({ type, extra }) => chrome.runtime.sendMessage({ type, ...extra }),
      { type, extra },
    )
  // A real side panel does not activate a tab. These are the same DOM controls
  // in a private extension tab; dispatch there without changing the capture tab.
  const press = async (hook) => {
    const button = panel.locator(`[data-sd="${hook}"]`)
    await expect(button).toBeEnabled()
    await button.evaluate((button) => button.click())
  }
  const waitPhase = (phase) =>
    expect
      .poll(async () => (await state()).captureReview?.phase, {
        timeout: 20_000,
      })
      .toBe(phase)
  const waitSteps = (count) =>
    expect
      .poll(
        async () => {
          const value = await state()
          return value.captureError ?? value.capturedSteps?.length
        },
        { timeout: 20_000 },
      )
      .toBe(count)
  async function inspect(name) {
    console.log(`Inspecting ${name}`)
    await worker.evaluate(
      (id) => chrome.windows.update(id, { focused: true }),
      panelWindow.id,
    )
    await panel.bringToFront()
    assert.deepEqual(
      await panel.evaluate(() => ({
        width: document.querySelector('.capture-panel').getBoundingClientRect()
          .width,
        height: document.querySelector('.capture-panel').getBoundingClientRect()
          .height,
        header: document.querySelector('header').getBoundingClientRect().height,
        padding: getComputedStyle(document.querySelector('main')).paddingLeft,
        font: getComputedStyle(document.querySelector('main')).fontFamily,
      })),
      {
        width: 400,
        height: 900,
        header: 52,
        padding: '16px',
        font: 'Geist, ui-sans-serif, system-ui, sans-serif',
      },
      `Figma panel geometry ${name}`,
    )
    await expect(panel.locator('body')).not.toHaveText('')
    const violations = (await new AxeBuilder({ page: panel }).analyze())
      .violations
    assert.deepEqual(
      violations.map(({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({
          target,
          failureSummary,
        })),
      })),
      [],
      `Axe ${name}`,
    )
    assert(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `No horizontal overflow: ${name}`,
    )
    const aria = await panel.locator('.capture-panel').ariaSnapshot()
    const path = new URL(`${name}.aria.txt`, snapshots)
    if (update) await writeFile(path, `${aria}\n`)
    else
      assert.equal(
        `${aria}\n`,
        (await readFile(path, 'utf8')).replaceAll('\r\n', '\n'),
        `Aria ${name}`,
      )
    // The actual private control view, without resizing either native window.
    let screenshotTimer
    const screenshot = await Promise.race([
      panelSession.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 400, height: 900, scale: 1 },
      }),
      new Promise((_, reject) => {
        screenshotTimer = setTimeout(
          () => reject(new Error('Native panel screenshot timed out')),
          30_000,
        )
      }),
    ]).finally(() => clearTimeout(screenshotTimer))
    const png = Buffer.from(screenshot.data, 'base64')
    assert.deepEqual(
      [png.readUInt32BE(16), png.readUInt32BE(20)],
      [400, 900],
      `Native screenshot dimensions ${name}`,
    )
    const painted = await panel.evaluate(async (data) => {
      const bytes = Uint8Array.from(atob(data), (value) => value.charCodeAt(0))
      const bitmap = await createImageBitmap(
        new Blob([bytes], { type: 'image/png' }),
      )
      try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const ctx = canvas.getContext('2d')
        ctx.drawImage(bitmap, 0, 0)
        const rgba = ctx.getImageData(0, 0, 400, 52).data
        let ink = 0
        for (let i = 0; i < rgba.length; i += 4)
          if (rgba[i] < 200 || rgba[i + 1] < 200 || rgba[i + 2] < 200) ink++
        return { corner: Array.from(rgba.slice(0, 4)), ink }
      } finally {
        bitmap.close()
      }
    }, screenshot.data)
    assert.deepEqual(
      painted.corner,
      [255, 255, 255, 255],
      `Panel surface painted ${name}`,
    )
    assert(painted.ink > 100, `Logo and header painted ${name}`)
    await writeFile(new URL(`m11-${name}.png`, screens), png)
    await selectFixture()
  }
  await expect(panel.getByRole('status')).toHaveText('Ready to capture')
  await inspect('capture-idle')
  // Real trusted page shortcut starts the background producer.
  await fixture.locator('#one').click()
  await fixture.keyboard.press('Alt+Shift+s')
  await waitPhase('recording')
  await fixture.locator('#one').click()
  await waitSteps(1)
  await expect(panel.locator('[data-sd-step="1"]')).toContainText(
    'Open settings',
  )
  await inspect('capture-recording')
  await fixture.keyboard.press('Alt+b')
  await fixture.locator('#mask').click()
  await fixture.keyboard.press('Escape')
  await expect.poll(async () => (await state()).captureManualCount).toBe(1)
  await press('capture-pause')
  await waitPhase('paused')
  await fixture.locator('#two').click()
  await fixture.locator('#private').fill('PRIVATE_TYPED_NEVER_RECORDED')
  await inspect('capture-paused')
  assert.equal(
    (await state()).capturedSteps.length,
    1,
    'Paused interactions were recorded',
  )
  assert.equal((await state()).captureManualCount, 1)
  await panel.reload()
  await expect(
    panel.getByRole('button', { name: 'Resume', exact: true }),
  ).toBeEnabled()
  await press('capture-pause')
  await waitPhase('recording')
  await fixture.locator('#two').click()
  await waitSteps(2)
  assert(
    (await state()).capturedSteps[1].redactions.some(
      (mask) => mask.source === 'manual',
    ),
    'Resume lost manual masks',
  )
  await fixture.locator('#three').click()
  await waitSteps(3)
  await fixture.keyboard.press('Alt+Shift+s')
  await waitPhase('review')
  await expect(panel.getByRole('textbox', { name: 'Guide title' })).toHaveValue(
    'Workflow on 127.0.0.1',
  )
  await inspect('capture-review')
  const before = await state()
  assert(!JSON.stringify(before).includes('PRIVATE_TYPED_NEVER_RECORDED'))
  assert(!JSON.stringify(before).includes('PRIVATE_QUERY'))
  assert(!JSON.stringify(before).includes('PRIVATE_FRAGMENT'))
  await panel.reload()
  await expect(panel.locator('[data-sd-step]')).toHaveCount(3)
  // Accessibility keyboard reorder keeps pixels attached to their source steps.
  await panel.locator('[data-sd="capture-select-step"]').nth(2).focus()
  await panel.keyboard.press('Alt+ArrowUp')
  await expect
    .poll(async () =>
      (await state()).capturedSteps.map((step) => step.id).join(','),
    )
    .toBe(
      [
        before.capturedSteps[0].id,
        before.capturedSteps[2].id,
        before.capturedSteps[1].id,
      ].join(','),
    )
  assert.equal((await state()).steps[1].screenshot, before.steps[2].screenshot)
  const stale = await message('EDIT_REVIEW', {
    sessionId: before.captureSessionId,
    revision: before.captureReview.revision,
    edit: { operation: 'delete', ids: [before.capturedSteps[0].id] },
  })
  assert.equal(stale.ok, false, 'A stale review overwrote a newer edit')
  await panel.locator('[data-sd="capture-select-step"]').nth(0).check()
  await panel.locator('[data-sd="capture-select-step"]').nth(1).check()
  await press('capture-merge')
  await expect(
    panel.getByRole('dialog', { name: 'Merge selected steps?' }),
  ).toBeVisible()
  await panel.keyboard.press('Escape')
  await expect(panel.getByRole('dialog')).toHaveCount(0)
  await press('capture-merge')
  await press('capture-confirm')
  await waitSteps(2)
  assert.equal((await state()).capturedSteps[0].type, 'manual')
  assert.equal((await state()).capturedSteps[0].lowConfidence, true)
  // Reject the atomic commit after files have been prepared. Nothing becomes visible.
  await worker.evaluate(() => {
    globalThis.savedAdd = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'versions') throw new Error('PRIVATE_NATIVE_FAILURE')
      return globalThis.savedAdd.apply(this, args)
    }
  })
  await panel
    .getByRole('textbox', { name: 'Guide title' })
    .fill('Reviewed local workflow')
  await press('capture-save')
  await expect(panel.getByRole('status')).toHaveText(
    'Local save could not finish. Your review is retained; retry saving.',
  )
  await waitPhase('review')
  assert.equal((await state()).capturedSteps.length, 2)
  await worker.evaluate(() => {
    IDBObjectStore.prototype.add = globalThis.savedAdd
    delete globalThis.savedAdd
  })
  // A committed capture followed by a failed editor launch is retryable too.
  await worker.evaluate(() => {
    globalThis.savedTabCreate = chrome.tabs.create
    chrome.tabs.create = async () => {
      throw new Error('PRIVATE_NATIVE_FAILURE')
    }
  })
  await press('capture-save')
  await expect
    .poll(async () => (await state()).captureReview.phase)
    .toBe('review')
  await expect(panel.locator('[data-sd="capture-save"]')).toBeEnabled()
  await expect(
    panel.getByRole('textbox', { name: 'Guide title' }),
  ).toBeDisabled()
  assert.equal(
    (
      await message('EDIT_REVIEW', {
        sessionId: before.captureSessionId,
        revision: (await state()).captureReview.revision,
        edit: {
          operation: 'title',
          title: 'Must not replace the committed guide',
        },
      })
    ).ok,
    false,
  )
  await worker.evaluate(() => {
    chrome.tabs.create = globalThis.savedTabCreate
    delete globalThis.savedTabCreate
  })
  const opened = context.waitForEvent('page')
  await selectFixture()
  await press('capture-save')
  const editor = await opened
  await editor.waitForLoadState()
  await expect(
    editor.getByRole('heading', {
      name: 'Reviewed local workflow',
      exact: true,
    }),
  ).toBeVisible()
  const savedId = (await state()).captureReview.savedId
  assert(editor.url().includes(encodeURIComponent(`/g/${savedId}/edit?step=1`)))
  await waitPhase('idle')
  assert.deepEqual((await state()).steps, [])
  assert.deepEqual((await state()).capturedSteps, [])
  await editor.reload()
  await expect(
    editor.getByRole('heading', {
      name: 'Reviewed local workflow',
      exact: true,
    }),
  ).toBeVisible()
  assert.equal(
    await editor.locator('[data-sd="editor-step-select"]').count(),
    2,
  )
  await expect(
    editor.getByRole('button', {
      name: 'Saved, version 1. Open history.',
      exact: true,
    }),
  ).toBeVisible()
  // Explicit privacy preferences have real behavior; typed fields remain masked.
  await selectFixture()
  assert.equal(
    (
      await message('SET_CAPTURE_PREFERENCES', {
        preferences: { smartBlur: false, agentContext: false },
      })
    ).ok,
    true,
  )
  await press('capture-start')
  await waitPhase('recording')
  await fixture.locator('#one').click()
  await waitSteps(1)
  const privateStep = (await state()).capturedSteps[0]
  assert.equal(privateStep.target, undefined)
  assert.equal(privateStep.expect, undefined)
  assert.equal(privateStep.lowConfidence, true)
  assert(privateStep.redactions.some((mask) => mask.rule === 'form-value'))
  assert(
    !privateStep.redactions.some(
      (mask) => mask.kind === 'email' && mask.source === 'auto',
    ),
  )
  await press('capture-review')
  await waitPhase('review')
  await panel.locator('[data-sd="capture-select-step"]').check()
  await press('capture-delete')
  await waitSteps(0)
  await expect(panel.locator('[data-sd="capture-save"]')).toBeDisabled()
  await inspect('capture-empty-review')
  await press('capture-discard')
  await press('capture-confirm')
  await waitPhase('idle')
  await expect(
    panel.getByRole('link', { name: /Reviewed local workflow/ }),
  ).toBeVisible()
  await panel.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  assert.deepEqual(
    (await new AxeBuilder({ page: panel }).analyze()).violations.map(
      ({ id, nodes }) => ({
        id,
        nodes: nodes.map(({ target, failureSummary }) => ({
          target,
          failureSummary,
        })),
      }),
    ),
    [],
  )
  assert.equal(uploads, 0, 'The local flow contacted a server')
  assert.deepEqual(failures, [])
  console.log(
    'Native extension review verified: real shortcut, pause/resume with masks, reload, keyboard reorder, stale-edit rejection, manual merge/delete, atomic failure/retry, same-origin editor persistence, privacy preferences, aria snapshots/axe and no server upload.',
  )
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}

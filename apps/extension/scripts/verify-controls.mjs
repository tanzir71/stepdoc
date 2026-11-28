import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { extensionWorker } from './extension-worker.mjs'

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    '<!doctype html><html lang="en"><head><title>Large local capture</title><link rel="icon" href="data:,"></head><body><canvas id="noise" style="position:fixed;inset:0;z-index:-1"></canvas><main><label>Private email<input type="email" id="private"></label><button id="action">Apply settings</button></main></body></html>',
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let context
try {
  const dir = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url))
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1800, height: 1800 },
    args: [
      '--disable-gpu',
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
    ],
  })
  const worker = await extensionWorker(context)
  const workerUrl = new URL(worker.url())
  const origin = `${workerUrl.protocol}//${workerUrl.host}`
  const failures = []
  context.on('page', (page) => {
    page.on('pageerror', () => failures.push('Page runtime failure'))
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
  const cdp = await context.newCDPSession(source)
  const worlds = new Map()
  cdp.on('Runtime.executionContextCreated', ({ context }) =>
    worlds.set(context.id, context),
  )
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
    worlds.delete(executionContextId),
  )
  cdp.on('Runtime.executionContextsCleared', () => worlds.clear())
  await cdp.send('Runtime.enable')
  await source.goto(base)
  await source.evaluate(() => {
    const canvas = document.querySelector('#noise')
    canvas.width = innerWidth
    canvas.height = innerHeight
    const ctx = canvas.getContext('2d'),
      pixels = ctx.createImageData(canvas.width, canvas.height)
    let seed = 1234567
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      pixels.data[i] = seed & 255
      pixels.data[i + 1] = (seed >>> 8) & 255
      pixels.data[i + 2] = (seed >>> 16) & 255
      pixels.data[i + 3] = 255
    }
    ctx.putImageData(pixels, 0, 0)
  })
  let contentWorld
  await expect
    .poll(async () => {
      for (const world of worlds.values()) {
        if (world.auxData?.isDefault) continue
        const result = await cdp.send('Runtime.evaluate', {
          contextId: world.id,
          expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(workerUrl.host)}`,
          returnByValue: true,
        })
        if (result.result.value) contentWorld = world.id
      }
      return !!contentWorld
    })
    .toBe(true)
  const sourceEval = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', {
      contextId: contentWorld,
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    assert(!result.exceptionDetails, 'Source-world evaluation succeeds')
    return result.result.value
  }
  const panel = await context.newPage()
  await panel.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('root').style.width = '400px'
    }),
  )
  await panel.addInitScript(() => {
    globalThis.sdRetainedImageEvents = 0
    const callbacks = new Map()
    const add = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged)
    const remove = chrome.storage.onChanged.removeListener.bind(chrome.storage.onChanged)
    chrome.storage.onChanged.addListener = (callback) => {
      const wrapped = (changes, area) => {
        if (area === 'local' && (
          changes.steps?.newValue?.length || changes.steps?.oldValue?.length ||
          changes.pendingSession?.newValue?.steps?.length || changes.pendingSession?.oldValue?.steps?.length
        )) globalThis.sdRetainedImageEvents++
        return callback(changes, area)
      }
      callbacks.set(callback, wrapped)
      add(wrapped)
    }
    chrome.storage.onChanged.removeListener = (callback) => {
      remove(callbacks.get(callback) ?? callback)
      callbacks.delete(callback)
    }
  })
  await panel.goto(`${origin}/sidepanel.html`)
  const message = (type, extra = {}) =>
    panel.evaluate(
      ({ type, extra }) => chrome.runtime.sendMessage({ type, ...extra }),
      { type, extra },
    )
  const phase = () =>
    worker.evaluate(
      async () =>
        (await chrome.storage.local.get('captureReview')).captureReview?.phase,
    )
  const press = async (hook) => {
    const button = panel.locator(`[data-sd=${hook}]`)
    await expect(button)
      .toBeEnabled()
      .catch(async (error) => {
        const state = await message('GET_STATE')
        console.log('Control readiness', {
          hook,
          phase: state.captureReview?.phase,
          recording: state.recording,
          count: state.capturedSteps?.length,
          hasError: !!state.captureError,
          startedNotice: await panel.evaluate(() =>
            [...document.querySelectorAll('[role=status]')].some((element) =>
              element.textContent?.includes('Capture started.'),
            ),
          ),
        })
        throw error
      })
    await button.evaluate((element) => element.click())
  }
  await expect(panel.locator('[data-sd=capture-start]')).toBeEnabled()
  await source.bringToFront()
  await press('capture-start')
  await expect.poll(phase, { timeout: 20000 }).toBe('recording')
  await source.locator('#private').fill('PRIVATE_LARGE_CAPTURE_VALUE')
  await expect(panel.locator('[data-sd-step="1"]')).toBeVisible({ timeout: 20000 })
  assert.equal(
    await panel.evaluate(() => globalThis.sdRetainedImageEvents),
    0,
    'Controls must not receive retained-image storage change bodies',
  )
  for (let index = 0; index < 23; index++) {
    await source.locator('#action').click()
    try {
      await expect
        .poll(async () => worker.evaluate(async () => {
          const state = await chrome.storage.local.get(['capturedSteps', 'captureError'])
          return state.captureError ?? state.capturedSteps?.length
        }), { timeout: 20000 })
        .toBe(index + 2)
    } catch (error) {
      const state = await message('GET_STATE').catch(() => null)
      const visible = await source.evaluate(() => ({
        focus: document.hasFocus(), visibility: document.visibilityState,
      })).catch(() => null)
      console.log('Large capture boundary', {
        expected: index + 2, count: state?.capturedSteps?.length,
        phase: state?.captureReview?.phase, recording: state?.recording,
        failed: !!state?.captureError, visible,
      })
      throw error
    }
    if ((index + 2) % 8 === 0)
      console.log(`Retained ${index + 2} real masked steps`)
  }
  const retained = await worker.evaluate(async () => {
    const state = await chrome.storage.local.get([
      'steps',
      'capturedSteps',
      'captureSessionId',
    ])
    const file = await (await fetch(state.steps[0].screenshot)).blob()
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
    )
    return {
      sessionId: state.captureSessionId,
      stepId: state.capturedSteps[0].id,
      bytes: state.steps.reduce((sum, step) => sum + step.screenshot.length, 0),
      width: state.capturedSteps[0].screenshot.width,
      hash: [...hash]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
      privateText: JSON.stringify(state.capturedSteps).includes(
        'PRIVATE_LARGE_CAPTURE_VALUE',
      ),
    }
  })
  assert(
    retained.bytes > 64 * 1024 * 1024,
    'The real retained images exceed the runtime-message ceiling',
  )
  assert.equal(retained.privateText, false)
  const view = await message('GET_STATE')
  assert.equal(view.capturedSteps.length, 24)
  assert.equal(view.capturedSteps[0].valueKind, 'secret')
  assert(view.capturedSteps[0].maskCount > 0)
  assert(
    Buffer.byteLength(JSON.stringify(view)) < 32768,
    'Controls receive bounded display metadata',
  )
  assert(!JSON.stringify(view).includes('data:image/'))
  assert(!('steps' in view))
  assert(!('screenshot' in view.capturedSteps[0]))
  const sourceState = await sourceEval(
    'chrome.runtime.sendMessage({type:"CONTENT_STATE"})',
  )
  assert.equal(sourceState.stepCount, 24)
  assert.equal(sourceState.recording, true)
  assert(Buffer.byteLength(JSON.stringify(sourceState)) < 2048)
  assert(
    !('steps' in sourceState) &&
      !('capturedSteps' in sourceState) &&
      !('captureReview' in sourceState),
  )
  assert.deepEqual(
    await sourceEval('chrome.runtime.sendMessage({type:"GET_STATE"})'),
    { ok: false, error: 'forbidden' },
  )
  assert.deepEqual(
    await sourceEval(
      `chrome.runtime.sendMessage(${JSON.stringify({ type: 'CAPTURE_PREVIEW', sessionId: retained.sessionId, stepId: retained.stepId })})`,
    ),
    { ok: false, error: 'forbidden' },
  )
  assert.equal(
    await sourceEval(
      `new Promise((resolve,reject)=>{const open=indexedDB.open('stepdoc-capture-previews-v1');open.onsuccess=()=>{const db=open.result;const isolated=!db.objectStoreNames.contains('previews');db.close();resolve(isolated)};open.onerror=()=>reject(new Error('Fixture IDB unavailable'))})`,
    ),
    true,
  )
  const cache = async (operation, key) =>
    worker.evaluate(
      async ({ operation, key }) => {
        const db = await new Promise((resolve, reject) => {
          const open = indexedDB.open('stepdoc-capture-previews-v1', 1)
          open.onsuccess = () => resolve(open.result)
          open.onerror = () => reject(new Error('Cache unavailable'))
        })
        try {
          const tx = db.transaction(
            'previews',
            operation === 'read' ? 'readonly' : 'readwrite',
          )
          const store = tx.objectStore('previews')
          const request =
            operation === 'clear'
              ? store.clear()
              : operation === 'delete'
                ? store.delete(key)
                : store.getAll()
          const result = await new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(request.result)
            tx.onabort = () => reject(new Error('Cache unavailable'))
          })
          if (operation !== 'read') return []
          const info = []
          for (const file of result) {
            const image = await createImageBitmap(file)
            info.push({
              width: image.width,
              height: image.height,
              size: file.size,
              type: file.type,
            })
            image.close()
          }
          return info
        } finally {
          db.close()
        }
      },
      { operation, key },
    )
  await expect.poll(async () => (await cache('read')).length).toBe(24)
  const files = await cache('read')
  assert.equal(files.length, 24)
  for (const file of files) {
    assert(file.width <= 224 && file.height <= 144)
    assert(file.size > 0 && file.size <= 65536)
    assert.equal(file.type, 'image/webp')
  }
  await panel.bringToFront()
  await expect(panel.locator('[data-sd-step="1"] img')).toBeVisible()
  await cache('delete', [retained.sessionId, retained.stepId])
  await panel.reload()
  await expect(panel.locator('[data-sd-step="1"] img')).toBeVisible()
  assert.equal(
    (await cache('read')).length,
    24,
    'Reopened controls recover a missing older preview automatically',
  )
  assert.equal(
    await panel.locator('[data-sd-step]').count(),
    24,
    'Every step remains in the DOM',
  )
  const thumbnail = await panel
    .locator('[data-sd-step="1"] img')
    .evaluate(async (image) => {
      const file = await (await fetch(image.src)).blob()
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        size: file.size,
      }
    })
  assert(
    thumbnail.width <= 224 &&
      thumbnail.height <= 144 &&
      thumbnail.size <= 65536,
  )
  assert.deepEqual(
    (await new AxeBuilder({ page: panel }).analyze()).violations,
    [],
  )
  console.log(
    `Bounded controls and private masked previews verified above ${Math.floor(retained.bytes / 1024 / 1024)} MiB`,
  )
  await cache('clear')
  assert.deepEqual(
    await message('CAPTURE_PREVIEW', {
      sessionId: retained.sessionId,
      stepId: retained.stepId,
    }),
    { ok: true },
  )
  assert.equal(
    (await cache('read')).length,
    1,
    'An older capture recovers only the requested preview',
  )
  assert.equal(
    await message('CAPTURE_PREVIEW', {
      sessionId: crypto.randomUUID(),
      stepId: retained.stepId,
    }).then((reply) => reply.ok),
    false,
  )
  assert.equal(
    await message('CAPTURE_PREVIEW', {
      sessionId: retained.sessionId,
      stepId: 'missing',
    }).then((reply) => reply.ok),
    false,
  )
  await press('capture-pause')
  await expect.poll(phase, { timeout: 20000 }).toBe('paused')
  await press('capture-review')
  await expect.poll(phase, { timeout: 20000 }).toBe('review')
  await expect(panel.locator('#status')).toHaveText(
    'Capture stopped. Review before saving.',
    { timeout: 20000 },
  )
  const first = panel.locator('[data-sd-step="1"]')
  const selection = first.locator('[data-sd=capture-select-step]')
  await expect(selection).toBeEnabled()
  await selection.focus()
  await expect(selection).toBeFocused()
  await panel.keyboard.press('Alt+ArrowDown')
  // This durable edit rewrites more than 71 MiB. Await the real UI command
  // acknowledgement within the existing large-operation budget, then verify
  // the committed order with the unchanged five-second metadata assertion.
  try {
    await expect(panel.locator('#status')).toHaveText('Review updated.', {
      timeout: 20000,
    })
  } catch (error) {
    console.log('Large-review failure metadata', await worker.evaluate(async (id) => {
      const state = await chrome.storage.local.get(['captureReview', 'capturedSteps', 'recording'])
      return {
        phase: state.captureReview?.phase, revision: state.captureReview?.revision,
        recording: state.recording, count: state.capturedSteps?.length,
        retainedStepIndex: state.capturedSteps?.findIndex((step) => step.id === id),
      }
    }, retained.stepId).catch(() => ({ workerUnavailable: true })))
    throw error
  }
  await expect
    .poll(async () => (await message('GET_STATE')).capturedSteps[1]?.id)
    .toBe(retained.stepId)
  const unchanged = await worker.evaluate(async (stepId) => {
    const state = await chrome.storage.local.get(['steps', 'capturedSteps'])
    const index = state.capturedSteps.findIndex((step) => step.id === stepId)
    const file = await (await fetch(state.steps[index].screenshot)).blob()
    const hash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
    )
    return [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }, retained.stepId)
  assert.equal(
    unchanged,
    retained.hash,
    'Preview reads, reopen and reorder preserve full-resolution source bytes',
  )
  const editorOpened = context.waitForEvent('page')
  await press('capture-save')
  await expect.poll(phase, { timeout: 30000 }).toBe('idle')
  const editor = await editorOpened
  await expect(editor.locator('[data-sd=canvas-image]')).toHaveAttribute(
    'aria-busy',
    'false',
  )
  assert.equal(
    await editor
      .locator('[data-sd=canvas-image] img')
      .evaluate((image) => image.naturalWidth),
    retained.width,
  )
  assert.equal(
    (await cache('read')).length,
    0,
    'Successful save clears disposable previews',
  )
  await source.bringToFront()
  await press('capture-start')
  await expect.poll(phase, { timeout: 20000 }).toBe('recording')
  await panel.bringToFront()
  await expect(panel.locator('[data-sd=capture-review]')).toBeEnabled()
  await source.bringToFront()
  await worker.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local)
    const put = IDBObjectStore.prototype.put
    let held = false
    globalThis.capturePersistWaiting = false
    globalThis.maskValidationObserved = false
    globalThis.expectMaskValidation = false
    globalThis.previewWriteFailed = false
    const gate = new Promise((resolve) => {
      globalThis.releaseCapturePersist = resolve
    })
    chrome.storage.local.get = async (...args) => {
      const result = await get(...args)
      const keys = args[0]
      if (
        !held &&
        Array.isArray(keys) &&
        keys.includes('steps') &&
        keys.includes('capturedSteps') &&
        keys.includes('recording')
      ) {
        held = true
        globalThis.capturePersistWaiting = true
        await gate
      }
      if (
        globalThis.expectMaskValidation &&
        Array.isArray(keys) &&
        keys.length === 3 &&
        keys.includes('recording') &&
        keys.includes('captureTabId')
      )
        setTimeout(() => {
          globalThis.maskValidationObserved = true
        }, 0)
      return result
    }
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'previews' && !globalThis.previewWriteFailed) {
        globalThis.previewWriteFailed = true
        throw new Error('Injected disposable cache failure')
      }
      return put.apply(this, args)
    }
    globalThis.restoreCaptureStorage = () => {
      chrome.storage.local.get = get
      IDBObjectStore.prototype.put = put
    }
  })
  await source.reload()
  await expect
    .poll(() => worker.evaluate(() => globalThis.capturePersistWaiting))
    .toBe(true)
  await source.keyboard.press('Alt+b')
  await expect
    .poll(() =>
      worker.evaluate(
        async () =>
          (await chrome.storage.local.get('captureBlurMode')).captureBlurMode,
      ),
    )
    .toBe(true)
  await worker.evaluate(() => {
    globalThis.expectMaskValidation = true
  })
  await source.locator('#action').click()
  await expect
    .poll(() => worker.evaluate(() => globalThis.maskValidationObserved))
    .toBe(true)
  await worker.evaluate(() => {
    releaseCapturePersist()
  })
  await expect
    .poll(async () => (await message('GET_STATE')).capturedSteps.length)
    .toBe(1)
  await expect
    .poll(() => worker.evaluate(() => globalThis.previewWriteFailed))
    .toBe(true)
  const afterPrivacyRetry = await worker.evaluate(async () => ({
    cacheFailed: globalThis.previewWriteFailed,
    masks: (
      await chrome.storage.local.get('capturedSteps')
    ).capturedSteps[0].redactions.map((item) => item.source),
  }))
  assert(
    afterPrivacyRetry.masks.includes('manual'),
    'A mask added during the storage read must invalidate the old candidate before any source write',
  )
  assert.equal(
    (await message('GET_STATE')).capturedSteps[0].action,
    'navigate',
    'A privacy retry must not lose the navigation to duplicate suppression',
  )
  assert(
    afterPrivacyRetry.cacheFailed,
    'The disposable preview failure was exercised',
  )
  await worker.evaluate(() => {
    restoreCaptureStorage()
  })
  await panel.bringToFront()
  await expect(panel.locator('[data-sd-step="1"] img')).toBeVisible()
  console.log(
    'Privacy fence retry and recovery after a failed disposable cache write verified',
  )
  await press('capture-review')
  await expect.poll(phase, { timeout: 20000 }).toBe('review')
  const beforeDiscard = await message('GET_STATE')
  await cache('clear')
  await worker.evaluate(() => {
    const original = createImageBitmap.bind(globalThis)
    globalThis.previewGateRequested = false
    const gate = new Promise((resolve) => {
      globalThis.releasePreviewGate = resolve
    })
    globalThis.restorePreviewDecoder = () => {
      globalThis.createImageBitmap = original
    }
    globalThis.createImageBitmap = async (...args) => {
      globalThis.previewGateRequested = true
      await gate
      return original(...args)
    }
  })
  const delayedPreview = message('CAPTURE_PREVIEW', {
    sessionId: beforeDiscard.captureSessionId,
    stepId: beforeDiscard.capturedSteps[0].id,
  })
  await expect
    .poll(() => worker.evaluate(() => globalThis.previewGateRequested))
    .toBe(true)
  await panel.bringToFront()
  await press('capture-discard')
  await press('capture-confirm')
  await expect.poll(phase).toBe('idle')
  await worker.evaluate(() => {
    releasePreviewGate()
    restorePreviewDecoder()
  })
  assert.equal(
    (await delayedPreview).ok,
    false,
    'Discard wins over in-flight preview recovery',
  )
  assert.equal((await cache('read')).length, 0)
  assert.deepEqual(failures, [])
  assert.equal(
    await panel.evaluate(() => globalThis.sdRetainedImageEvents),
    0,
    'Capture, reorder, save and recovery never deliver retained-image change bodies to controls',
  )
  console.log(
    'Native capture controls verified: real >64 MiB retained capture, metadata-only controls/source state, private bounded previews, reopen and old-cache recovery, source isolation, stale/unknown rejection, pause/review/reorder, source hash preservation, full-resolution native editor save, storage-read privacy retry, disposable-cache failure, discard during recovery and axe; no upload.',
  )
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}

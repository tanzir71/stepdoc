import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { extensionWorker } from './extension-worker.mjs'

let apiRequests = 0
const server = createServer((request, response) => {
  if (request.url.startsWith('/api/')) apiRequests++
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end(`<!doctype html><html lang="en"><head><title>Local cleanup fixture</title><link rel="icon" href="data:,"></head>
    <body><main><h1>Workflow</h1><label>Invoice email<input type="email" id="private"></label>
    <button id="plan">Plan</button><button id="continue" onclick="document.querySelector('#result').hidden=false">Continue</button>
    <h2 id="result" hidden>Ready to continue</h2></main></body></html>`)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const digest = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
const screens = new URL(
  update ? '../../../docs/v2/screens/' : '../../../test-results/screens/',
  import.meta.url,
)
const trees = new URL('../tests/cleanup/', import.meta.url)
await mkdir(screens, { recursive: true })
await mkdir(trees, { recursive: true })
let context
try {
  const directory = fileURLToPath(
    new URL('../.output/chrome-mv3/', import.meta.url),
  )
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 600, height: 900 },
    args: [
      '--disable-gpu',
      `--disable-extensions-except=${directory}`,
      `--load-extension=${directory}`,
    ],
  })
  const failures = []
  context.on('page', (page) => {
    page.on('pageerror', () => failures.push('Page runtime error'))
    page.on('request', (request) => {
      if (
        !['chrome-extension:', base, 'data:', 'blob:'].some((prefix) =>
          request.url().startsWith(prefix),
        )
      )
        failures.push('Unexpected external request')
    })
  })
  const worker = await extensionWorker(context)
  const extensionUrl = new URL(worker.url())
  const root = `${extensionUrl.protocol}//${extensionUrl.host}`
  const source = await context.newPage()
  await source.goto(`${base}/workflow?PRIVATE_QUERY#PRIVATE_FRAGMENT`)
  await source.locator('#private').fill('PRIVATE_TYPED_NEVER_RECORDED')
  const panel = await context.newPage()
  await panel.goto(`${root}/sidepanel.html`)
  const raw = () => worker.evaluate(() => chrome.storage.local.get(null))
  const message = (type, extra = {}) =>
    panel.evaluate(
      ({ type, extra }) => chrome.runtime.sendMessage({ type, ...extra }),
      { type, extra },
    )
  const press = async (hook) => {
    const button = panel.locator(`[data-sd="${hook}"]`)
    await expect(button).toBeEnabled()
    await button.evaluate((element) => element.click())
  }
  const count = (length) =>
    expect
      .poll(
        async () => {
          const state = await raw()
          return state.captureError ?? state.capturedSteps?.length
        },
        { timeout: 20000 },
      )
      .toBe(length)
  const phase = (value) =>
    expect
      .poll(async () => (await raw()).captureReview?.phase, { timeout: 20000 })
      .toBe(value)
  await source.bringToFront()
  await press('capture-start')
  await phase('recording')
  await source.locator('#plan').click()
  await count(1)
  await source.locator('#plan').click()
  await count(2)
  await source.locator('#continue').click()
  await count(3)
  await expect
    .poll(async () => (await raw()).capturedSteps[2]?.expect?.visible?.name)
    .toBe('Ready to continue')
  await press('capture-review')
  await phase('review')
  // Restore a legacy vague title on an otherwise real, privacy-masked capture.
  await worker.evaluate(async () => {
    const { capturedSteps } = await chrome.storage.local.get('capturedSteps')
    capturedSteps[2].title = 'Click here'
    capturedSteps[2].notes = 'Keep the narrated note'
    await chrome.storage.local.set({ capturedSteps })
  })
  await panel.setViewportSize({ width: 400, height: 900 })
  await panel.reload()
  await panel.bringToFront()
  await expect(
    panel.getByRole('heading', { name: '3 clean-up suggestions' }),
  ).toBeVisible()
  const retained = await raw()
  assert(!JSON.stringify(retained).includes('PRIVATE_TYPED_NEVER_RECORDED'))
  assert(!JSON.stringify(retained).includes('PRIVATE_QUERY'))
  assert(
    retained.capturedSteps.every((step) =>
      step.redactions.some((mask) => mask.rule === 'form-value'),
    ),
  )
  const projected = await message('GET_STATE')
  assert.deepEqual(
    projected.cleanupSuggestions.map((item) => item.kind),
    ['merge', 'rename', 'check'],
  )
  assert(
    projected.cleanupSuggestions.every(
      (item) =>
        !('screenshot' in item) && !('target' in item) && !('value' in item),
    ),
  )

  async function inspect(name, width = 400) {
    await panel.setViewportSize({ width, height: 900 })
    await panel.bringToFront()
    const violations = (await new AxeBuilder({ page: panel }).analyze())
      .violations
    assert.deepEqual(
      violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
      })),
      [],
      `Axe ${name}`,
    )
    assert(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    )
    const aria = await panel.locator('.capture-panel').ariaSnapshot()
    const tree = new URL(`${name}.aria.txt`, trees)
    if (update) await writeFile(tree, `${aria}\n`)
    else
      assert.equal(
        `${aria}\n`,
        (await readFile(tree, 'utf8')).replaceAll('\r\n', '\n'),
        `Aria ${name}`,
      )
    const file = await panel.screenshot()
    await writeFile(new URL(`m11-${name}.png`, screens), file)
    if (!(await panel.getByRole('dialog').isVisible())) {
      const geometry = await panel
        .locator('.capture-cleanup-card')
        .evaluate((card) => {
          const icon = card.querySelector('[data-asset="capture-cleanup"]')
          const bounds = icon.getBoundingClientRect(),
            rectangle = card.getBoundingClientRect()
          return {
            left: rectangle.x,
            width: rectangle.width,
            padding: getComputedStyle(card).paddingLeft,
            radius: getComputedStyle(card).borderRadius,
            icon: [bounds.width, bounds.height],
            mask: getComputedStyle(icon).getPropertyValue('--sd-icon-image'),
            point: { x: bounds.x, y: bounds.y },
          }
        })
      assert.deepEqual(
        [
          geometry.left,
          geometry.width,
          geometry.padding,
          geometry.radius,
          geometry.icon,
        ],
        [16, width - 32, '14px', '12px', [16, 16]],
      )
      assert.match(geometry.mask, /8004d-.*\.svg/)
      const ink = await panel.evaluate(
        async ({ data, point }) => {
          const bytes = Uint8Array.from(atob(data), (byte) =>
            byte.charCodeAt(0),
          )
          const image = await createImageBitmap(
            new Blob([bytes], { type: 'image/png' }),
          )
          try {
            const canvas = new OffscreenCanvas(image.width, image.height),
              ctx = canvas.getContext('2d')
            ctx.drawImage(image, 0, 0)
            const pixels = ctx.getImageData(
              Math.floor(point.x),
              Math.floor(point.y),
              16,
              16,
            ).data
            const background = pixels.slice(0, 3)
            let changed = 0
            for (let at = 0; at < pixels.length; at += 4)
              if (
                [0, 1, 2].some(
                  (channel) =>
                    Math.abs(pixels[at + channel] - background[channel]) > 25,
                )
              )
                changed++
            return changed
          } finally {
            image.close()
          }
        },
        { data: file.toString('base64'), point: geometry.point },
      )
      assert(
        ink > 10,
        'Original cleanup sparkle must paint in its exact design slot',
      )
    }
  }
  await inspect('cleanup-light')
  await panel.locator('[data-sd="capture-cleanup-open"]').focus()
  await panel.keyboard.press('Enter')
  const dialog = panel.getByRole('dialog', {
    name: 'Review clean-up suggestions',
  })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox')).toHaveCount(3)
  await inspect('cleanup-dialog-light')
  for (const checkbox of await dialog.getByRole('checkbox').all())
    await checkbox.uncheck()
  await expect(
    panel.locator('[data-sd="capture-cleanup-apply"]'),
  ).toBeDisabled()
  await panel.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(panel.locator('[data-sd="capture-cleanup-open"]')).toBeFocused()
  assert.equal(
    digest((await raw()).capturedSteps),
    digest(retained.capturedSteps),
  )
  assert.equal(new URL(panel.url()).searchParams.has('cleanup'), false)
  await press('capture-cleanup-open')
  assert.equal(new URL(panel.url()).searchParams.get('cleanup'), 'review')
  await panel.reload()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox')).toHaveCount(3)
  await press('capture-cleanup-cancel')

  await panel.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await inspect('cleanup-dark')
  await press('capture-cleanup-open')
  await inspect('cleanup-dialog-dark')
  await press('capture-cleanup-cancel')
  await inspect('cleanup-narrow', 320)
  await press('capture-cleanup-open')
  await inspect('cleanup-dialog-narrow', 320)
  // Another controls page changes this revision while the dialog stays open.
  const other = await context.newPage()
  await other.goto(`${root}/sidepanel.html`)
  const revised = await other.evaluate(
    ({ sessionId, revision }) =>
      chrome.runtime.sendMessage({
        type: 'EDIT_REVIEW',
        sessionId,
        revision,
        edit: { operation: 'title', title: 'Reviewed workflow' },
      }),
    {
      sessionId: retained.captureSessionId,
      revision: retained.captureReview.revision,
    },
  )
  assert.equal(revised.ok, true)
  await panel.bringToFront()
  await expect(dialog.getByRole('status')).toContainText('This capture changed')
  await expect(
    panel.locator('[data-sd="capture-cleanup-apply"]'),
  ).toBeDisabled()
  assert.equal(
    (
      await message('EDIT_REVIEW', {
        sessionId: retained.captureSessionId,
        revision: retained.captureReview.revision,
        edit: { operation: 'cleanup', ids: ['merge-1'] },
      })
    ).ok,
    false,
  )
  await press('capture-cleanup-cancel')
  await other.close()
  const current = await raw()
  assert.equal(
    (
      await message('EDIT_REVIEW', {
        sessionId: current.captureSessionId,
        revision: current.captureReview.revision,
        edit: { operation: 'cleanup', ids: ['forged'] },
      })
    ).ok,
    false,
  )
  assert.equal(
    (await raw()).captureReview.revision,
    current.captureReview.revision,
  )

  // Apply only the rename, then fail the single native storage commit once.
  await press('capture-cleanup-open')
  await dialog.getByRole('checkbox').nth(0).uncheck()
  await dialog.getByRole('checkbox').nth(2).uncheck()
  await worker.evaluate(() => {
    globalThis.sdCleanupSet = chrome.storage.local.set
    const set = chrome.storage.local.set.bind(chrome.storage.local)
    globalThis.sdCleanupReject = true
    chrome.storage.local.set = async (value) => {
      if (
        globalThis.sdCleanupReject &&
        value.capturedSteps &&
        value.captureReview
      ) {
        globalThis.sdCleanupReject = false
        throw new Error('Local commit fixture')
      }
      return set(value)
    }
  })
  await press('capture-cleanup-apply')
  await expect(panel.locator('#status')).toContainText(
    'Operation could not finish',
  )
  await expect(dialog.getByRole('status')).toContainText(
    'Your review is retained. Retry or cancel.',
  )
  await inspect('cleanup-dialog-failure', 320)
  assert.equal(
    digest((await raw()).capturedSteps),
    digest(current.capturedSteps),
  )
  assert.equal(
    (await raw()).captureReview.revision,
    current.captureReview.revision,
  )
  await expect(dialog.getByRole('checkbox').nth(1)).toBeChecked()
  await worker.evaluate(() => {
    chrome.storage.local.set = globalThis.sdCleanupSet
    delete globalThis.sdCleanupSet
    delete globalThis.sdCleanupReject
  })
  await press('capture-cleanup-apply')
  await expect(dialog).not.toBeVisible()
  await expect(panel.locator('[data-sd-step="3"]')).toContainText(
    'Click "Continue"',
  )
  assert.equal((await raw()).capturedSteps[2].action, 'click')
  assert.equal(digest((await raw()).steps), digest(retained.steps))
  await press('capture-cleanup-open')
  await expect(dialog.getByRole('checkbox')).toHaveCount(2)
  await press('capture-cleanup-apply')
  await expect(dialog).not.toBeVisible()
  const cleaned = await raw()
  assert.deepEqual(
    cleaned.capturedSteps.map((step) => [step.type, step.index]),
    [
      ['manual', 1],
      ['action', 2],
      ['assert', 3],
    ],
  )
  assert.equal(cleaned.capturedSteps[1].notes, 'Keep the narrated note')
  assert.deepEqual(
    cleaned.capturedSteps[2].expect,
    retained.capturedSteps[2].expect,
  )
  assert.deepEqual(
    cleaned.capturedSteps[2].redactions,
    retained.capturedSteps[2].redactions,
  )
  assert.equal(
    digest(cleaned.steps[0].screenshot),
    digest(retained.steps[0].screenshot),
  )
  assert.equal(
    digest(cleaned.steps[1].screenshot),
    digest(retained.steps[2].screenshot),
  )
  assert.equal(
    digest(cleaned.steps[2].screenshot),
    digest(retained.steps[2].screenshot),
  )
  assert.equal(new Set(cleaned.capturedSteps.map((step) => step.id)).size, 3)
  await panel.reload()
  await expect(panel.locator('[data-sd-step]')).toHaveCount(3)
  await expect(panel.locator('[data-sd="capture-cleanup-open"]')).toHaveCount(0)
  assert.equal(
    (
      await message('CAPTURE_PREVIEW', {
        sessionId: cleaned.captureSessionId,
        stepId: cleaned.capturedSteps[2].id,
      })
    ).ok,
    true,
    'The new check can recover a bounded preview of its masked source',
  )
  await panel.locator('[data-sd="capture-title"]').fill('Cleaned workflow')
  const opened = context.waitForEvent('page')
  await press('capture-save')
  const editor = await opened
  await expect(
    editor.getByRole('heading', { name: 'Cleaned workflow', exact: true }),
  ).toBeVisible()
  await editor.reload()
  await expect(editor.locator('[data-sd="editor-step-select"]')).toHaveCount(3)
  await phase('idle')
  assert.equal(apiRequests, 0)
  assert.deepEqual(failures, [])
  console.log(
    'Native cleanup verified: real masked capture, three metadata-only proposals, original 16px Figma asset/geometry, light/dark/narrow aria/axe, keyboard/Escape, deselection, stale/forged rejection, atomic failure/retry, selected rename/manual merge/additional check, preserved notes/masks/source bytes, preview recovery and native editor save/reload; no AI/backend requests.',
  )
} finally {
  await context?.close()
  await new Promise((resolve) => server.close(resolve))
}

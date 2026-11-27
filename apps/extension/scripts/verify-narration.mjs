import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { extensionWorker } from './extension-worker.mjs'

// Only the operating-system speech boundary is a stand-in. Capture, controls,
// runtime authorization, IndexedDB/OPFS, editor and downloaded export are real.
function speechStandIn() {
  if (!globalThis.chrome?.runtime?.sendMessage) return
  const calls = [],
    instances = []
  const messages = []
  const send = chrome.runtime.sendMessage.bind(chrome.runtime)
  chrome.runtime.sendMessage = (command, ...rest) => {
    if (command?.type?.startsWith('NARRATION_'))
      messages.push(structuredClone(command))
    return send(command, ...rest)
  }
  class Speech {
    static async install(options) {
      calls.push(['install', options])
      return true
    }
    static async available(options) {
      calls.push(['available', options])
      return 'available'
    }
    get processLocally() {
      return this.local ?? false
    }
    set processLocally(value) {
      this.local = value
    }
    constructor() {
      instances.push(this)
    }
    start() {
      calls.push([
        'start',
        {
          local: this.processLocally,
          lang: this.lang,
          interim: this.interimResults,
        },
      ])
      this.onstart?.()
    }
    abort() {
      calls.push(['abort'])
    }
  }
  globalThis.SpeechRecognition = Speech
  globalThis.testSpeech = {
    calls,
    instances,
    messages,
    speak(text, index, final = true, boundary = true) {
      const speech = instances.at(-1)
      if (boundary) speech.onspeechstart?.()
      speech.onresult?.({
        resultIndex: index,
        results: Array.from({ length: index + 1 }, () => ({
          isFinal: final,
          0: { transcript: text },
        })),
      })
    },
  }
}
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end(
    '<!doctype html><html lang="en"><head><title>Local narration fixture</title><link rel="icon" href="data:,"></head><body><main><h1>Workflow</h1><button id="first">Open settings</button><button id="second">Apply settings</button></main></body></html>',
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const update = process.env.STEPDOC_UPDATE_SCREENS === '1'
const snapshots = new URL('../tests/narration/', import.meta.url)
const screens = new URL(
  update ? '../../../docs/v2/screens/' : '../../../test-results/screens/',
  import.meta.url,
)
await mkdir(snapshots, { recursive: true })
await mkdir(screens, { recursive: true })
let context,
  checks = 0
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
  const worker = await extensionWorker(context)
  const origin = new URL(worker.url()).origin.replace(
    'null',
    `chrome-extension://${new URL(worker.url()).host}`,
  )
  const failures = []
  context.on('page', (page) => {
    page.on('pageerror', (error) =>
      failures.push(`Page runtime error: ${error.message}`),
    )
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
  const session = await context.newCDPSession(source),
    worlds = new Map()
  session.on('Runtime.executionContextCreated', ({ context }) =>
    worlds.set(context.id, context),
  )
  session.on('Runtime.executionContextsCleared', () => worlds.clear())
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
    worlds.delete(executionContextId),
  )
  await session.send('Runtime.enable')
  await source.goto(base)
  const panel = await context.newPage()
  await panel.addInitScript(speechStandIn)
  await panel.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => {
      document.getElementById('root').style.width = '400px'
    }),
  )
  await panel.goto(`${origin}/sidepanel.html`)
  const state = () => worker.evaluate(() => chrome.storage.local.get(null))
  const hook = (name) => panel.locator(`[data-sd="${name}"]`)
  const rpc = (command) =>
    panel.evaluate((command) => chrome.runtime.sendMessage(command), command)
  const press = async (name) => {
    await expect(hook(name)).toBeEnabled({ timeout: 20000 })
    await hook(name).evaluate((element) => element.click())
  }
  const phase = (value) =>
    expect
      .poll(async () => (await state()).captureReview?.phase, {
        timeout: 20000,
      })
      .toBe(value)
  const count = (value) =>
    expect
      .poll(
        async () =>
          (await state()).captureError || (await state()).capturedSteps?.length,
        { timeout: 20000 },
      )
      .toBe(value)
  const check = (condition, message) => {
    assert(condition, message)
    checks++
  }
  const speech = (...args) =>
    panel.evaluate((args) => globalThis.testSpeech.speak(...args), args)
  async function inspect(name) {
    const tree = (await panel.locator('.capture-panel').ariaSnapshot()).replace(
      /\d{2}:\d{2}/g,
      '<elapsed>',
    )
    const file = new URL(name + '.aria.txt', snapshots)
    if (update) await writeFile(file, tree + '\n')
    else assert.equal(tree + '\n', await readFile(file, 'utf8'), name)
    check(
      (await new AxeBuilder({ page: panel }).analyze()).violations.length === 0,
      `Axe ${name}`,
    )
    check(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `No horizontal overflow ${name}`,
    )
    await panel
      .locator('.capture-panel')
      .screenshot({ path: fileURLToPath(new URL(name + '.png', screens)) })
  }
  await expect(hook('capture-start')).toBeEnabled()
  check(
    await panel.evaluate(() => testSpeech.calls.length === 0),
    'No speech API calls without opt-in',
  )
  await expect(hook('capture-voice-narration')).toHaveAttribute(
    'aria-checked',
    'false',
  )
  const geometry = await hook('capture-voice-narration').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  assert.deepEqual(geometry, { width: 32, height: 18 })
  checks++
  await inspect('e01-voice-light')
  await hook('capture-voice-narration').click()
  await expect(hook('capture-voice-language')).toBeVisible()
  await hook('capture-voice-language').fill('en-US')
  check(
    (await new AxeBuilder({ page: panel }).analyze()).violations.length === 0,
    'Narration setup axe',
  )
  await source.bringToFront()
  await press('capture-start')
  await phase('recording')
  await expect
    .poll(() =>
      panel.evaluate(
        () => testSpeech.calls.filter(([type]) => type === 'start').length,
      ),
    )
    .toBe(1)
  const calls = await panel.evaluate(() => testSpeech.calls)
  check(
    calls.every(([type, options]) =>
      type === 'start'
        ? options.local && options.interim === false
        : options.processLocally === true,
    ),
    'All recognition requires on-device processing',
  )
  await source.locator('#first').click()
  await count(1)
  await speech('INTERIM_PRIVATE', 0, false)
  await speech('Send the invoice to private@example.test', 0)
  await expect
    .poll(async () => (await state()).capturedSteps[0].notes)
    .toBe('Send the invoice to [REDACTED]')
  await speech('DUPLICATE_PRIVATE', 0, true, false)
  // The utterance starts on step one, then the workflow advances before its final result.
  await panel.evaluate(() => testSpeech.instances.at(-1).onspeechstart())
  await source.locator('#second').click()
  await count(2)
  await speech('Confirm the new plan', 1, true, false)
  await expect
    .poll(async () => (await state()).capturedSteps[0].notes)
    .toContain('Confirm the new plan')
  await speech('Check the saved settings', 2)
  await expect
    .poll(async () => (await state()).capturedSteps[1].notes)
    .toBe('Check the saved settings')
  check(
    !JSON.stringify(await state()).match(
      /INTERIM_PRIVATE|DUPLICATE_PRIVATE|private@example/,
    ),
    'No raw sensitive or unfinished transcript stored',
  )
  check(
    (await new AxeBuilder({ page: panel }).analyze()).violations.length === 0,
    'Active narration and notes axe',
  )
  const captured = await state()
  const owner = await panel.evaluate(
    () =>
      testSpeech.messages.find((command) => command.type === 'NARRATION_CLAIM')
        .owner,
  )
  const original = captured.capturedSteps[1].notes
  const lastWrite = await panel.evaluate(() =>
    testSpeech.messages
      .filter((command) => command.type === 'NARRATION_APPEND')
      .at(-1),
  )
  check(
    (await rpc(lastWrite)).ok,
    'Duplicate final acknowledgement is idempotent',
  )
  check(
    (await state()).capturedSteps[1].notes === original,
    'Duplicate final does not duplicate notes',
  )
  check(
    !(
      await rpc({ ...lastWrite, sessionId: crypto.randomUUID(), sequence: 500 })
    ).ok,
    'Stale capture session rejected',
  )
  check(
    !(await rpc({ ...lastWrite, stepId: 'missing', sequence: 500 })).ok,
    'Unknown step rejected',
  )
  let sourceWorld
  for (const world of [...worlds.values()].filter(
    (world) => !world.auxData?.isDefault,
  )) {
    const result = await session.send('Runtime.evaluate', {
      contextId: world.id,
      expression: 'globalThis.chrome?.runtime?.id',
      returnByValue: true,
    })
    if (result.result.value === new URL(worker.url()).host)
      sourceWorld = world.id
  }
  check(!!sourceWorld, 'Actual recorder content world discovered')
  const untrusted = await session.send('Runtime.evaluate', {
    contextId: sourceWorld,
    awaitPromise: true,
    returnByValue: true,
    expression: `chrome.runtime.sendMessage(${JSON.stringify({ ...lastWrite, sequence: 500, text: 'SOURCE_PRIVATE' })})`,
  })
  check(
    untrusted.result.value?.ok === false,
    'Source content cannot append narration, even with a valid owner/session',
  )
  check(
    !JSON.stringify(await state()).includes('SOURCE_PRIVATE'),
    'Source message left no notes',
  )
  check(
    await panel.evaluate(
      () =>
        !JSON.stringify(testSpeech.messages).match(
          /INTERIM_PRIVATE|DUPLICATE_PRIVATE|private@example/,
        ),
    ),
    'Runtime transport contains only final redacted text',
  )
  check(owner === lastWrite.owner, 'Notes use the active microphone owner')
  const competing = {
    type: 'NARRATION_CLAIM',
    owner: crypto.randomUUID(),
    sessionId: captured.captureSessionId,
  }
  check(
    !(await rpc(competing)).ok,
    'Second controls document cannot own an active microphone',
  )
  await press('capture-pause')
  await phase('paused')
  check(
    await panel.evaluate(() =>
      testSpeech.calls.some(([type]) => type === 'abort'),
    ),
    'Pause aborts recognition',
  )
  check(
    !(
      await rpc({
        ...competing,
        type: 'NARRATION_APPEND',
        stepId: captured.capturedSteps[0].id,
        sequence: 1,
        text: 'PAUSED_PRIVATE',
      })
    ).ok,
    'Paused writes denied',
  )
  await source.bringToFront()
  await press('capture-pause')
  await phase('recording')
  await expect
    .poll(() =>
      panel.evaluate(
        () => testSpeech.calls.filter(([type]) => type === 'start').length,
      ),
    )
    .toBe(2)
  // Reload keeps the capture but requires a new explicit microphone action.
  await panel.reload()
  await expect(hook('capture-voice-toggle')).toHaveText('Start narration')
  check(
    await panel.evaluate(() => testSpeech.calls.length === 0),
    'Reload does not silently rearm narration',
  )
  await panel.evaluate(() => {
    SpeechRecognition.install = async () => false
  })
  await press('capture-voice-toggle')
  await expect(
    panel.getByRole('region', { name: 'Voice narration' }),
  ).toContainText('Narration could not start')
  check(
    (await state()).recording,
    'Language-pack failure retains active capture',
  )
  await panel.evaluate(() => {
    SpeechRecognition.install = () =>
      new Promise((resolve) => {
        globalThis.finishSpeechInstall = resolve
      })
  })
  await press('capture-voice-toggle')
  await expect(hook('capture-voice-toggle')).toHaveText(
    'Cancel narration setup',
  )
  await expect(hook('capture-review')).toBeEnabled()
  await press('capture-voice-toggle')
  await panel.evaluate(() => {
    finishSpeechInstall(true)
    SpeechRecognition.install = async () => true
  })
  await expect(hook('capture-voice-toggle')).toHaveText('Start narration')
  check(
    await panel.evaluate(() => testSpeech.calls.length === 0),
    'Cancelled setup never starts the microphone',
  )
  await expect(panel.getByRole('status')).toHaveText('Narration is off.')
  await press('capture-voice-toggle')
  await expect(hook('capture-voice-toggle')).toHaveText('Stop narration')
  await press('capture-review')
  await phase('review')
  await expect(hook('capture-discard')).toBeEnabled({ timeout: 20000 })
  await expect(hook('capture-step-notes').first()).toContainText(
    'Send the invoice to [REDACTED]',
  )
  await inspect('e04-narration-light')
  await panel.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await inspect('e04-narration-dark')
  await panel.setViewportSize({ width: 360, height: 740 })
  await panel.evaluate(
    () => (document.getElementById('root').style.width = '100%'),
  )
  check(
    (await new AxeBuilder({ page: panel }).analyze()).violations.length === 0,
    'Narrow narration review axe',
  )
  await panel
    .getByRole('textbox', { name: 'Guide title' })
    .fill('Narrated workflow')
  await press('capture-keep-local')
  await phase('idle')
  const app = await context.newPage()
  await app.goto(
    `${origin}/app.html?route=${encodeURIComponent(`/g/capture-${captured.captureSessionId}/edit?step=1`)}`,
  )
  await expect(
    app.getByRole('heading', { name: 'Narrated workflow', exact: true }),
  ).toBeVisible()
  await app.locator('[data-sd=export-open]').click()
  await app.locator('[data-sd=export-format-json]').check()
  for (const format of await app.locator('[data-sd^=export-format-]').all())
    if (
      (await format.getAttribute('data-sd')) !== 'export-format-json' &&
      (await format.isChecked())
    )
      await format.uncheck()
  const download = app.waitForEvent('download')
  await app.locator('[data-sd=export-download]').click()
  const json = await readFile(await (await download).path(), 'utf8'),
    guide = JSON.parse(json)
  assert.deepEqual(
    guide.steps.map((step) => step.notes),
    [
      'Send the invoice to [REDACTED]\nConfirm the new plan',
      'Check the saved settings',
    ],
  )
  checks++
  check(
    !json.includes('PRIVATE') && !json.includes('private@example'),
    'Saved/exported notes contain only final redacted text',
  )
  // Unsupported browsers expose the beta limitation and leave ordinary capture usable.
  const unsupported = await context.newPage()
  await unsupported.addInitScript(() => {
    globalThis.SpeechRecognition = undefined
  })
  await unsupported.goto(`${origin}/sidepanel.html`)
  await expect(
    unsupported.locator('[data-sd=capture-voice-narration]'),
  ).toBeEnabled()
  await unsupported.locator('[data-sd=capture-voice-narration]').click()
  await expect(
    unsupported.locator('[data-sd=capture-voice-narration]'),
  ).toBeDisabled()
  await expect(
    unsupported.getByText(/On-device recognition is unavailable/),
  ).toBeVisible()
  await expect(unsupported.locator('[data-sd=capture-start]')).toBeEnabled()
  check(
    (await new AxeBuilder({ page: unsupported }).analyze()).violations
      .length === 0,
    'Unsupported state axe',
  )
  await hook('capture-voice-narration').click()
  await expect(hook('capture-voice-narration')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await context.addInitScript(speechStandIn)
  const popup = await context.newPage()
  await popup.goto(`${origin}/popup.html`)
  await expect(popup.locator('[data-sd=capture-start]'))
    .toBeEnabled()
    .catch(async (error) => {
      console.log(
        'Popup narration readiness',
        await popup.evaluate(() => ({
          ready: document.readyState,
          localSpeech: typeof globalThis.SpeechRecognition?.available,
          mock: !!globalThis.testSpeech,
          startDisabled: document.querySelector('[data-sd=capture-start]')
            ?.disabled,
        })),
        {
          phase: (await state()).captureReview?.phase,
          recording: (await state()).recording,
        },
      )
      throw error
    })
  await source.bringToFront()
  const opened = context.waitForEvent('page')
  await popup
    .locator('[data-sd=capture-start]')
    .evaluate((element) => element.click())
  const controls = await opened
  await controls.waitForURL(/popup.html\?surface=tab/)
  await expect(controls.locator('[data-sd=capture-start]')).toBeEnabled()
  await controls.locator('[data-sd=capture-voice-language]').fill('en-US')
  await popup.close()
  await controls.locator('[data-sd=capture-start]').click()
  await phase('recording')
  check(
    !controls.isClosed(),
    'Narration controls tab remains open after capture starts',
  )
  const handoff = await state()
  const sourceTab = await worker.evaluate(
    async (base) =>
      (await chrome.tabs.query({})).find((tab) => tab.url?.startsWith(base)),
    base,
  )
  check(
    handoff.captureTabId === sourceTab.id,
    'Popup handoff captures the original source',
  )
  await source.locator('#first').click()
  await count(1)
  // Persisted capture state can precede the controls' render/recognition claim.
  // Simulate speech only once the microphone stand-in is actually listening
  // and its target step has appeared, as the product instructions require.
  await expect(controls.locator('[data-sd-step="1"]')).toBeVisible()
  await expect
    .poll(() =>
      controls.evaluate(
        () => testSpeech.calls.filter(([type]) => type === 'start').length,
      ),
    )
    .toBe(1)
  await controls.evaluate(() =>
    testSpeech.speak('Narrated after popup closure', 0),
  )
  await expect
    .poll(async () => (await state()).capturedSteps[0].notes)
    .toBe('Narrated after popup closure')
  check(
    await controls.evaluate(() =>
      testSpeech.calls.some(([type]) => type === 'start'),
    ),
    'Persistent controls own recognition after popup closes',
  )
  await controls.close()
  check(
    (await state()).recording,
    'Closing narration controls retains the capture',
  )
  check(
    (await rpc({ type: 'CANCEL' })).ok,
    'Retained capture can be discarded after narration closes',
  )
  assert.deepEqual(failures, [])
  checks++
  console.log(
    `Native narration verified: ${checks} checks; explicit local speech API boundary, real capture/notes/redaction, utterance ownership, pause/resume/reload, review, native save/editor/JSON export and light/dark/narrow aria/axe. No live speech service or hardware.`,
  )
} finally {
  await context?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { extensionWorker } from './extension-worker.mjs'

// Trusted browser input into the production extension. Both HTTP origins are
// local fixtures; no values or input files are read by the recorder or a server.
let apiRequests = 0,
  cross
const frame = (
  name,
) => `<!doctype html><html lang="en"><head><title>Frame fixture</title><link rel="icon" href="data:,"></head><body>
<label>${name} field <input id="field" style="width:180px;height:28px"></label><button id="action">${name} action</button>
<div id="frame-shadow"></div><script>document.getElementById('frame-shadow').attachShadow({mode:'open'}).innerHTML='<label>${name} shadow <input id="shadow-field"></label><button>${name} shadow action</button>'</script></body></html>`
const handler = (req, res) => {
  if (req.url.startsWith('/api/')) apiRequests++
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url.startsWith('/same')) return res.end(frame('Same'))
  if (req.url.startsWith('/cross')) return res.end(frame('Cross'))
  res.end(`<!doctype html><html lang="en"><head><title>Input fixture</title><link rel="icon" href="data:,"><style>
body{font:14px Arial;margin:12px}main{display:grid;grid-template-columns:1fr 1fr;gap:10px}input:not([type=checkbox]):not([type=radio]){width:200px;height:28px}textarea{height:35px}iframe{width:550px;height:140px}#rich{border:1px solid;min-height:30px}</style></head><body><main>
<label>Root field <input id="text"></label><button id="next">Next action</button>
<button id="open-confirm" onclick="document.getElementById('confirmation').hidden=false">Open confirmation</button><div id="confirmation" role="dialog" aria-label="Confirmation" hidden>Confirmed</div>
<label>Secret field <input id="email" type="email"></label><label>Notes <textarea id="notes"></textarea></label>
<div id="rich" role="textbox" contenteditable="true" aria-label="Rich notes"></div><div id="shadow"></div>
<div><input id="check" type="checkbox"><label id="check-label" for="check">Enable logs</label></div>
<div><input id="radio-a" type="radio" name="plan"><label for="radio-a">Plan A</label><input id="radio-b" type="radio" name="plan"><label for="radio-b">Plan B</label></div>
<label>Document <input id="file" type="file"></label><span></span>
<iframe id="same" title="Same-origin fixture" src="/same?PRIVATE_QUERY#PRIVATE_FRAGMENT"></iframe>
<iframe id="cross" title="Cross-origin fixture" src="${cross}/cross?PRIVATE_QUERY#PRIVATE_FRAGMENT"></iframe>
</main><script>document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML='<label>Shadow field <input id="shadow-field"></label><button id="shadow-action">Shadow action</button>'</script></body></html>`)
}
const server = createServer(handler),
  other = createServer(handler)
await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve))
cross = `http://127.0.0.1:${other.address().port}`
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const fixtureFile = new URL(
  '../../../test-results/input-order/PRIVATE_FILENAME.txt',
  import.meta.url,
)
await mkdir(new URL('./', fixtureFile), { recursive: true })
await writeFile(fixtureFile, 'PRIVATE_FILE_CONTENT')
let context,
  checks = 0,
  serial = 0
try {
  const dir = fileURLToPath(new URL('../.output/chrome-mv3/', import.meta.url))
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    args: [
      '--disable-gpu',
      `--disable-extensions-except=${dir}`,
      `--load-extension=${dir}`,
    ],
  })
  const worker = await extensionWorker(context)
  const extensionId = new URL(worker.url()).host,
    origin = `chrome-extension://${extensionId}`
  const failures = []
  context.on('page', (page) => {
    page.on('pageerror', () => failures.push('Page runtime error'))
    page.on('request', (request) => {
      if (
        ![base, cross, origin, 'data:', 'blob:'].some((prefix) =>
          request.url().startsWith(prefix),
        )
      )
        failures.push('Nonlocal request')
    })
  })
  const source = await context.newPage(),
    session = await context.newCDPSession(source),
    worlds = new Map()
  session.on('Runtime.executionContextCreated', ({ context }) =>
    worlds.set(context.id, context),
  )
  session.on('Runtime.executionContextsCleared', () => worlds.clear())
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
    worlds.delete(executionContextId),
  )
  await session.send('Runtime.enable')
  await source.goto(`${base}/source?PRIVATE_QUERY#PRIVATE_FRAGMENT`)
  await expect(source.frameLocator('#cross').locator('#field')).toBeVisible()
  const panel = await context.newPage()
  await panel.goto(`${origin}/sidepanel.html`)
  const state = () => worker.evaluate(() => chrome.storage.local.get(null))
  const command = (type) =>
    panel.evaluate((type) => chrome.runtime.sendMessage({ type }), type)
  const hook = (name) => panel.locator(`[data-sd="${name}"]`)
  const enabled = async (name) => {
    try {
      await expect(hook(name)).toBeEnabled({ timeout: 20_000 })
    } catch (error) {
      console.log('Input control failure metadata', {
        control: name,
        worker: await worker.evaluate(async () => {
          const value = await chrome.storage.local.get([
            'recording',
            'captureReview',
            'capturedSteps',
            'captureError',
          ])
          return {
            phase: value.captureReview?.phase,
            recording: value.recording,
            count: value.capturedSteps?.length,
            hasError: !!value.captureError,
          }
        }),
        panel: await panel.evaluate(() => ({
          startedNotice: [...document.querySelectorAll('[role=status]')].some(
            (element) => element.textContent?.includes('Capture started.'),
          ),
          phase: document.querySelector('[data-phase]')?.dataset.phase,
        })),
      })
      throw error
    }
  }
  const press = async (name) => {
    await enabled(name)
    await hook(name).evaluate((el) => el.click())
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
          return value.captureError || value.capturedSteps?.length
        },
        { timeout: 20_000 },
      )
      .toBe(count)
  const data = () => `PRIVATE_INPUT_${++serial}`
  const text = source.locator('#text'),
    next = source.locator('#next'),
    same = source.frameLocator('#same'),
    remote = source.frameLocator('#cross')
  const pair = (name, button = 'Next action') => [
    ['fill', name],
    ['click', button],
  ]
  const check = (condition, message) => {
    assert(condition, message)
    checks++
  }
  async function start() {
    assert.equal((await command('CANCEL')).ok, true)
    await waitPhase('idle')
    await source.bringToFront()
    await press('capture-start')
    await waitPhase('recording')
    // The background records before Start's response/refresh has settled in
    // this separate controls tab. Complete that UI command before source input.
    await panel.bringToFront()
    await enabled('capture-review')
    await source.bringToFront()
  }
  async function finish(title, expected, inspect) {
    await waitSteps(expected.length)
    await press('capture-review')
    await waitPhase('review')
    await expect(hook('capture-discard')).toBeEnabled({ timeout: 20_000 })
    const value = await state()
    check(
      !JSON.stringify(value).includes('PRIVATE_'),
      'Typed data, file name or query in capture state',
    )
    assert.deepEqual(
      value.capturedSteps.map((step) => [step.action, step.target?.name]),
      expected,
      `Ordered actions: ${title}`,
    )
    checks++
    assert.deepEqual(
      value.capturedSteps.map((step) => step.index),
      expected.map((_, i) => i + 1),
    )
    checks++
    check(
      value.steps.length === expected.length,
      'Images and metadata stay aligned',
    )
    for (const [i, step] of value.capturedSteps.entries())
      if (step.action === 'fill' || step.action === 'upload') {
        check(
          ['variable', 'secret'].includes(step.value?.kind) &&
            step.value.variable === `field_${i + 1}` &&
            !('literal' in step.value),
          'Fill/upload uses only an ordered runtime reference',
        )
        check(
          step.redactions.some((item) => item.status === 'applied'),
          'Native input image is already redacted',
        )
      }
    inspect?.(value)
    console.log(`Verified input sequence: ${title}`)
    return value
  }
  // Patch the actual extension execution worlds, not the page/Playwright world.
  // Browser typing continues; any recorder value access fails the capture.
  const guarded = []
  await expect
    .poll(async () => {
      for (const world of worlds.values()) {
        if (world.auxData?.isDefault || guarded.includes(world.id)) continue
        const reply = await session.send('Runtime.evaluate', {
          contextId: world.id,
          expression: `globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}`,
          returnByValue: true,
        })
        if (!reply.result.value) continue
        await session.send('Runtime.evaluate', {
          contextId: world.id,
          expression: `(() => {
        globalThis.inputReadCount = 0;
        for (const Type of [HTMLInputElement, HTMLTextAreaElement]) {
          const descriptor = Object.getOwnPropertyDescriptor(Type.prototype, 'value');
          Object.defineProperty(Type.prototype, 'value', {...descriptor, get() { globalThis.inputReadCount++; throw new Error('Forbidden typed value read') }});
        }
        const rich = document.getElementById('rich');
        if (rich) for (const key of ['textContent', 'innerText']) Object.defineProperty(rich, key, { configurable: true, get() { globalThis.inputReadCount++; throw new Error('Forbidden edited text read') } });
        return true;
      })()`,
          returnByValue: true,
        })
        guarded.push(world.id)
      }
      return guarded.length
    })
    .toBe(3)
  async function contentMessage(path, message) {
    for (const contextId of guarded) {
      const match = await session.send('Runtime.evaluate', {
        contextId,
        expression: `location.pathname === ${JSON.stringify(path)}`,
        returnByValue: true,
      })
      if (match.result.value)
        return (
          await session.send('Runtime.evaluate', {
            contextId,
            expression: `chrome.runtime.sendMessage(${JSON.stringify(message)})`,
            awaitPromise: true,
            returnByValue: true,
          })
        ).result.value
    }
    throw new Error('Content execution world unavailable')
  }

  await start()
  await text.pressSequentially(data(), { delay: 1 })
  await next.click()
  await finish('typing burst before same-document pointer', pair('Root field'))

  await start()
  await text.fill(data())
  await next.click()
  await text.focus()
  await text.fill(data())
  await text.press('Enter')
  await text.fill(data())
  await next.click()
  await finish('fresh runs after pointer, focus and Enter', [
    ...pair('Root field'),
    ['fill', 'Root field'],
    ['press', 'Root field'],
    ...pair('Root field'),
  ])

  await start()
  await source.locator('#notes').fill(data())
  await next.click()
  await finish('textarea', pair('Notes'))

  await start()
  await source.locator('#rich').fill(data())
  await next.click()
  await finish('contenteditable without edited text reads', pair('Rich notes'))

  await start()
  await source.locator('#shadow-field').fill(data())
  await source.locator('#shadow-action').click()
  await finish(
    'inside open shadow root',
    pair('Shadow field', 'Shadow action'),
    (value) =>
      assert.deepEqual(value.capturedSteps[0].target.shadowPath, ['#shadow']),
  )

  await start()
  await source.locator('#shadow-field').fill(data())
  await next.click()
  await finish('shadow field to parent pointer', pair('Shadow field'))

  await start()
  await same.locator('#field').fill(data())
  await next.click()
  await finish(
    'same-origin frame to parent pointer',
    pair('Same field'),
    (value) => assert.deepEqual(value.capturedSteps[0].target.frame, ['#same']),
  )

  await start()
  await remote.locator('#field').fill(data())
  await next.click()
  await waitSteps(2)
  const crossDraft = await state()
  check(
    (
      await contentMessage('/cross', {
        type: 'EXPECTATION',
        sessionId: crossDraft.captureSessionId,
        id: crossDraft.capturedSteps[0].id,
        expect: { visible: { role: 'dialog', name: 'Unrelated result' } },
      })
    ).ok,
    'A late cross-frame observation is acknowledged without failing capture',
  )
  check(
    (await state()).capturedSteps[0].expect?.visible?.name !==
      'Unrelated result',
    'A superseded frame action cannot claim a later result',
  )
  await finish(
    'cross-origin frame to parent pointer',
    pair('Cross field'),
    (value) =>
      assert.deepEqual(value.capturedSteps[0].target.frame, ['#cross']),
  )

  await start()
  await text.fill(data())
  await remote.locator('#action').click()
  await finish(
    'parent field to cross-origin pointer',
    pair('Root field', 'Cross action'),
  )

  await start()
  await same.locator('#field').fill(data())
  await remote.locator('#action').click()
  await finish(
    'between sibling frame origins',
    pair('Same field', 'Cross action'),
  )

  await start()
  await remote.locator('#shadow-field').fill(data())
  await next.click()
  await finish(
    'cross-origin shadow field to parent',
    pair('Cross shadow'),
    (value) => {
      assert.deepEqual(value.capturedSteps[0].target.frame, ['#cross'])
      assert.deepEqual(value.capturedSteps[0].target.shadowPath, [
        '#frame-shadow',
      ])
    },
  )

  await start()
  await text.fill(data())
  await text.press('Tab')
  await next.click()
  await finish('Tab does not duplicate the fill', pair('Root field'))

  await start()
  const confirmBox = await source.locator('#open-confirm').boundingBox()
  await text.focus()
  await session.send('Input.insertText', { text: data() })
  const point = {
    x: confirmBox.x + confirmBox.width / 2,
    y: confirmBox.y + confirmBox.height / 2,
    button: 'left',
    clickCount: 1,
  }
  await session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...point,
  })
  await session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...point,
  })
  await finish(
    'a later click owns its dialog expectation',
    pair('Root field', 'Open confirmation'),
    (value) => {
      check(
        value.capturedSteps[0].expect?.visible?.name !== 'Confirmation',
        'A fill cannot expect the next click result',
      )
      check(
        value.capturedSteps[1].expect?.visible?.name === 'Confirmation',
        'The click owns its observed dialog result',
      )
    },
  )

  await start()
  await source.locator('#check').click()
  await source.locator('#check-label').click()
  await source.locator('#check').focus()
  await source.locator('#check').press('Space')
  await source.locator('label[for=radio-a]').click()
  await source.locator('#radio-b').focus()
  await source.locator('#radio-b').press('Space')
  await finish(
    'pointer, label and keyboard toggles without fill duplicates',
    [
      ['check', 'Enable logs'],
      ['uncheck', 'Enable logs'],
      ['check', 'Enable logs'],
      ['check', 'Plan A'],
      ['check', 'Plan B'],
    ],
    (value) =>
      check(
        value.capturedSteps[0].click &&
          value.capturedSteps[1].click &&
          !value.capturedSteps[2].click &&
          !value.capturedSteps[4].click,
        'Pointer toggle markers are retained; keyboard toggles have no fake pointer',
      ),
  )

  await start()
  const beforeToggle = await source.locator('#check').isChecked()
  await source.locator('#check').evaluate((el) =>
    el.addEventListener('click', (event) => event.preventDefault(), {
      once: true,
    }),
  )
  await source.locator('#check').click()
  check(
    (await source.locator('#check').isChecked()) === beforeToggle,
    'Cancelled click preserves the native toggle state',
  )
  await finish('cancelled toggle does not record a state change', [])

  await start()
  await source.locator('#file').setInputFiles(fileURLToPath(fixtureFile))
  await next.click()
  await finish('file change is one upload reference', [
    ['upload', 'Document'],
    ['click', 'Next action'],
  ])

  await start()
  await text.evaluate((el) =>
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: 'PRIVATE_SYNTHETIC' }),
    ),
  )
  await source
    .locator('#check')
    .evaluate((el) => el.dispatchEvent(new Event('change', { bubbles: true })))
  await source.locator('#check').evaluate((el) => el.click())
  await source.locator('#check-label').evaluate((el) => el.click())
  await next.click()
  await finish('untrusted events ignored', [['click', 'Next action']])

  await start()
  await text.fill(data())
  await waitSteps(1)
  await press('capture-pause')
  await waitPhase('paused')
  await text.fill(data())
  await press('capture-pause')
  await waitPhase('recording')
  await text.fill(data())
  await finish('pause/resume resets the focused input run', [
    ['fill', 'Root field'],
    ['fill', 'Root field'],
  ])

  await start()
  await text.fill(data())
  await text.fill(data())
  await next.click()
  await source.locator('#email').fill(data())
  check(
    await source
      .locator('#email')
      .evaluate((el) => document.activeElement === el),
    'Final field remains focused',
  )
  const saved = await finish(
    'Stop retains an unblurred edit after session reset',
    [...pair('Root field'), ['fill', 'Secret field']],
  )
  await panel
    .getByRole('textbox', { name: 'Guide title' })
    .fill('Input ordering')
  await press('capture-keep-local')
  await waitPhase('idle')
  const app = await context.newPage()
  await app.goto(
    `${origin}/app.html?route=${encodeURIComponent(`/g/capture-${saved.captureSessionId}/edit?step=1`)}`,
  )
  await expect(
    app.getByRole('heading', { name: 'Input ordering', exact: true }),
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
  const json = await readFile(await (await download).path(), 'utf8')
  check(
    !json.includes('PRIVATE_'),
    'Native saved/exported guide contains no typed values',
  )
  const guide = JSON.parse(json)
  assert.deepEqual(
    guide.steps.map((step) => step.action),
    ['fill', 'click', 'fill'],
  )
  checks++
  check(
    guide.variables.length === 2 &&
      guide.steps[0].value.variable === guide.variables[0].name &&
      guide.steps[2].value.variable === guide.variables[1].name &&
      guide.steps[2].value.kind === 'secret',
    'Saved guide retains runtime declaration/reference',
  )
  for (const contextId of guarded) {
    const reply = await session.send('Runtime.evaluate', {
      contextId,
      expression: 'globalThis.inputReadCount',
      returnByValue: true,
    })
    check(reply.result.value === 0, 'No recorder value or edited-text reads')
  }
  check(apiRequests === 0, 'Local input capture made a server API request')
  assert.deepEqual(failures, [])
  checks++
  console.log(
    `Native input ordering verified: ${checks} checks; real typing coalescence/boundaries, same-document/open-shadow/same- and cross-origin frame transitions, native keyboard toggles/file reference, untrusted rejection, pause/session reset, unblurred Stop, native local save/JSON export and throwing content-world value/edited-text getters. No live services.`,
  )
} finally {
  await context?.close()
  for (const fixture of [server, other]) {
    fixture.closeAllConnections()
    await new Promise((resolve) => fixture.close(resolve))
  }
}

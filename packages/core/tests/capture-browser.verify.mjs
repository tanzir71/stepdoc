import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'

const entry = 'virtual:capture-check'
const source = fileURLToPath(
  new URL('../src/capture/index.ts', import.meta.url),
).replaceAll('\\', '/')
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: 'capture-browser-check',
      resolveId(id) {
        if (id === entry) return `\0${entry}`
      },
      load(id) {
        if (id === `\0${entry}`)
          return `import * as capture from ${JSON.stringify(source)};globalThis.sdCapture = capture;`
      },
    },
  ],
  build: {
    write: false,
    minify: false,
    rollupOptions: {
      input: entry,
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
})
assert(!Array.isArray(bundle) && 'output' in bundle)
const chunk = bundle.output.find(
  (item) => item.type === 'chunk' && item.isEntry,
)
assert(chunk?.type === 'chunk')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 800 },
    deviceScaleFactor: 2,
  })
  await page.route('http://capture.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html lang="en"><head><title>Capture fixtures</title><link rel="icon" href="data:,"></head><body></body></html>',
    }),
  )
  const nonLocal = []
  page.on('request', (request) => {
    if (
      !request.url().startsWith('http://capture.test/') &&
      !request.url().startsWith('data:')
    )
      nonLocal.push('External capture request')
  })
  await page.goto(
    'http://capture.test/fixture?private=query-secret#fragment-secret',
  )
  await page.addScriptTag({ content: chunk.code })
  const result = await page.evaluate(async () => {
    const c = globalThis.sdCapture
    let checks = 0
    const check = (condition, name) => {
      if (!condition) throw new Error(name)
      checks++
    }
    document.body.innerHTML = `<h1>Fixture</h1><button>Save</button><button id="save" data-testid="save-project">Save</button>
      <a id="link" href="/next?private=query-secret">Continue</a>
      <label for="email">Invoice email</label><input id="email" type="email" value="typed-email-private">
      <label>Amount <input id="amount" type="number" value="42"><input type="text" value="embedded-private"></label>
      <label for="message">Message</label><textarea id="message">typed-textarea-private</textarea>
      <label>Plan <select id="plan"><option value="hidden-backend-id" selected>Team plan</option></select></label>
      <div role="textbox" aria-label="Notes" contenteditable><span>typed-editable-private</span></div>
      <div id="outer"></div><iframe id="frame" title="Frame"></iframe>`
    const getterReads = new Proxy(
      { count: 0 },
      {
        get(object, key) {
          if (key === 'value') {
            object.count++
            throw new Error('Original value getter read')
          }
          return object[key]
        },
      },
    )
    for (const prototype of [
      HTMLInputElement.prototype,
      HTMLTextAreaElement.prototype,
      HTMLSelectElement.prototype,
    ]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value')
      Object.defineProperty(prototype, 'value', {
        ...descriptor,
        get() {
          return getterReads.value
        },
      })
    }
    const editable = document.querySelector('[contenteditable]')
    Object.defineProperty(editable, 'textContent', {
      get() {
        throw new Error('Editable text getter read')
      },
    })
    const save = c.captureStep(document.querySelector('#save'), 'click', {
      id: 'save',
      index: 1,
      click: { x: 4, y: 5 },
    })
    check(
      save.target.role === 'button' && save.target.name === 'Save',
      'Native role/name',
    )
    check(
      save.target.locators[0].strategy === 'testId' &&
        save.target.locators[0].unique,
      'Measured unique locator ranking',
    )
    check(
      save.target.locators.some(
        (item) => item.strategy === 'role' && item.unique === false,
      ),
      'Ambiguous role retained',
    )
    check(save.click.x === 8 && save.click.y === 10, 'DPR source-pixel click')
    check(save.url === 'http://capture.test/fixture', 'Query/fragment stripped')
    const captured = [save]
    for (const [id, name, kind] of [
      ['email', 'Invoice email', 'secret'],
      ['amount', 'Amount', 'variable'],
      ['message', 'Message', 'variable'],
    ]) {
      const step = c.captureStep(document.getElementById(id), 'fill', {
        id,
        index: captured.length + 1,
      })
      check(
        step.target.name === name && step.value.kind === kind,
        `Native ${id} reference`,
      )
      captured.push(step)
    }
    const notes = c.captureStep(editable, 'fill', { id: 'notes', index: 5 })
    check(
      notes.target.name === 'Notes' && notes.value.kind === 'variable',
      'Native editable name/reference',
    )
    captured.push(notes)
    const select = c.captureStep(document.querySelector('#plan'), 'select', {
      id: 'select',
      index: 6,
    })
    check(
      select.value.kind === 'literal' && select.value.literal === 'Team plan',
      'Selected option label only',
    )
    captured.push(select)
    const outer = document
      .getElementById('outer')
      .attachShadow({ mode: 'open' })
    outer.innerHTML = '<div id="inner"></div>'
    const inner = outer.querySelector('#inner').attachShadow({ mode: 'open' })
    inner.innerHTML =
      '<button id="shadow-save">Save inside</button><input type="password" aria-label="Shadow password">'
    const shadow = c.captureStep(inner.querySelector('button'), 'click', {
      id: 'shadow',
      index: 7,
    })
    check(
      JSON.stringify(shadow.target.shadowPath) ===
        JSON.stringify(['#outer', '#inner']),
      'Native open-shadow chain',
    )
    check(
      shadow.target.locators[0].unique === true &&
        shadow.target.name === 'Save inside',
      'Native scoped shadow role',
    )
    captured.push(shadow)
    const frame = document.getElementById('frame')
    frame.contentDocument.body.innerHTML =
      '<button>Frame button</button><iframe id="nested"></iframe>'
    const nested = frame.contentDocument.getElementById('nested')
    nested.contentDocument.body.innerHTML = '<button>Nested button</button>'
    const framed = c.captureStep(
      nested.contentDocument.querySelector('button'),
      'click',
      { id: 'frame', index: 8 },
    )
    check(
      JSON.stringify(framed.target.frame) ===
        JSON.stringify(['#frame', '#nested']),
      'Nested same-origin frame chain',
    )
    check(
      framed.url === 'http://capture.test/fixture',
      'About blank inherits sanitized document URL',
    )
    const point = c.viewportPoint(frame.contentWindow, { x: 5, y: 6 })
    const frameRect = frame.getBoundingClientRect()
    check(
      point.x === frameRect.x + frame.clientLeft + 5 &&
        point.y === frameRect.y + frame.clientTop + 6,
      'Frame viewport click transform',
    )
    captured.push(framed)
    const before = c.observePage(document)
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-label', 'Confirm change')
    document.body.append(dialog)
    check(
      c.guessExpectation(before, c.observePage(document)).visible.name ===
        'Confirm change',
      'Native new visible dialog',
    )
    dialog.remove()
    const heading = document.createElement('h2')
    heading.textContent = 'Ready to review'
    document.body.append(heading)
    check(
      c.guessExpectation(before, c.observePage(document)).visible.role ===
        'heading',
      'Native new heading',
    )
    history.pushState(null, '', '/next?private=another-secret#another-fragment')
    check(
      c.guessExpectation(before, c.observePage(document)).urlMatches ===
        'http://capture.test/next',
      'Native SPA expectation',
    )
    const opaque = document.createElement('opaque-host')
    opaque.style.cssText = 'display:block;width:200px;height:40px'
    opaque.attachShadow({ mode: 'closed' }).innerHTML =
      '<input value="PRIVATE_CLOSED_VALUE">'
    document.body.append(opaque)
    const masks = c.fieldMasks(document)
    const opaqueRect = opaque.getBoundingClientRect()
    check(
      masks.some(
        (mask) =>
          mask.x === opaqueRect.x &&
          mask.y === opaqueRect.y &&
          mask.width === opaqueRect.width &&
          mask.height === opaqueRect.height,
      ),
      'Opaque closed-shadow host covered',
    )
    for (const field of document.querySelectorAll(
      'input,textarea,[contenteditable],iframe',
    )) {
      const rect = field.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      check(
        masks.some(
          (mask) =>
            mask.x <= rect.x &&
            mask.y <= rect.y &&
            mask.x + mask.width >= rect.right &&
            mask.y + mask.height >= rect.bottom,
        ),
        'All field/frame pixels covered',
      )
    }
    check(
      getterReads.count === 0,
      'No original value getter was read via proxy',
    )
    const text = JSON.stringify(captured)
    for (const secret of [
      'typed-email-private',
      'embedded-private',
      'typed-textarea-private',
      'typed-editable-private',
      'hidden-backend-id',
      'query-secret',
      'fragment-secret',
    ])
      check(!text.includes(secret), 'Captured data excludes private values')
    const field = document.getElementById('email')
    field.setAttribute('aria-label', 'PRIVATE'.repeat(100))
    try {
      c.captureTarget(field)
      throw new Error('Limit not enforced')
    } catch (error) {
      check(
        error.message === 'Capture metadata unavailable: metadata_limit',
        'Data-free limit error',
      )
    }
    return { checks }
  })
  assert.equal(result.checks, 34)
  assert.deepEqual(nonLocal, [])
  console.log(
    `Native DOM capture verified in Chromium: ${result.checks} checks, value-getter proxy, editable omission, roles/names/unique locators, DPR/frame/shadow geometry, SPA expectations, mandatory field masks and zero external requests.`,
  )
} finally {
  await browser.close()
}

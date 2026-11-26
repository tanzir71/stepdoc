import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'

const entry = 'virtual:capture-redaction'
const source = fileURLToPath(
  new URL('../src/capture/index.ts', import.meta.url),
).replaceAll('\\', '/')
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  plugins: [
    {
      name: entry,
      resolveId: (id) => (id === entry ? `\0${entry}` : undefined),
      load: (id) =>
        id === `\0${entry}`
          ? `import * as capture from ${JSON.stringify(source)};globalThis.capture = capture;`
          : undefined,
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
const script = bundle.output.find(
  (chunk) => chunk.type === 'chunk' && chunk.isEntry,
)
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 800 },
    deviceScaleFactor: 2,
  })
  await page.route('http://redaction.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Privacy fixture</title></head><body></body></html>',
    }),
  )
  const external = []
  page.on('request', (request) => {
    if (!request.url().startsWith('http://redaction.test/'))
      external.push('Non-local request')
  })
  await page.goto('http://redaction.test/')
  await page.addScriptTag({ content: script.code })
  const checks = await page.evaluate(async () => {
    const c = globalThis.capture
    let checks = 0
    const check = (condition, name) => {
      if (!condition) throw new Error(name)
      checks++
    }
    const setup = (html) => {
      document.body.innerHTML = html
    }
    const covers = (masks, rect, kind) =>
      masks.some(
        (mask) =>
          (!kind || mask.kind === kind) &&
          mask.rect.x <= rect.x &&
          mask.rect.y <= rect.y &&
          mask.rect.x + mask.rect.width >= rect.right &&
          mask.rect.y + mask.rect.height >= rect.bottom,
      )
    const nodeRange = (node, start = 0, end = node.length) => {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      return range
    }
    setup(
      '<p id="mail">🧭 <span>person</span><b>@example</b><span>.test</span></p>',
    )
    let masks = c.visibleTextRedactions(document)
    for (const element of document.querySelectorAll('#mail span,#mail b'))
      check(
        covers(
          masks,
          nodeRange(element.firstChild).getBoundingClientRect(),
          'email',
        ),
        'Split inline email Range geometry',
      )
    check(
      masks.every(
        (mask) =>
          mask.source === 'auto' &&
          mask.rule === 'email' &&
          mask.status === 'applied',
      ),
      'Only category/rule/rect metadata returned',
    )
    check(
      !JSON.stringify(masks).includes('person'),
      'Matched text not returned',
    )
    setup(
      '<div id="wrap" style="font:16px monospace;width:90px">4111 1111 1111 1111</div><p>Call +1 415 555 2671</p><p>GB82 WEST 1234 5698 7654 32</p><p>ghp_0123456789abcdefghijklmnopqrstuv</p><p>192.168.1.1</p>',
    )
    masks = c.visibleTextRedactions(document)
    const wrapped = [
      ...nodeRange(document.querySelector('#wrap').firstChild).getClientRects(),
    ]
    check(wrapped.length > 1, 'Native wrapped card fixture')
    for (const rect of wrapped)
      check(covers(masks, rect, 'card'), 'Every wrapped card line is masked')
    for (const kind of ['card', 'phone', 'iban', 'token', 'ip'])
      check(
        masks.some((mask) => mask.kind === kind),
        'Built-in category reaches DOM geometry',
      )
    setup(
      '<input value="PRIVATE"><textarea>PRIVATE</textarea><select><option>PRIVATE</option></select><div contenteditable><span>PRIVATE</span></div><div role="textbox"><span>PRIVATE</span></div><script type="application/json">PRIVATE</script><style>/* PRIVATE */</style><template>PRIVATE</template><div style="display:none">PRIVATE</div><div style="opacity:0">PRIVATE</div><div style="visibility:hidden">PRIVATE</div><p style="position:absolute;top:2000px">PRIVATE</p><p aria-hidden="true">visible@example.test</p>',
    )
    let privateReads = 0
    for (const element of document.querySelectorAll(
      'input,textarea,select,[contenteditable],[role=textbox]',
    ))
      Object.defineProperty(element, 'value', {
        get: () => {
          privateReads++
          throw new Error('Private value read')
        },
      })
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    )
    const textNodes = []
    while (walker.nextNode())
      if (walker.currentNode.nodeValue.includes('PRIVATE'))
        textNodes.push(walker.currentNode)
    for (const text of textNodes)
      Object.defineProperty(text, 'data', {
        get: () => {
          privateReads++
          throw new Error('Private CharacterData read')
        },
      })
    masks = c.visibleTextRedactions(document)
    check(
      privateReads === 0,
      'No form/editable/hidden/offscreen CharacterData read',
    )
    check(
      masks.length === 1 && masks[0].kind === 'email',
      'Visually present aria-hidden text still masked',
    )
    setup(
      '<div style="visibility:hidden"><span style="visibility:visible">visible@example.test</span></div>',
    )
    check(
      c.visibleTextRedactions(document).some((mask) => mask.kind === 'email'),
      'Visibility override is scanned',
    )
    setup(
      '<div id="host"><span slot="value">slot@example.test</span><span id="unassigned">PRIVATE</span></div>',
    )
    const host = document.querySelector('#host')
    const unassigned = document.querySelector('#unassigned').firstChild
    Object.defineProperty(unassigned, 'data', {
      get: () => {
        throw new Error('Unassigned text read')
      },
    })
    host.attachShadow({ mode: 'open' }).innerHTML =
      '<div><span>shadow@example.test</span><slot name="value"></slot></div>'
    masks = c.visibleTextRedactions(document)
    check(
      masks.filter((mask) => mask.kind === 'email').length === 2,
      'Open-shadow and slotted visible text scanned once',
    )
    setup(
      '<div id="clip" style="width:80px;overflow:hidden;white-space:nowrap">clipped@example.test</div>',
    )
    const clip = document.querySelector('#clip').getBoundingClientRect()
    masks = c.visibleTextRedactions(document)
    check(
      masks.length > 0 &&
        masks.every(
          (mask) =>
            mask.rect.x >= clip.x &&
            mask.rect.x + mask.rect.width <= clip.right,
        ),
      'Scroll/overflow clipping bounds text masks',
    )
    setup(
      '<div style="display:contents;overflow:hidden"><span>contents@example.test</span></div>',
    )
    check(
      c.visibleTextRedactions(document).some((mask) => mask.kind === 'email'),
      'Display-contents has no clipping box',
    )
    setup('<p style="position:relative;left:-50px">offset@example.test</p>')
    check(
      c.visibleTextRedactions(document).every((mask) => mask.rect.x >= 0),
      'Viewport clipping never exposes negative mask coordinates',
    )
    setup('<p style="text-shadow:20px 0 black">shadow@example.test</p>')
    check(
      c
        .visibleTextRedactions(document)
        .some(
          (mask) =>
            mask.rule === 'paint-overflow' &&
            mask.source === 'policy' &&
            mask.rect.width === innerWidth,
        ),
      'Text paint overflow is conservative',
    )
    setup(
      '<svg width="400" height="60"><text x="10" y="30">vector@example.test</text></svg>',
    )
    check(
      c.visibleTextRedactions(document).some((mask) => mask.kind === 'email'),
      'SVG text uses native Range geometry',
    )
    setup(
      '<p data-sd="capture-ui">page@example.test</p><div id="owned">PRIVATE</div>',
    )
    const owned = document.querySelector('#owned')
    c.ownCaptureUi(owned)
    Object.defineProperty(owned.firstChild, 'data', {
      get: () => {
        throw new Error('Capture UI scanned')
      },
    })
    check(
      c.visibleTextRedactions(document).length === 1,
      'Only private membership excludes capture UI; page hooks do not',
    )
    const tracker = new c.FrameTracker(document, c.captureId())
    const a = tracker.snapshot(c.captureId())
    owned.setAttribute('hidden', '')
    owned.append(document.createElement('span'))
    await Promise.resolve()
    const b = tracker.snapshot(c.captureId())
    check(
      a.revision === b.revision &&
        JSON.stringify(a.masks) === JSON.stringify(b.masks),
      'Capture UI mutations never invalidate screenshot geometry',
    )
    const animation = owned.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 10_000,
    })
    check(
      !tracker.snapshot(c.captureId()).geometryMotion,
      'Capture UI animations are excluded from privacy motion policy',
    )
    animation.cancel()
    document.querySelector('p').setAttribute('title', 'changed')
    await Promise.resolve()
    check(
      tracker.snapshot(c.captureId()).revision > b.revision,
      'Page mutations remain guarded',
    )
    setup(
      '<button id="manual" style="position:absolute;left:20px;top:30px;width:200px;height:60px">Custom content</button><input id="field" value="PRIVATE">',
    )
    const manual = new c.ManualRedactions(),
      button = document.querySelector('#manual'),
      field = document.querySelector('#field')
    Object.defineProperty(field, 'value', {
      get: () => {
        throw new Error('Manual value read')
      },
    })
    manual.add(button)
    manual.add(button)
    manual.add(field)
    check(manual.count === 2, 'Manual element identity deduplicated')
    masks = manual.collect()
    check(
      covers(masks, button.getBoundingClientRect(), 'custom') &&
        covers(masks, field.getBoundingClientRect(), 'custom'),
      'Manual controls masked without reading values',
    )
    check(
      masks.every(
        (mask) => mask.source === 'manual' && mask.rule === 'click-to-blur',
      ),
      'Manual provenance contains no labels/selectors',
    )
    button.style.left = '120px'
    check(
      covers(manual.collect(), button.getBoundingClientRect()),
      'Manual geometry follows element movement',
    )
    button.remove()
    manual.collect()
    check(manual.count === 1, 'Disconnected selection removed')
    manual.clear()
    check(manual.collect().length === 0, 'Session clear removes manual masks')
    setup('<p>safe</p>')
    try {
      c.visibleTextRedactions(document, () => {
        throw new Error('PRIVATE_DETECTOR_ERROR')
      })
      throw new Error('Expected failure')
    } catch (error) {
      check(
        error.message === 'Redaction detection failed: detector_failure',
        'Detector failures never forward text',
      )
    }
    try {
      c.visibleTextRedactions(document, () => [
        { start: 0, end: 999, kind: 'email', source: 'auto', rule: 'email' },
      ])
      throw new Error('Expected failure')
    } catch (error) {
      check(
        error.message === 'Redaction detection failed: detector_failure',
        'Invalid spans fail closed',
      )
    }
    try {
      c.visibleTextRedactions(document, () =>
        Array.from({ length: 10_001 }, () => ({
          start: 0,
          end: 1,
          kind: 'email',
          source: 'auto',
          rule: 'email',
        })),
      )
      throw new Error('Expected failure')
    } catch (error) {
      check(
        error.message === 'Redaction detection failed: match_limit',
        'Match limits block incomplete geometry',
      )
    }
    const createRange = document.createRange.bind(document)
    document.createRange = () => {
      const range = createRange()
      range.getClientRects = () => {
        throw new Error('PRIVATE_RANGE_ERROR')
      }
      return range
    }
    try {
      c.visibleTextRedactions(document)
      throw new Error('Expected failure')
    } catch (error) {
      check(
        error.message === 'Capture metadata unavailable: dom_failure',
        'Range failures never forward page text',
      )
    }
    document.createRange = createRange
    setup('<p></p>')
    // The HTML parser splits long text at 64 KiB. Make a single visible node so
    // this specifically tests the collector's per-node work bound.
    document
      .querySelector('p')
      .append(document.createTextNode('x'.repeat(250_001)))
    try {
      c.visibleTextRedactions(document)
      throw new Error('Expected limit')
    } catch (error) {
      check(
        error.message === 'Redaction detection failed: input_limit',
        'Text resource limit blocks partial masks',
      )
    }
    setup('<i></i>'.repeat(12_001))
    try {
      c.visibleTextRedactions(document)
      throw new Error('Expected limit')
    } catch (error) {
      check(
        error.message === 'Capture metadata unavailable: dom_limit',
        'Node resource limit blocks partial masks',
      )
    }
    return checks
  })
  assert.equal(checks, 38)
  assert.deepEqual(external, [])
  console.log(
    `Native capture redaction verified: ${checks} checks, visible composed text/UTF-16/wrap/clipping/categories, no editable/hidden reads, private UI isolation, manual geometry/provenance and fail-closed limits.`,
  )
} finally {
  await browser.close()
}

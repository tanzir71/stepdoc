import { extensionWorker } from './extension-worker.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { chromium, expect } from '@playwright/test'

let base, otherBase
const field =
  '<input aria-label="Private field" style="position:absolute;left:10px;top:50px;width:180px;height:40px;border:0;padding:0;background:repeating-linear-gradient(90deg,black 0,black 1px,white 1px,white 2px)" value="PRIVATE_FRAME_TYPED">'
const inherited = (name) =>
  `<!doctype html><html><head><title>Inherited frame</title></head><body style="margin:0"><button>${name}</button>${field}<script>window.probes=0;addEventListener('message',event=>{if(event.data?.type==='stepdoc/frame-probe@1')window.probes++})</script></body></html>`
const html = (text) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
const handler = (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' })
  if (req.url.startsWith('/nested')) {
    res.end(inherited('Nested action'))
    return
  }
  if (req.url.startsWith('/child')) {
    res.end(
      `<!doctype html><html><head><title>Cross-origin fixture</title></head><body style="margin:0;background:rgb(60,150,210)"><button style="position:absolute;left:10px;top:5px">Cross action</button>${field}<div id="clear-tile" style="position:absolute;left:200px;top:50px;width:30px;height:30px;background:rgb(230,30,170)"></div><iframe id="nested" src="${base}/nested" style="position:absolute;left:10px;top:120px;width:220px;height:100px;border:3px solid black"></iframe><script>window.probes=0;addEventListener('message',event=>{if(event.data?.type==='stepdoc/frame-probe@1')window.probes++})</script></body></html>`,
    )
    return
  }
  res.end(`<!doctype html><html><head><title>Frame capture</title></head><body><h1>Frame capture</h1><button id="top-action">Top action</button>
    <iframe id="first" src="${otherBase}/child?PRIVATE_QUERY#PRIVATE_FRAGMENT" style="position:absolute;left:20px;top:100px;width:600px;height:300px;border:10px solid black;transform:scale(.75);transform-origin:top left"></iframe>
    <iframe id="second" src="${otherBase}/child?PRIVATE_QUERY#PRIVATE_FRAGMENT" style="position:absolute;left:500px;top:100px;width:260px;height:280px;border:5px solid black"></iframe>
    <div id="shadow-host" style="position:absolute;left:800px;top:100px"></div>
    <iframe id="srcdoc" srcdoc="${html(inherited('Srcdoc action'))}" style="position:absolute;left:20px;top:480px;width:300px;height:120px"></iframe>
    <iframe id="blank" style="position:absolute;left:370px;top:480px;width:300px;height:120px"></iframe>
    <iframe id="opaque" sandbox="allow-scripts" srcdoc="${html(inherited('Opaque action'))}" style="position:absolute;left:720px;top:480px;width:300px;height:120px"></iframe>
    <iframe id="hidden" src="/nested" style="display:none"></iframe>
    <script>document.querySelector('#shadow-host').attachShadow({mode:'open'}).innerHTML='<iframe id="shadow-frame" src="${otherBase}/child?PRIVATE_QUERY#PRIVATE_FRAGMENT" style="width:400px;height:280px;border:4px solid black"></iframe>';
    document.querySelector('#blank').contentDocument.write(${JSON.stringify(inherited('Blank action')).replaceAll('<', '\\u003c')});document.querySelector('#blank').contentDocument.close();</script></body></html>`)
}
const servers = [createServer(handler), createServer(handler)]
await Promise.all(
  servers.map(
    (server) =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
  ),
)
base = `http://127.0.0.1:${servers[0].address().port}`
otherBase = `http://127.0.0.1:${servers[1].address().port}`
let context
try {
  const extensionDir = fileURLToPath(
    new URL('../.output/chrome-mv3/', import.meta.url),
  )
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ],
  })
  const worker = await extensionWorker(context)
  const url = new URL(worker.url()),
    origin = `${url.protocol}//${url.host}`
  const panel = await context.newPage()
  await panel.goto(`${origin}/sidepanel.html`)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`${base}/host`)
  console.log('Frame fixture loaded')
  await expect(
    page.frameLocator('#blank').getByRole('button', { name: 'Blank action' }),
  ).toBeVisible()
  const state = () =>
    worker.evaluate(() =>
      chrome.storage.local.get([
        'recording',
        'capturedSteps',
        'steps',
        'captureError',
      ]),
    )
  const start = () =>
    panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START' }))
  assert.deepEqual(await start(), { ok: true })
  console.log('Frame capture primed')
  assert.deepEqual(
    (await state()).capturedSteps,
    [],
    'Prewarm created a phantom step',
  )
  const actions = [
    ['#first', 'Cross action', ['#first']],
    ['#second', 'Cross action', ['#second']],
    [
      '#shadow-host #shadow-frame',
      'Cross action',
      ['#shadow-host #shadow-frame'],
    ],
    ['#srcdoc', 'Srcdoc action', ['#srcdoc']],
    ['#blank', 'Blank action', ['#blank']],
    ['#opaque', 'Opaque action', ['#opaque']],
  ]
  // Force a browser graph replacement during post-camera collection. The first
  // candidate is deliberately undecodable: reusing it after retrying only the
  // metadata would fail. Success requires a second, fully fresh native capture.
  await worker.evaluate(() => {
    const frames = chrome.webNavigation.getAllFrames.bind(chrome.webNavigation)
    const camera = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    const proof = { cameras: 0, postReads: 0, changed: false }
    globalThis.frameRetryProof = proof
    globalThis.restoreFrameRetry = () => {
      chrome.webNavigation.getAllFrames = frames
      chrome.tabs.captureVisibleTab = camera
    }
    chrome.tabs.captureVisibleTab = async (...args) => {
      const raw = await camera(...args)
      proof.cameras++
      return proof.cameras === 1 ? 'data:image/png;base64,AA==' : raw
    }
    chrome.webNavigation.getAllFrames = async (...args) => {
      const current = await frames(...args)
      if (proof.cameras && ++proof.postReads === 2) {
        proof.changed = true
        return current.map((frame) => ({
          ...frame,
          documentId: 'fixture-replacement',
        }))
      }
      return current
    }
  })
  for (const [selector, name, chain] of actions) {
    const count = (await state()).steps.length
    await page
      .frameLocator(selector)
      .getByRole('button', { name, exact: true })
      .click()
    await expect
      .poll(
        async () => {
          const value = await state()
          return value.captureError ?? value.steps.length
        },
        { timeout: 20_000 },
      )
      .toBe(count + 1)
    assert.deepEqual((await state()).capturedSteps.at(-1).target.frame, chain)
    if (count === 0) {
      const proof = await worker.evaluate(() => globalThis.frameRetryProof)
      assert.equal(
        proof.changed,
        true,
        'The post-camera graph replacement occurred',
      )
      assert.equal(
        proof.cameras,
        2,
        'A changed graph discards the first raw candidate',
      )
      assert.notEqual(
        (await state()).capturedSteps.at(-1).lowConfidence,
        true,
        'The retry used fresh processed pixels',
      )
      await worker.evaluate(() => globalThis.restoreFrameRetry())
    }
    console.log(`Verified frame action: ${selector}`)
  }
  await page
    .frameLocator('#first')
    .frameLocator('#nested')
    .getByRole('button', { name: 'Nested action' })
    .click()
  await expect
    .poll(
      async () => {
        const value = await state()
        return value.captureError ?? value.capturedSteps.at(-1)?.target?.name
      },
      { timeout: 20_000 },
    )
    .toBe('Nested action')
  let saved = await state()
  assert.deepEqual(saved.capturedSteps.at(-1).target.frame, [
    '#first',
    '#nested',
  ])
  assert.equal(saved.capturedSteps.at(-1).url, `${base}/nested`)
  assert(
    saved.capturedSteps.every((step) => step.click?.x !== undefined),
    'Verified frame click geometry missing',
  )
  assert(
    saved.capturedSteps.every(
      (step) =>
        !step.redactions.some((mask) => mask.rule === 'frame-unavailable'),
    ),
    'Verified frames were blanket masked',
  )
  assert(
    !JSON.stringify(saved).includes('PRIVATE_'),
    'Frame values/query/fragment persisted',
  )
  // Independently computed Playwright bounds include border/scale/shadow/nested
  // offsets. Compare those bounds with persisted source-pixel provenance.
  const boxes = await Promise.all([
    page
      .frameLocator('#first')
      .getByRole('textbox', { name: 'Private field', exact: true })
      .boundingBox(),
    page
      .frameLocator('#first')
      .frameLocator('#nested')
      .getByRole('textbox', { name: 'Private field', exact: true })
      .boundingBox(),
    page
      .frameLocator('#shadow-host #shadow-frame')
      .getByRole('textbox', { name: 'Private field', exact: true })
      .boundingBox(),
  ])
  for (const box of boxes) {
    assert(box)
    assert(
      saved.capturedSteps
        .at(-1)
        .redactions.some(
          (mask) =>
            mask.rule === 'form-value' &&
            Math.abs(mask.rect.x - Math.floor(box.x)) <= 1 &&
            Math.abs(mask.rect.y - Math.floor(box.y)) <= 1 &&
            mask.rect.width >= box.width &&
            mask.rect.height >= box.height,
        ),
      'Projected field provenance differs from native frame geometry',
    )
  }
  const tile = await page
    .frameLocator('#first')
    .locator('#clear-tile')
    .boundingBox()
  const pixels = await page.evaluate(
    async ({ imageUrl, boxes, tile }) => {
      const image = await createImageBitmap(
          await (await fetch(imageUrl)).blob(),
        ),
        canvas = new OffscreenCanvas(image.width, image.height),
        ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      image.close()
      return {
        width: canvas.width,
        height: canvas.height,
        transitions: boxes.map((box) => {
          const pixels = ctx.getImageData(
            Math.ceil(box.x) + 10,
            Math.ceil(box.y) + 10,
            80,
            1,
          ).data
          let count = 0
          for (let i = 4; i < pixels.length; i += 4)
            if (Math.abs(pixels[i] - pixels[i - 4]) > 60) count++
          return count
        }),
        tile: [
          ...ctx.getImageData(
            Math.round(tile.x + 10),
            Math.round(tile.y + 10),
            1,
            1,
          ).data,
        ],
      }
    },
    { imageUrl: saved.steps.at(-1).screenshot, boxes, tile },
  )
  assert(
    pixels.transitions.every((count) => count < 15),
    'Cross-frame raw field stripes survived',
  )
  assert(
    pixels.tile.every(
      (channel, index) => Math.abs(channel - [230, 30, 170, 255][index]) <= 4,
    ),
    'Non-field cross-frame pixels were obscured (WebP channel tolerance: 4)',
  )
  // Real probes are consumed before page listeners. Fake, unarmed and synthetic
  // messages may reach the page but must never change capture identity.
  for (const frame of page.frames())
    assert.equal(
      await frame.evaluate(() => window.probes ?? 0),
      0,
      'Frame probe exposed to page listeners',
    )
  await page.evaluate(() => {
    for (const frame of document.querySelectorAll('iframe'))
      frame.contentWindow.postMessage(
        {
          type: 'stepdoc/frame-probe@1',
          nonce: crypto.randomUUID(),
          token: crypto.randomUUID(),
        },
        '*',
      )
    dispatchEvent(
      new MessageEvent('message', {
        data: {
          type: 'stepdoc/frame-probe@1',
          nonce: crypto.randomUUID(),
          token: crypto.randomUUID(),
        },
        source: parent,
      }),
    )
  })
  await page
    .frameLocator('#second')
    .getByRole('button', { name: 'Cross action' })
    .click()
  await expect
    .poll(async () => (await state()).steps.length)
    .toBe(saved.steps.length + 1)
  assert.deepEqual((await state()).capturedSteps.at(-1).target.frame, [
    '#second',
  ])
  const firstFrame = page
    .frames()
    .find(
      (frame) =>
        frame.parentFrame() === page.mainFrame() &&
        frame.url().startsWith(`${otherBase}/child`),
    )
  await firstFrame.evaluate(() => {
    document.body.style.minHeight = '600px'
    scrollTo(0, 65)
  })
  assert.equal(await firstFrame.evaluate(() => scrollY), 65)
  saved = await state()
  await page.locator('#top-action').click()
  await expect
    .poll(async () => (await state()).steps.length)
    .toBe(saved.steps.length + 1)
  const outer = await page.locator('#first').boundingBox()
  assert(
    (await state()).capturedSteps
      .at(-1)
      .redactions.some(
        (mask) =>
          mask.rule === 'form-value' &&
          Math.abs(mask.rect.x - Math.floor(outer.x + 15)) <= 1 &&
          Math.abs(mask.rect.y - Math.floor(outer.y + 7.5)) <= 1 &&
          mask.rect.height < 31,
      ),
    'Scrolled child field was not clipped at the ancestor viewport',
  )
  // Force layout mutation while native pixels are being captured. Raw is
  // discarded; the saved image and provenance must come from the prior cache.
  await worker.evaluate(() => {
    const original = chrome.tabs.captureVisibleTab.bind(chrome.tabs)
    globalThis.restoreFrameCamera = () => {
      chrome.tabs.captureVisibleTab = original
    }
    chrome.tabs.captureVisibleTab = async (...args) => {
      const result = await original(...args)
      await new Promise((resolve) => {
        globalThis.releaseFrameCamera = resolve
      })
      return result
    }
  })
  saved = await state()
  await page.locator('#top-action').click()
  await expect
    .poll(() => worker.evaluate(() => typeof globalThis.releaseFrameCamera))
    .toBe('function')
  await page.evaluate(() => {
    document.querySelector('#first').style.left = '60px'
  })
  await worker.evaluate(() => globalThis.releaseFrameCamera())
  await expect
    .poll(async () => (await state()).steps.length)
    .toBe(saved.steps.length + 1)
  const reused = await state()
  assert.equal(reused.capturedSteps.at(-1).lowConfidence, true)
  assert.equal(
    reused.steps.at(-1).screenshot,
    saved.steps.at(-1).screenshot,
    'Changed-scene raw image was cached',
  )
  assert.deepEqual(
    reused.capturedSteps.at(-1).redactions,
    saved.capturedSteps.at(-1).redactions,
    'Reused image lost its applied provenance',
  )
  await worker.evaluate(() => globalThis.restoreFrameCamera())
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' }))
  // Missing receiver and explicit collector error are distinct: opaque masks
  // permit top-page capture; a failed privacy collector stops and blocks upload.
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs)
    globalThis.restoreFrameMessages = () => {
      chrome.tabs.sendMessage = original
    }
    globalThis.missingFrameSnapshots = 0
    chrome.tabs.sendMessage = async (tab, message, options) => {
      if (message.type === 'FRAME_SNAPSHOT' && options?.frameId !== 0) {
        globalThis.missingFrameSnapshots++
        throw new Error('No receiver')
      }
      return original(tab, message, options)
    }
  })
  assert.deepEqual(await start(), { ok: true })
  await page.locator('#top-action').click()
  await expect.poll(async () => (await state()).steps.length).toBe(1)
  assert(
    await worker.evaluate(() => globalThis.missingFrameSnapshots > 0),
    'Missing-receiver injection did not run',
  )
  assert(
    (await state()).capturedSteps[0].redactions.some(
      (mask) =>
        mask.rule === 'frame-unavailable' &&
        mask.rect.width === pixels.width &&
        mask.rect.height === pixels.height,
    ),
    'Unresolved native frames did not mask the captured viewport',
  )
  await worker.evaluate(() => globalThis.restoreFrameMessages())
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'CANCEL' }))
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs)
    globalThis.restoreFrameMessages = () => {
      chrome.tabs.sendMessage = original
    }
    chrome.tabs.sendMessage = async (tab, message, options) =>
      message.type === 'FRAME_SNAPSHOT' && options?.frameId !== 0
        ? { ok: false, error: 'PRIVATE_FAILURE_DATA' }
        : original(tab, message, options)
  })
  assert.equal((await start()).ok, false)
  const failed = await state()
  assert.equal(failed.recording, false)
  assert.match(failed.captureError, /metadata or privacy masks/)
  assert(!JSON.stringify(failed).includes('PRIVATE_'))
  assert.equal(
    (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' })))
      .ok,
    false,
  )
  await worker.evaluate(() => globalThis.restoreFrameMessages())
  assert.deepEqual(errors, [])
  console.log(
    'Native frame capture verified: identical-src siblings, cross-origin shadow/nesting, blank/srcdoc/opaque inheritance, border/scale clipping, applied provenance/pixels, private probes and no recorded field values.',
  )
} finally {
  await context?.close()
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  )
}

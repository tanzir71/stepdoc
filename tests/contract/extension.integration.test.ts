import { beforeAll, afterAll, it, expect } from 'vitest'
import {
  chromium,
  expect as browserExpect,
  type BrowserContext,
} from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { guideSchema } from '@stepdoc/schema'
import {
  apiDevicesSchema,
  apiPairingCodeSchema,
} from '@stepdoc/schema/storage-api'
import { phpFixture } from './php-fixture'
import { extensionWorker } from '../../apps/extension/scripts/extension-worker.mjs'

let fixture: Awaited<ReturnType<typeof phpFixture>>
let context: BrowserContext | undefined
interface FixtureBrowserApi {
  storage: { local: { get(keys: string[]): Promise<Record<string, unknown>> } }
  tabs: {
    query(
      query: object,
    ): Promise<Array<{ id: number; windowId: number; url?: string }>>
    update(id: number, options: object): Promise<unknown>
  }
  windows: { update(id: number, options: object): Promise<unknown> }
}
beforeAll(async () => {
  fixture = await phpFixture({ maxUploadBytes: 16 * 1024 * 1024 })
})
afterAll(async () => {
  await context?.close()
  await fixture?.close()
})

it('pairs the real extension to PHP, saves a large masked capture with scoped uploads, reopens and revokes its connection', async () => {
  const dir = fileURLToPath(
    new URL('../../apps/extension/.output/chrome-mv3/', import.meta.url),
  )
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
  context.setDefaultTimeout(15000)
  const worker = await extensionWorker(context)
  const workerUrl = new URL(worker.url()),
    origin = `${workerUrl.protocol}//${workerUrl.host}`
  const sourceUrl = 'http://127.0.0.1:48931/source'
  const source = await context.newPage()
  await source.route('http://127.0.0.1:48931/**', async (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><canvas id="noise" style="position:fixed;inset:0;z-index:-1"></canvas><main><label>Email <input id="email" type="email"></label><button id="one">One</button><button id="two">Two</button><button id="three">Three</button><button id="four">Four</button><button id="five">Five</button></main></body></html>',
    }),
  )
  await source.goto(sourceUrl)
  await source.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#noise')!
    canvas.width = innerWidth
    canvas.height = innerHeight
    const ctx = canvas.getContext('2d')!,
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
  const panel = await context.newPage()
  await panel.goto(`${origin}/sidepanel.html?view=pair`)
  await browserExpect(panel.locator('[data-sd=pair-server]')).toBeEnabled()
  const admin = (path: string, method = 'GET') =>
    fetch(fixture.server.api + path, {
      method,
      headers: { Authorization: `Bearer ${fixture.owner.token}` },
      signal: AbortSignal.timeout(15000),
    })
  const before = apiDevicesSchema.parse(await (await admin('devices')).json())
  const issued = await admin('pairing/codes', 'POST')
  expect(issued.status).toBe(201)
  const code = apiPairingCodeSchema
    .parse(await issued.json())
    .code.replace('-', '')
  await panel.locator('[data-sd=pair-server]').fill(fixture.server.api)
  for (let i = 0; i < 6; i++)
    await panel.locator(`[data-sd=pair-code-${i + 1}]`).fill(code[i]!)
  await panel.locator('[data-sd=pair-submit]').click()
  await browserExpect(
    panel.getByRole('heading', { name: 'Server paired', exact: true }),
  ).toBeVisible()
  await panel.locator('[data-sd=pair-test]').click()
  await browserExpect(
    panel.getByText('Connection checked', { exact: true }),
  ).toBeVisible({ timeout: 15000 })
  const devices = apiDevicesSchema.parse(await (await admin('devices')).json())
  const added = devices.filter(
    (device) => !before.some((previous) => previous.id === device.id),
  )
  expect(added.length).toBe(1)
  const device = added[0]!
  expect(/^[a-f0-9]{32}$/.test(device.id)).toBe(true)
  expect(device.kind).toBe('extension')
  expect(device.scopes).toEqual(['capture:write', 'guides:read'])
  expect(
    fixture.inspect(`SELECT extension_id FROM tokens WHERE id='${device.id}'`),
  ).toEqual([{ extension_id: origin }])
  await panel.reload()
  await browserExpect(
    panel.getByText('Connection checked', { exact: true }),
  ).toBeVisible()
  await panel.locator('[data-sd=pair-test]').click()
  await browserExpect(panel.locator('[data-sd=pair-status]')).toHaveText(
    'Connection checked.',
  )

  await panel.locator('[data-sd=pair-back]').click()
  await panel.locator('[data-sd=capture-destination-server]').click()
  // This is the side-panel surface. Its source is the active tab in the focused
  // window; the explicit picker belongs to surface=tab controls.
  const sourceTab = await worker.evaluate(async (url) => {
    const api = (globalThis as unknown as { chrome: FixtureBrowserApi }).chrome
    return (await api.tabs.query({})).find((tab) => tab.url === url)
  }, sourceUrl)
  expect(sourceTab).toBeTruthy()
  await source.bringToFront()
  await worker.evaluate(async (tab) => {
    const api = (globalThis as unknown as { chrome: FixtureBrowserApi }).chrome
    await api.windows.update(tab.windowId, { focused: true })
    await api.tabs.update(tab.id, { active: true })
  }, sourceTab!)
  const press = async (name: string) => {
    await browserExpect(panel.locator(`[data-sd=${name}]`)).toBeEnabled()
    await panel
      .locator(`[data-sd=${name}]`)
      .evaluate((element) => (element as HTMLButtonElement).click())
  }
  const phase = () =>
    worker.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: FixtureBrowserApi })
        .chrome
      return (await api.storage.local.get(['captureReview'])).captureReview as
        | {
            phase?: string
          }
        | undefined
    })
  await press('capture-start')
  await browserExpect
    .poll(async () => (await phase())?.phase, { timeout: 20000 })
    .toBe('recording')
  await source.locator('#email').fill('PRIVATE_TYPED_NATIVE_CAPTURE')
  let expected = 1
  for (const button of ['one', 'two', 'three', 'four', 'five']) {
    await source.locator(`#${button}`).click()
    expected++
    await browserExpect
      .poll(
        async () =>
          worker.evaluate(async () => {
            const api = (globalThis as unknown as { chrome: FixtureBrowserApi })
              .chrome
            return (
              (await api.storage.local.get(['capturedSteps']))
                .capturedSteps as unknown[]
            ).length
          }),
        { timeout: 20000 },
      )
      .toBe(expected)
      .catch(async (error: unknown) => {
        const diagnostic = await worker.evaluate(async () => {
          const api = (globalThis as unknown as { chrome: FixtureBrowserApi })
            .chrome
          const state = await api.storage.local.get([
            'captureReview',
            'captureError',
            'recording',
            'steps',
            'capturedSteps',
          ])
          return {
            phase: (state.captureReview as { phase?: string } | undefined)
              ?.phase,
            error: state.captureError,
            recording: state.recording,
            count: (state.capturedSteps as unknown[] | undefined)?.length,
            retainedBytes: (
              state.steps as Array<{ screenshot: string }> | undefined
            )?.reduce((sum, step) => sum + step.screenshot.length, 0),
          }
        })
        console.log('Native capture metadata after failed action', diagnostic)
        throw error
      })
  }
  await press('capture-review')
  await browserExpect
    .poll(async () => (await phase())?.phase, { timeout: 20000 })
    .toBe('review')
  const retained = await worker.evaluate(async () => {
    const api = (globalThis as unknown as { chrome: FixtureBrowserApi }).chrome
    const state = await api.storage.local.get([
      'captureSessionId',
      'steps',
      'capturedSteps',
      'captureReview',
    ])
    const frames = state.steps as Array<{ screenshot: string }>
    const hashes: string[] = []
    for (const frame of frames) {
      const file = await (await fetch(frame.screenshot)).blob()
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
      )
      hashes.push(
        [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      )
    }
    return {
      sessionId: state.captureSessionId as string,
      total: frames.reduce((sum, frame) => sum + frame.screenshot.length, 0),
      hashes,
      privateText: JSON.stringify(state).includes(
        'PRIVATE_TYPED_NATIVE_CAPTURE',
      ),
      destination: (
        state.captureReview as { destination?: { kind?: string } } | undefined
      )?.destination?.kind,
    }
  })
  expect(retained.privateText).toBe(false)
  expect(retained.destination).toBe('server')
  expect(retained.total).toBeGreaterThan(10 * 1024 * 1024)
  const id = `capture-${retained.sessionId}`
  expect(id).toMatch(/^capture-[a-f0-9-]{36}$/)
  await press('capture-save')
  await browserExpect
    .poll(async () => (await phase())?.phase, { timeout: 30000 })
    .toBe('idle')
  const stored = await admin(`guides/${id}`)
  expect(stored.status).toBe(200)
  const saved = guideSchema.parse(await stored.json())
  // Prove actual worker transfers at the PHP storage boundary: every committed
  // image key must come from this paired device's multipart staging audit.
  expect(
    fixture.inspect(
      `SELECT COUNT(*) AS n FROM audit_log WHERE action='capture.blob' AND member_id='token:${device.id}' AND subject IN (SELECT key FROM blobs WHERE guide_id='${id}')`,
    ),
  ).toEqual([{ n: 12 }])
  expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(32768)
  expect(saved.steps).toHaveLength(6)
  expect(saved.steps[0]!.value?.kind).toBe('secret')
  expect(
    saved.steps.some((step) =>
      step.redactions.some((mask) => mask.status === 'applied'),
    ),
  ).toBe(true)
  expect(JSON.stringify(saved)).not.toContain('PRIVATE_TYPED_NATIVE_CAPTURE')
  for (const [index, step] of saved.steps.entries()) {
    const response = await admin(`blobs/${step.screenshot!.original!}`)
    expect(response.status).toBe(200)
    expect(
      createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex'),
    ).toBe(retained.hashes[index])
  }
  expect(
    fixture.inspect(
      `SELECT COUNT(*) AS n FROM guide_versions WHERE guide_id='${id}'`,
    ),
  ).toEqual([{ n: 1 }])
  // Hosted editor serving/sign-in is the next runtime/installer unit. This case
  // verifies the actual extension save, stored bytes and returned route only.
  await browserExpect(
    panel.locator('[data-sd=capture-recent]'),
  ).toHaveAttribute('href', `${fixture.server.origin}/tools/g/${id}/edit`)
  await panel.locator('[data-sd=capture-pair]').click()
  await browserExpect(panel.locator('[data-sd=pair-test]')).toBeEnabled()
  const revoked = await admin(`devices/${device.id}`, 'DELETE')
  expect(revoked.status).toBe(204)
  await panel.locator('[data-sd=pair-test]').click()
  await browserExpect(
    panel.getByText('Access revoked', { exact: true }),
  ).toBeVisible()
  await browserExpect(panel.locator('[data-sd=pair-status]')).toContainText(
    'no longer has server access',
  )
})

import { beforeAll, afterAll, it, expect } from 'vitest'
import {
  chromium,
  expect as browserExpect,
  type BrowserContext,
} from '@playwright/test'
import { fileURLToPath } from 'node:url'
import {
  apiDevicesSchema,
  apiPairingCodeSchema,
} from '@stepdoc/schema/storage-api'
import { phpFixture } from './php-fixture'
import { extensionWorker } from '../../apps/extension/scripts/extension-worker.mjs'

let fixture: Awaited<ReturnType<typeof phpFixture>>
let context: BrowserContext | undefined
beforeAll(async () => {
  fixture = await phpFixture()
})
afterAll(async () => {
  await context?.close()
  await fixture?.close()
})

it('pairs the real extension to PHP, checks its private bearer connection, reopens it and enforces revocation', async () => {
  const dir = fileURLToPath(
    new URL('../../apps/extension/.output/chrome-mv3/', import.meta.url),
  )
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
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

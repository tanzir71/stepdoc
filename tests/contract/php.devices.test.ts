import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { expect as browserExpect, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { authFixture, type AuthFixture } from './auth-fixture'
import { authBrowser } from './auth-browser'
import {
  issuedTokenSchema,
  apiDevicesSchema,
} from '@stepdoc/schema/storage-api'

let fixture: AuthFixture
let native: Awaited<ReturnType<typeof authBrowser>> | undefined
let runtimeFailures: string[] = []
const hook = (page: Page, name: string) => page.locator(`[data-sd="${name}"]`)
beforeEach(async () => {
  runtimeFailures = []
  fixture = await authFixture()
}, 90000)
afterEach(async () => {
  await native?.close()
  native = undefined
  await fixture?.close()
  expect(runtimeFailures).toEqual([])
})
async function signIn(role: 'owner' | 'editor' | 'viewer' = 'owner') {
  native = await authBrowser(fixture)
  const { page } = native
  page.on('pageerror', () => runtimeFailures.push('Page runtime error'))
  page.on('response', (response) => {
    if (
      response.status() >= 400 &&
      ['script', 'stylesheet', 'image', 'font'].includes(
        response.request().resourceType(),
      )
    )
      runtimeFailures.push(
        'Production asset failed: ' +
          response.status() +
          ' ' +
          new URL(response.url()).pathname,
      )
  })
  page.on('request', (request) => {
    if (
      !request.url().startsWith(fixture.server.origin) &&
      !/^(data:|blob:)/.test(request.url())
    )
      runtimeFailures.push('External request')
  })
  await page.goto(fixture.server.origin + '/tools/settings/devices')
  await hook(page, 'auth-method-email').click()
  await hook(page, 'auth-email').fill(fixture.members[role].email)
  await hook(page, 'auth-submit').click()
  await browserExpect(hook(page, 'auth-code')).toBeVisible()
  try {
    await hook(page, 'auth-code').fill(
      fixture.smtp.code(fixture.members[role].email),
    )
  } catch {
    throw new Error('Private fixture code could not be entered')
  }
  await hook(page, 'auth-submit').click()
  await hook(page, 'auth-continue').click()
  await browserExpect(
    page.getByRole('heading', { name: 'Devices & tokens', exact: true }),
  ).toBeVisible()
  return native
}
async function accessible(page: Page, name?: string) {
  await page.evaluate(() => document.fonts.ready)
  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations
      .filter((item) => item.impact === 'serious' || item.impact === 'critical')
      .map((item) => ({
        id: item.id,
        targets: item.nodes.map((node) => node.target),
      })),
  ).toEqual([])
  if (!name) return
  const tree = await page.locator('.settings-layout').ariaSnapshot()
  const file = new URL(
    `../../docs/v2/screens/${name}.aria.txt`,
    import.meta.url,
  )
  if (process.env.UPDATE_DEVICES_ARIA === '1')
    await writeFile(file, tree + '\n')
  else expect(tree + '\n').toBe(await readFile(file, 'utf8'))
  await page.screenshot({
    path: new URL(
      `../../docs/v2/screens/${name}.png`,
      import.meta.url,
    ).pathname.replace(/^\/([A-Z]:)/i, '$1'),
  })
}
async function createForm(page: Page, name: string) {
  await hook(page, 'token-create').click()
  await browserExpect(page.getByRole('dialog')).toBeVisible()
  await hook(page, 'token-name').fill(name)
  await hook(page, 'token-scope-guides-read').check()
}
async function assertPrivateAbsent(page: Page, secrets: string[]) {
  const safe = await page.evaluate((values) => {
    const places = [
      document.body.textContent ?? '',
      location.href,
      JSON.stringify(localStorage),
      JSON.stringify(sessionStorage),
    ]
    return values.every((value) =>
      places.every((place) => !place.includes(value)),
    )
  }, secrets)
  expect(safe).toBe(true)
}
describe('W08 real authenticated devices and tokens', () => {
  it('creates a one-use pairing, issues a shown-once scoped token, revokes it and preserves private persistence boundaries', async () => {
    const { page } = await signIn()
    await browserExpect(hook(page, 'devices-refresh')).toBeEnabled()
    await hook(page, 'pairing-create').click()
    await browserExpect(hook(page, 'pairing-code')).toBeVisible()
    const code = await page.evaluate(
      () =>
        document.querySelector('[data-sd="pairing-code"] .sd-sr-only')!
          .textContent!,
    )
    const claimed = await fetch(fixture.server.api + 'pairing/claim', {
      method: 'POST',
      headers: {
        Origin: fixture.extensionOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        deviceName: 'W08 paired browser',
        extensionId: new URL(fixture.extensionOrigin).hostname,
      }),
    })
    expect(claimed.status).toBe(201)
    const paired = issuedTokenSchema.parse(await claimed.json())
    expect(paired.scopes).toEqual(['capture:write', 'guides:read'])
    const reused = await fetch(fixture.server.api + 'pairing/claim', {
      method: 'POST',
      headers: {
        Origin: fixture.extensionOrigin,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code,
        deviceName: 'Replay attempt',
        extensionId: new URL(fixture.extensionOrigin).hostname,
      }),
    })
    expect(reused.status).toBe(400)
    await hook(page, 'devices-refresh').click()
    await browserExpect(
      page.getByText('W08 paired browser', { exact: true }),
    ).toBeVisible()
    await createForm(page, 'W08 read client')
    await hook(page, 'token-submit').click()
    await browserExpect(hook(page, 'token-value')).toBeVisible()
    const token = await hook(page, 'token-value').inputValue()
    await native!.context.grantPermissions(
      ['clipboard-read', 'clipboard-write'],
      { origin: fixture.server.origin },
    )
    await hook(page, 'token-copy').click()
    expect(
      await page.evaluate(
        async (value) => (await navigator.clipboard.readText()) === value,
        token,
      ),
    ).toBe(true)
    const allowed = await fetch(fixture.server.api + 'guides', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(allowed.status).toBe(200)
    const denied = await fetch(fixture.server.api + 'tokens', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'Forbidden escalation', scopes: ['admin'] }),
    })
    expect(denied.status).toBe(403)
    // No screenshot/aria failure output contains a real shown-once token.
    const persisted = fixture.inspect(
      "SELECT token_hash,scopes FROM tokens WHERE name='W08 read client'",
    ) as Array<{ token_hash: string; scopes: string }>
    expect(persisted.length).toBe(1)
    expect(persisted[0]!.token_hash.length).toBe(64)
    expect(persisted[0]!.token_hash === token).toBe(false)
    expect(JSON.parse(persisted[0]!.scopes)).toEqual(['guides:read'])
    await hook(page, 'token-done').click()
    await assertPrivateAbsent(page, [token, paired.token])
    await page.reload()
    await browserExpect(
      page.getByText('W08 read client', { exact: true }),
    ).toBeVisible()
    await assertPrivateAbsent(page, [token, paired.token, code])
    await page
      .getByRole('button', { name: 'Revoke W08 read client', exact: true })
      .click()
    await page.keyboard.press('Escape')
    expect(
      (
        await fetch(fixture.server.api + 'guides', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200)
    await page
      .getByRole('button', { name: 'Revoke W08 read client', exact: true })
      .click()
    await hook(page, 'device-revoke-confirm').click()
    await browserExpect(page.getByRole('dialog')).not.toBeVisible()
    await browserExpect(
      page.getByText('W08 read client', { exact: true }),
    ).not.toBeVisible()
    expect(
      (
        await fetch(fixture.server.api + 'guides', {
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401)
    await accessible(page)
    await assertPrivateAbsent(page, [token, paired.token, code])
  }, 120000)
  it('matches W08 geometry/assets with accessible light, dark, narrow and token/revoke dialogs', async () => {
    const { page } = await signIn()
    await page.setViewportSize({ width: 1440, height: 900 })
    await browserExpect(hook(page, 'devices-refresh')).toBeEnabled()
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await accessible(page, 'w08-devices-light')
    const geometry = await page.locator('.settings-layout').evaluate((node) => {
      const box = (selector: string) => {
        const rect = node.querySelector(selector)!.getBoundingClientRect()
        return {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      }
      return {
        nav: box('.settings-nav'),
        main: box('.devices-workspace'),
        card: box('.pairing-card'),
        assets: [...node.querySelectorAll<HTMLElement>('[data-asset]')]
          .filter((item) => item.getClientRects().length)
          .map((item) => ({
            name: item.dataset.asset,
            width: item.offsetWidth,
            height: item.offsetHeight,
            paint: getComputedStyle(item).maskImage !== 'none',
          })),
      }
    })
    expect(geometry.nav.width).toBe(240)
    expect(geometry.main.x).toBe(488)
    expect(geometry.card).toMatchObject({
      x: 496,
      y: 104,
      width: 912,
      height: 166,
    })
    for (const asset of geometry.assets) {
      expect(asset.paint).toBe(true)
      const size =
        asset.name?.startsWith('devices-bot') ||
        asset.name === 'devices-extension' ||
        asset.name === 'devices-terminal'
          ? 18
          : asset.name === 'devices-refresh'
            ? 14
            : 16
      expect([asset.width, asset.height]).toEqual([size, size])
    }
    await createForm(page, 'Read client')
    await accessible(page, 'w08-token-create')
    await page.keyboard.press('Escape')
    await page
      .getByRole('button', { name: /^Revoke / })
      .first()
      .click()
    await accessible(page, 'w08-device-revoke')
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await accessible(page, 'w08-devices-dark')
    await page.setViewportSize({ width: 390, height: 844 })
    await accessible(page, 'w08-devices-narrow')
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    // Expiry uses a deliberately noncredential fixture; real one-use exchange is above.
    await page.route(fixture.server.api + 'pairing/codes', (route) =>
      route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'ABC-DEF',
          expiresAt: new Date(Date.now() + 2000).toISOString(),
        }),
      }),
    )
    await hook(page, 'pairing-create').click()
    await browserExpect(hook(page, 'pairing-code')).toBeVisible()
    await browserExpect(hook(page, 'pairing-create')).toBeVisible()
    await browserExpect(hook(page, 'devices-feedback')).toContainText('expired')
    await page.route(fixture.server.api + 'tokens', (route) =>
      route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"private":"MUST_NOT_DISPLAY"}',
      }),
    )
    await createForm(page, 'Retry client')
    await hook(page, 'token-submit').click()
    await browserExpect(hook(page, 'device-dialog-feedback')).toContainText(
      'could not be confirmed',
    )
    await accessible(page, 'w08-token-failure-narrow')
    expect(
      (await page.locator('body').innerText()).includes('MUST_NOT_DISPLAY'),
    ).toBe(false)
    await page.keyboard.press('Escape')
  }, 120000)
  it('cancels a committed-but-held token response, ignores its secret, and clears dialogs on actual session expiry', async () => {
    const { page } = await signIn()
    let release: (() => void) | undefined
    let committed: (() => void) | undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const accepted = new Promise<void>((resolve) => {
      committed = resolve
    })
    let createdToken = ''
    let attempts = 0
    await page.route(fixture.server.api + 'tokens', async (route) => {
      attempts++
      const response = await route.fetch()
      const body = issuedTokenSchema.parse(await response.json())
      createdToken = body.token
      committed?.()
      await held
      await route.fulfill({ response }).catch(() => {})
    })
    await createForm(page, 'Held client')
    await hook(page, 'token-submit').click()
    await accepted
    await page.keyboard.press('Escape')
    release?.()
    await hook(page, 'devices-refresh').click()
    await browserExpect(
      page.getByText('Held client', { exact: true }),
    ).toBeVisible()
    expect(attempts).toBe(1)
    await assertPrivateAbsent(page, [createdToken])
    await page.unroute(fixture.server.api + 'tokens')
    await createForm(page, 'Expires with session')
    await hook(page, 'token-submit').click()
    await browserExpect(hook(page, 'token-value')).toBeVisible()
    const once = await hook(page, 'token-value').inputValue()
    fixture.inspect('UPDATE sessions SET expires_at=0')
    // Refresh is inert behind the dialog. A real focus recheck discovers expiry.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await browserExpect(hook(page, 'auth-method-email')).toBeVisible()
    expect(await hook(page, 'token-value').count()).toBe(0)
    await assertPrivateAbsent(page, [createdToken, once])
  }, 120000)
  it('restricts editors to their issued devices and keeps viewer/browser-only workspaces out of management requests', async () => {
    const { page } = await signIn('editor')
    await browserExpect(hook(page, 'devices-refresh')).toBeEnabled()
    await createForm(page, 'Editor client')
    expect(await hook(page, 'token-scope-admin').count()).toBe(0)
    await hook(page, 'token-submit').click()
    await browserExpect(hook(page, 'token-value')).toBeVisible()
    await hook(page, 'token-done').click()
    const response = await native!.request('devices')
    const rows = apiDevicesSchema.parse(response.body)
    expect(rows.map((row) => row.name)).toEqual(['Editor client'])
    await hook(page, 'auth-logout').click()
    await native!.close()
    native = undefined
    const next = await signIn('viewer')
    let requests = 0
    next.page.on('request', (request) => {
      if (
        request.url().startsWith(fixture.server.api) &&
        /\/(devices|tokens|pairing\/codes)(?:\?|$)/.test(request.url())
      )
        requests++
    })
    await next.page.reload()
    await browserExpect(
      next.page.getByRole('heading', { name: 'Workspace access required' }),
    ).toBeVisible()
    expect(await hook(next.page, 'token-create').count()).toBe(0)
    expect(requests).toBe(0)
    await accessible(next.page, 'w08-devices-viewer')
    await next.page.goto(
      fixture.server.origin + '/tools/browser/settings/devices',
    )
    await browserExpect(
      next.page.getByRole('heading', { name: 'Server devices', exact: true }),
    ).toBeVisible()
    expect(requests).toBe(0)
    await accessible(next.page, 'w08-devices-browser')
  }, 120000)
})

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  expect as browserExpect,
  type Page,
  type Request,
} from '@playwright/test'
import { HttpAdapter } from '@stepdoc/storage/http'
import { guideSchema } from '@stepdoc/schema'
import { authFixture, type AuthFixture } from './auth-fixture'
import { authBrowser } from './auth-browser'
import { phpFixture } from './php-fixture'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'

let fixture: AuthFixture
let native: Awaited<ReturnType<typeof authBrowser>> | undefined
beforeEach(async () => {
  fixture = await authFixture()
}, 90000)
afterEach(async () => {
  await native?.close()
  native = undefined
  await fixture?.close()
})
const hook = (page: Page, name: string) => page.locator(`[data-sd="${name}"]`)
async function accessible(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  const results = await new AxeBuilder({ page }).analyze()
  expect(
    results.violations
      .filter((item) => item.impact === 'serious' || item.impact === 'critical')
      .map((item) => ({ id: item.id, impact: item.impact })),
  ).toEqual([])
}
async function audit(page: Page, name: string) {
  await accessible(page)
  const path = new URL(
    `../../docs/v2/screens/${name}.aria.txt`,
    import.meta.url,
  )
  const tree = await page.locator('.hosted-card').ariaSnapshot()
  if (process.env.UPDATE_HOSTED_ARIA === '1') await writeFile(path, tree + '\n')
  else expect(tree + '\n').toBe(await readFile(path, 'utf8'))
}
async function painted(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  await browserExpect
    .poll(() =>
      page
        .locator('.hosted-card .sd-logo img:visible')
        .evaluate(
          (node) =>
            (node as HTMLImageElement).complete &&
            (node as HTMLImageElement).naturalWidth > 0,
        ),
    )
    .toBe(true)
  const mark = await page
    .locator('.hosted-card .sd-logo img:visible')
    .boundingBox()
  expect(mark && [Math.round(mark.width), Math.round(mark.height)]).toEqual([
    24, 24,
  ])
}
async function emailSignIn(page: Page, email = fixture.members.owner.email) {
  await hook(page, 'auth-method-email').click()
  await hook(page, 'auth-email').fill(email)
  await hook(page, 'auth-submit').click()
  await browserExpect(hook(page, 'auth-code')).toBeVisible()
  await hook(page, 'auth-code').fill(fixture.smtp.code(email))
  await hook(page, 'auth-submit').click()
}
async function seedGuide(id: string) {
  const adapter = await HttpAdapter.open(fixture.server.api, {
    auth: { kind: 'bearer', token: () => fixture.owner.token },
  })
  try {
    const now = new Date().toISOString()
    await adapter.createGuide(
      guideSchema.parse({
        schema: 'stepdoc/guide@1',
        id,
        title: 'Hosted guide',
        version: 1,
        createdAt: now,
        updatedAt: now,
        steps: [
          {
            id: 'first',
            index: 1,
            type: 'manual',
            title: 'Original instruction',
          },
        ],
      }),
    )
  } finally {
    adapter.close()
  }
}
async function stored(id: string) {
  const response = await fetch(fixture.server.api + `guides/${id}`, {
    headers: { Authorization: `Bearer ${fixture.owner.token}` },
  })
  expect(response.status).toBe(200)
  return guideSchema.parse(await response.json())
}

describe('PHP hosted production app', () => {
  it('shows a configuration failure without issuing API requests or opening local storage for a corrupt bootstrap', async () => {
    native = await authBrowser(fixture)
    const { page } = native
    let apiRequests = 0
    const failures: string[] = []
    page.on('pageerror', () => failures.push('Page runtime error'))
    page.on('request', (request) => {
      if (request.url().startsWith(fixture.server.api)) apiRequests++
      if (
        !request.url().startsWith(fixture.server.origin) &&
        !/^(data:|blob:)/.test(request.url())
      )
        failures.push('Nonlocal request')
    })
    await page.route(fixture.server.origin + '/tools/', async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          'content="/tools/api/v1/"',
          'content="https://outside.invalid/api/v1/"',
        ),
      })
    })
    await page.goto(fixture.server.origin + '/tools/')
    await browserExpect(
      page.getByRole('heading', { name: 'App configuration is unavailable' }),
    ).toBeVisible()
    expect(apiRequests).toBe(0)
    expect((await page.evaluate(() => indexedDB.databases())).length).toBe(0)
    expect(failures).toEqual([])
  }, 60000)
  it('serves installation-relative HTML/assets with correct methods, MIME, headers and no filesystem fallthrough', async () => {
    const base = fixture.server.origin + '/tools'
    const redirect = await fetch(base, { redirect: 'manual' })
    expect(redirect.status).toBe(308)
    expect(redirect.headers.get('location')).toBe('/tools/')
    const response = await fetch(base + '/g/hosted-sample/edit?step=1')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    )
    const html = await response.text()
    expect(html).toContain('<meta name="stepdoc-api" content="/tools/api/v1/">')
    expect(html.includes(fixture.owner.token)).toBe(false)
    const assets = [
      ...html.matchAll(
        /(?:src|href)="(\/tools\/(?:assets\/[^" ]+|theme-init.js))"/g,
      ),
    ].map((item) => item[1]!)
    expect(assets.length).toBeGreaterThanOrEqual(3)
    for (const path of assets) {
      const asset = await fetch(fixture.server.origin + path)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toMatch(/javascript|css/)
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0)
      const head = await fetch(fixture.server.origin + path, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect((await head.arrayBuffer()).byteLength).toBe(0)
    }
    for (const path of [
      '/tools/assets/missing.js',
      '/tools/assets/../../bootstrap.php',
      '/tools/assets/%2e%2e%2fbootstrap.php',
      '/tools/vendor/autoload.php',
      '/tools/data/stepdoc.sqlite',
      '/tools/index.php',
      '/tools/not-a-page',
      '/other/',
    ]) {
      const denied = await fetch(fixture.server.origin + path)
      expect(denied.status).toBe(404)
      expect(denied.headers.get('content-type')).toContain('application/json')
      expect((await denied.text()).includes('<?php')).toBe(false)
    }
    expect((await fetch(base + '/', { method: 'POST' })).status).toBe(405)
    expect((await fetch(fixture.server.api + 'guides')).status).toBe(401)
    const root = await phpFixture({ apiPath: '/api/v1' })
    try {
      const html = await (
        await fetch(root.server.origin + '/g/root-guide/edit')
      ).text()
      expect(html).toContain('content="/api/v1/"')
      expect(html).toContain('src="/assets/')
    } finally {
      await root.close()
    }
  }, 90000)

  it('uses real email/passkeys/recovery, resumes an expired editor draft and reloads server edits without browser storage', async () => {
    await seedGuide('hosted-native')
    native = await authBrowser(fixture)
    const { page, context } = native
    await page.setViewportSize({ width: 1440, height: 900 })
    const failures: string[] = []
    const cancelled: Request[] = []
    const authResponses: Array<{ path: string; status: number }> = []
    page.on('response', (response) => {
      const path = new URL(response.url()).pathname
      if (path.includes('/api/v1/'))
        authResponses.push({
          path: response.request().method() + ' ' + path,
          status: response.status(),
        })
    })
    page.on('pageerror', () => failures.push('Page runtime error'))
    page.on('requestfailed', (request) => {
      if (
        request.failure()?.errorText === 'net::ERR_ABORTED' &&
        request.url().startsWith(fixture.server.api)
      )
        cancelled.push(request)
      else
        failures.push(
          `Asset or transport request failed: ${new URL(request.url()).pathname} (${request.failure()?.errorText ?? 'unknown'})`,
        )
    })
    page.on('request', (request) => {
      if (
        !request.url().startsWith(fixture.server.origin) &&
        !/^(blob:|data:)/.test(request.url())
      )
        failures.push('Nonlocal request')
    })
    await page.goto(
      fixture.server.origin + '/tools/g/hosted-native/edit?step=1',
    )
    await browserExpect(
      page.getByRole('heading', { name: 'Sign in to your workspace' }),
    ).toBeVisible()
    const card = await page.locator('.hosted-card').boundingBox()
    expect(card && Math.round(card.width)).toBe(880)
    expect(await page.locator('.sd-logo img:visible').count()).toBe(1)
    await mkdir(
      fileURLToPath(new URL('../../docs/v2/screens/', import.meta.url)),
      { recursive: true },
    )
    await painted(page)
    await page.screenshot({
      path: fileURLToPath(
        new URL('../../docs/v2/screens/m12-signin-light.png', import.meta.url),
      ),
    })
    await audit(page, 'm12-signin-light')
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
    })
    await audit(page, 'm12-signin-dark')
    await painted(page)
    await page.screenshot({
      path: fileURLToPath(
        new URL('../../docs/v2/screens/m12-signin-dark.png', import.meta.url),
      ),
    })
    await page.evaluate(() => {
      document.documentElement.dataset.theme = 'light'
    })
    await emailSignIn(page)
    await browserExpect(
      page.getByRole('heading', { name: 'Add a passkey to this device' }),
    ).toBeVisible()
    await accessible(page)
    await hook(page, 'auth-enroll').click()
    await browserExpect(hook(page, 'auth-recovery-codes'))
      .toBeVisible()
      .catch(async (error) => {
        console.log('Enrollment boundary metadata', {
          authResponses,
          ui: await page.evaluate(() => ({
            headings: [...document.querySelectorAll('.hosted-card h1')].map(
              (node) => node.textContent,
            ),
            status: document.querySelector('.hosted-card [role=status]')
              ?.textContent,
            enrolling: !!document.querySelector('[data-sd=auth-enroll]'),
          })),
        })
        throw error
      })
    const recovery = (
      await hook(page, 'auth-recovery-codes').innerText()
    ).split('\n')
    await accessible(page)
    expect(recovery.length === 10 && new Set(recovery).size === 10).toBe(true)
    await hook(page, 'auth-recovery-saved').check()
    await hook(page, 'auth-continue').click()
    await browserExpect(hook(page, 'step-title')).toHaveValue(
      'Original instruction',
    )
    expect(page.url()).toBe(
      fixture.server.origin + '/tools/g/hosted-native/edit?step=1',
    )
    expect(
      (await context.cookies()).some(
        (cookie) =>
          cookie.name === 'sd_session' &&
          cookie.httpOnly &&
          cookie.secure &&
          cookie.path === '/tools/',
      ),
    ).toBe(true)
    // Expire the real server session before autosave; keep the same editor mounted
    // through sign-in so the unsaved draft can be retried with the rotated cookie.
    fixture.inspect(
      `UPDATE sessions SET expires_at=0 WHERE member_id='${fixture.members.owner.id}'`,
    )
    let releaseFailure: () => void = () => {}
    let observedFailure: () => void = () => {}
    const heldFailure = new Promise<void>((resolve) => {
      observedFailure = resolve
    })
    const releasedFailure = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })
    let held = false
    await page.route('**/guides/hosted-native', async (route) => {
      if (route.request().method() !== 'PUT' || held) return route.continue()
      held = true
      const response = await route.fetch()
      expect(response.status()).toBe(401)
      observedFailure()
      await releasedFailure
      await route.fulfill({ response })
    })
    await hook(page, 'step-title').fill('Retained after session expiry')
    await page.keyboard.press('Control+s')
    await heldFailure
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await browserExpect(hook(page, 'auth-submit')).toBeVisible()
    await page.keyboard.press('Control+k')
    expect(await page.locator('dialog[open]').count()).toBe(0)
    expect(page.url()).toContain('/tools/g/hosted-native/edit?step=1')
    const [verified] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === fixture.server.api + 'auth/passkey/verify' &&
          response.request().method() === 'POST',
        { timeout: 25000 },
      ),
      hook(page, 'auth-submit').click(),
    ])
    // The native passkey ceremony and HTTP verification precede the UI budget.
    // Retain the five-second editor assertion after a successful verification.
    expect(verified.status()).toBe(200)
    await browserExpect(hook(page, 'step-title')).toBeVisible()
    await browserExpect(hook(page, 'step-title')).toHaveValue(
      'Retained after session expiry',
    )
    releaseFailure()
    await browserExpect(hook(page, 'editor-retry-save')).toBeEnabled()
    await browserExpect(hook(page, 'auth-submit')).toHaveCount(0)
    await page.keyboard.press('Control+s')
    await browserExpect
      .poll(async () => (await stored('hosted-native')).steps[0]!.title)
      .toBe('Retained after session expiry')
      .catch(async (error) => {
        console.log('Save retry boundary metadata', {
          authResponses,
          ui: await page.evaluate(() => ({
            status: document.querySelector('[data-sd=editor-save-status]')
              ?.textContent,
            retry: !!document.querySelector('[data-sd=editor-retry-save]'),
            signin: !!document.querySelector('[data-sd=auth-submit]'),
          })),
        })
        throw error
      })
    await page.reload()
    await browserExpect(hook(page, 'step-title')).toHaveValue(
      'Retained after session expiry',
    )
    await page.locator('[data-sd=editor-library]').click()
    await browserExpect(page).toHaveURL(fixture.server.origin + '/tools/')
    await browserExpect(hook(page, 'library-guide-open')).toContainText(
      'Hosted guide',
    )
    await hook(page, 'auth-logout').click()
    await hook(page, 'auth-method-recovery').click()
    await hook(page, 'auth-email').fill(fixture.members.owner.email)
    await hook(page, 'auth-code').fill(recovery[0]!)
    await hook(page, 'auth-submit').click()
    await browserExpect(
      page.getByRole('heading', { name: 'Add a passkey to this device' }),
    ).toBeVisible()
    await hook(page, 'auth-continue').click()
    await browserExpect(
      page.getByRole('heading', { name: 'Library', exact: true }),
    ).toBeVisible()
    await browserExpect(hook(page, 'library-guide-open')).toContainText(
      'Hosted guide',
    )
    await hook(page, 'auth-logout').click()
    await hook(page, 'auth-method-recovery').click()
    await hook(page, 'auth-email').fill(fixture.members.owner.email)
    await hook(page, 'auth-code').fill(recovery[0]!)
    await hook(page, 'auth-submit').click()
    await browserExpect(
      page.locator('.hosted-card').getByRole('status'),
    ).toContainText('could not be verified')
    const privateData = await page.evaluate(async () => ({
      databases: await indexedDB.databases(),
      storage: JSON.stringify({ ...localStorage, ...sessionStorage }),
    }))
    expect(privateData.databases.length).toBe(0)
    expect(recovery.some((code) => privateData.storage.includes(code))).toBe(
      false,
    )
    for (const request of cancelled) {
      const response = await request.response()
      if (response) {
        // Body/operation cleanup can report ERR_ABORTED after usable headers;
        // the native UI and committed DB assertions above prove completed work.
        expect([200, 202, 204, 400, 401]).toContain(response.status())
      } else {
        // StrictMode cancels its first session/health reads before remounting.
        expect(request.method()).toBe('GET')
        expect(['health', 'auth/session']).toContain(
          request.url().slice(fixture.server.api.length),
        )
      }
    }
    expect(failures).toEqual([])
  }, 120000)

  it('fails closed on an unavailable session endpoint and recovers without opening a browser workspace', async () => {
    native = await authBrowser(fixture)
    const { page } = native
    await page.route('**/auth/session', (route) => route.abort())
    await page.goto(fixture.server.origin + '/tools/')
    await browserExpect(
      page.getByRole('heading', { name: 'Workspace unavailable' }),
    ).toBeVisible()
    expect((await page.evaluate(() => indexedDB.databases())).length).toBe(0)
    await page.unroute('**/auth/session')
    await hook(page, 'auth-retry').click()
    await browserExpect(hook(page, 'auth-submit')).toBeEnabled()
    await page.setViewportSize({ width: 390, height: 844 })
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await painted(page)
    await page.screenshot({
      path: fileURLToPath(
        new URL('../../docs/v2/screens/m12-signin-mobile.png', import.meta.url),
      ),
    })
    await audit(page, 'm12-signin-mobile')
  }, 60000)
})

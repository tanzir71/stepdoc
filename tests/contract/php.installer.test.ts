import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  chromium,
  expect as browserExpect,
  type Page,
  type Locator,
} from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { createHash } from 'node:crypto'
import { readFile, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { installationStatusSchema } from '@stepdoc/schema/installation'
import { apiHealthSchema } from '@stepdoc/schema/storage-api'
import {
  installationArtifact,
  installerFixture,
  apacheAvailable,
  type InstallerFixture,
} from './installer-fixture'

let artifact: Awaited<ReturnType<typeof installationArtifact>>
const fixtures: InstallerFixture[] = []
const browsers: Awaited<ReturnType<typeof chromium.launch>>[] = []
beforeAll(async () => {
  artifact = await installationArtifact()
}, 180000)
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close()
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
async function fixture(
  options: Parameters<typeof installerFixture>[1] = {},
) {
  const value = await installerFixture(artifact, options)
  fixtures.push(value)
  return value
}
const hook = (page: Page, name: string) =>
  page.locator(`[data-sd="${name}"]`)
// Native enrollment performs real HTTP/filesystem work. Match the existing
// client's 25-second request bound; this is not a five-second UI latency test.
const installerNetwork = { timeout: 25000 }
async function native(f: InstallerFixture) {
  const browser = await chromium.launch({ args: ['--disable-gpu'] })
  browsers.push(browser)
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', () => errors.push('Page runtime error'))
  page.on('response', (response) => {
    if (
      ['script', 'stylesheet', 'image', 'font'].includes(
        response.request().resourceType(),
      ) &&
      response.status() >= 400
    )
      errors.push(
        'Production asset failed: ' +
          response.status() +
          ' ' +
          new URL(response.url()).pathname,
      )
  })
  page.on('request', (request) => {
    if (
      !request.url().startsWith(f.origin) &&
      !/^(data:|blob:)/.test(request.url())
    )
      errors.push('External request')
  })
  await page.goto(f.origin + f.base + '/setup')
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send(
    'WebAuthn.addVirtualAuthenticator',
    {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    },
  )
  return { browser, context, page, cdp, authenticatorId, errors }
}
async function privateFill(locator: Locator, value: string) {
  // Playwright's failure log can echo fill arguments; fixture secrets stay out of it.
  try {
    await locator.fill(value)
  } catch {
    throw new Error('Private fixture input could not be entered')
  }
}
async function unlock(page: Page, f: InstallerFixture) {
  await browserExpect(hook(page, 'setup-continue')).toBeEnabled()
  await hook(page, 'setup-continue').click()
  await browserExpect(
    page.getByRole('dialog', { name: 'Authorize this installation' }),
  ).toBeVisible()
  await browserExpect(page).toHaveURL(/view=authorize/)
  await accessible(page)
  await privateFill(hook(page, 'setup-key'), f.key)
  const began = performance.now()
  const exchange = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).searchParams.get('action') === 'claim',
      { timeout: 25000 },
    )
    .then(async (response) => ({
      status: response.status(),
      finished: (await response.finished()) === null,
      milliseconds: Math.round(performance.now() - began),
    }))
    .catch(() => null)
  await hook(page, 'setup-unlock').click()
  try {
    await browserExpect(hook(page, 'setup-owner-email')).toBeVisible(
      installerNetwork,
    )
  } catch (error) {
    const response = await exchange
    console.log('Installation key transition', {
      response,
      elapsed: Math.round(performance.now() - began),
      heading: await page.locator('h1').textContent(),
      feedback: await hook(page, 'setup-feedback').textContent(),
      ownerVisible: await hook(page, 'setup-owner-email').isVisible(),
    })
    throw error
  }
}
async function details(page: Page) {
  await hook(page, 'setup-workspace').fill('Installed workspace')
  await hook(page, 'setup-owner-name').fill('Installation owner')
  await hook(page, 'setup-owner-email').fill('owner@example.test')
}
async function accessible(page: Page) {
  await page.evaluate(() => document.fonts.ready)
  const result = await new AxeBuilder({ page }).analyze()
  expect(
    result.violations
      .filter((item) => ['serious', 'critical'].includes(item.impact ?? ''))
      .map((item) => ({
        id: item.id,
        targets: item.nodes.map((node) => node.target),
      })),
  ).toEqual([])
}
async function audit(page: Page, name: string) {
  await accessible(page)
  const tree = (await page.locator('.setup-card').ariaSnapshot())
    .replace(/localhost:\d+/g, 'localhost')
    .replace(/[A-F0-9]{6}(?:-[A-F0-9]{6}){3}/g, '<recovery-code>')
  const path = new URL(
    `../../docs/v2/screens/${name}.aria.txt`,
    import.meta.url,
  )
  if (process.env.UPDATE_INSTALL_ARIA === '1')
    await writeFile(path, tree + '\n')
  else expect(tree + '\n').toBe(await readFile(path, 'utf8'))
}
function cookie(response: Response): string {
  return (
    response.headers
      .getSetCookie()
      .find((value) => value.startsWith('sd_install='))
      ?.split(';')[0] ?? ''
  )
}
const keyHash = (key: string) =>
  createHash('sha256').update(key).digest('hex')
async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('extracted PHP distribution and first-owner setup', () => {
  it('contains only portable runtime files, serves real host checks, and keeps private paths outside the document root', async () => {
    const f = await fixture({ base: '/tools' })
    expect(Object.keys(f.manifest.files)).toEqual(
      expect.arrayContaining([
        'public/install.php',
        'public/api/index.php',
        'vendor/autoload.php',
        'app/index.html',
        'schema/guide.schema.json',
        'src/Installer.php',
        'src/Backups.php',
        'BACKUPS.md',
      ]),
    )
    const status = installationStatusSchema.parse(
      await (await f.request('status')).json(),
    )
    expect(status.phase).toBe('storage')
    expect(status.ready).toBe(true)
    expect(
      status.checks.find((check) => check.id === 'https')?.status,
    ).toBe('warn')
    expect(await exists(join(f.root, 'data/stepdoc.sqlite'))).toBe(false)
    for (const path of [
      '/setup-key.sha256',
      '/stepdoc.config.json',
      '/vendor/autoload.php',
      '/data/stepdoc.sqlite',
      '/schema/guide.schema.json',
      '/src/Installer.php',
      '/assets/missing.js',
      '/%2e%2e/setup-key.sha256',
    ]) {
      const response = await fetch(f.origin + f.base + path)
      expect(response.status).toBe(404)
      expect((await response.text()).includes(f.root)).toBe(false)
    }
    const html = await fetch(f.origin + f.base + '/setup')
    expect(html.status).toBe(200)
    expect(html.headers.get('cache-control')).toBe('no-store')
    const body = await html.text()
    expect(body.includes(f.key)).toBe(false)
    expect(body.includes('content="/tools/install.php"')).toBe(true)
    const head = await fetch(f.origin + f.base + '/setup', {
      method: 'HEAD',
    })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  }, 60000)

  it('rejects unauthorized, wrong-origin, malformed and oversized setup without provisioning an owner', async () => {
    const f = await fixture()
    for (const action of ['owner-options', 'owner-verify'])
      expect((await f.request(action, {})).status).toBe(401)
    expect((await f.request('claim', { key: 'A'.repeat(43) })).status).toBe(
      401,
    )
    expect(
      (
        await f.request('claim', { key: f.key }, undefined, {
          Origin: 'https://outside.invalid',
        })
      ).status,
    ).toBe(403)
    const malformed = await fetch(f.endpoint + '?action=claim', {
      method: 'POST',
      headers: { Origin: f.origin, 'Content-Type': 'application/json' },
      body: '{',
    })
    expect(malformed.status).toBe(400)
    const oversized = await f.request('claim', { key: 'x'.repeat(140000) })
    expect(oversized.status).toBe(413)
    expect((await f.request('unknown')).status).toBe(404)
    expect(
      (await fetch(f.endpoint + '?action=status', { method: 'DELETE' }))
        .status,
    ).toBe(405)
    expect(await exists(join(f.root, 'data/stepdoc.sqlite'))).toBe(false)
    const bad = await fixture({ badRoot: true })
    const status = installationStatusSchema.parse(
      await (await bad.request('status')).json(),
    )
    expect(status.ready).toBe(false)
    expect(
      status.checks.some(
        (check) =>
          check.id === 'private-storage' && check.status === 'error',
      ),
    ).toBe(true)
    expect((await bad.request('claim', { key: bad.key })).status).toBe(503)
    expect(await exists(join(bad.root, 'data/stepdoc.sqlite'))).toBe(false)
  }, 60000)

  it('serializes claims across PHP processes and expires/revokes hashed temporary enrollment credentials', async () => {
    const f = await fixture({ base: '/tools' })
    const peer = await f.peer()
    const responses = await Promise.all([
      f.request('claim', { key: f.key }),
      f.request(
        'claim',
        { key: f.key },
        undefined,
        { Host: new URL(f.origin).host },
        peer,
      ),
    ])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    const cookies = responses.map(cookie)
    expect(
      cookies.every((value) =>
        /^sd_install=[A-Za-z0-9_-]{43}$/.test(value),
      ),
    ).toBe(true)
    const states = await Promise.all(
      cookies.map(async (value) =>
        installationStatusSchema.parse(
          await (await f.request('status', undefined, value)).json(),
        ),
      ),
    )
    expect(states.filter((value) => value.phase === 'owner')).toHaveLength(
      1,
    )
    const current =
      cookies[states.findIndex((value) => value.phase === 'owner')]!
    const old =
      cookies[states.findIndex((value) => value.phase !== 'owner')]!
    expect(
      (
        await f.request(
          'owner-options',
          {
            workspace: 'Workspace',
            name: 'Owner',
            email: 'owner@example.test',
          },
          old,
        )
      ).status,
    ).toBe(401)
    const options = await f.request(
      'owner-options',
      {
        workspace: 'Workspace',
        name: 'Owner',
        email: 'owner@example.test',
      },
      current,
    )
    expect(options.status).toBe(200)
    expect(
      f.sql<{ n: number }[]>('SELECT count(*) AS n FROM members')[0]?.n,
    ).toBe(1)
    expect(
      f.sql<{ n: number }[]>('SELECT count(*) AS n FROM installation')[0]
        ?.n,
    ).toBe(1)
    f.sql(
      'UPDATE tokens SET expires_at=0 WHERE id=(SELECT token_id FROM installation)',
    )
    expect(
      (
        await f.request(
          'owner-options',
          {
            workspace: 'Workspace',
            name: 'Owner',
            email: 'owner@example.test',
          },
          current,
        )
      ).status,
    ).toBe(401)
    const renewed = await f.request('claim', { key: f.key })
    expect(renewed.status).toBe(200)
    expect(
      (
        await f.request(
          'owner-options',
          {
            workspace: 'Workspace',
            name: 'Owner',
            email: 'owner@example.test',
          },
          cookie(renewed),
        )
      ).status,
    ).toBe(200)
    expect(
      f.sql<{ n: number }[]>('SELECT count(*) AS n FROM members')[0]?.n,
    ).toBe(1)
    f.sql('UPDATE installation SET expires_at=0')
    expect(
      (
        await f.request(
          'owner-options',
          {
            workspace: 'Workspace',
            name: 'Owner',
            email: 'owner@example.test',
          },
          cookie(renewed),
        )
      ).status,
    ).toBe(401)
    const privateBytes = await f.privateFiles()
    expect(
      privateBytes.some((bytes) =>
        [f.key, ...cookies.map((value) => value.slice(11))].some((secret) =>
          bytes.includes(Buffer.from(secret)),
        ),
      ),
    ).toBe(false)
    expect(f.logs().includes(f.key)).toBe(false)
  }, 60000)

  it('completes accessible W01 storage, native owner passkey, recovery and pairing, then edits/reloads the extracted app at root and a prefix', async () => {
    for (const base of ['', '/tools']) {
      const f = await fixture({ base })
      const n = await native(f)
      const { page } = n
      await browserExpect(hook(page, 'setup-continue')).toBeEnabled()
      if (base === '') {
        await page.evaluate(() => document.fonts.ready)
        const card = await page.locator('.setup-card').boundingBox()
        expect(
          card && [Math.round(card.x), Math.round(card.width)],
        ).toEqual([280, 880])
        expect(Math.abs((card?.y ?? 0) - 68)).toBeLessThanOrEqual(6)
        expect(Math.abs((card?.height ?? 0) - 764)).toBeLessThanOrEqual(12)
        const images = await page.locator('.setup-card').evaluate((card) =>
          [...card.querySelectorAll('img')].map((image) => ({
            loaded: image.complete && image.naturalWidth > 0,
            width: image.getBoundingClientRect().width,
            height: image.getBoundingClientRect().height,
          })),
        )
        expect(
          images
            .filter((image) => image.height !== 0)
            .map((image) => [
              image.loaded,
              Math.round(image.width),
              Math.round(image.height),
            ]),
        ).toEqual(
          expect.arrayContaining([
            [true, 24, 24],
            [true, 16, 16],
            [true, 8, 8],
            [true, 32, 18],
          ]),
        )
        const icons = await page
          .locator('.setup-option-heading .sd-icon')
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              name: node.getAttribute('data-asset'),
              width: node.getBoundingClientRect().width,
              height: node.getBoundingClientRect().height,
              image:
                getComputedStyle(node).getPropertyValue('--sd-icon-image'),
            })),
          )
        expect(
          icons.every(
            (icon) =>
              icon.width === 20 &&
              icon.height === 20 &&
              icon.image.includes('/assets/'),
          ),
        ).toBe(true)
        for (const theme of ['light', 'dark']) {
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value
          }, theme)
          await audit(page, `m12-setup-${theme}`)
          if (process.env.UPDATE_INSTALL_SCREENS === '1')
            await page.screenshot({
              path: new URL(
                `../../docs/v2/screens/m12-setup-${theme}.png`,
                import.meta.url,
              ).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
              fullPage: true,
            })
        }
        await page.setViewportSize({ width: 390, height: 844 })
        await audit(page, 'm12-setup-mobile')
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true)
        if (process.env.UPDATE_INSTALL_SCREENS === '1')
          await page.screenshot({
            path: new URL(
              '../../docs/v2/screens/m12-setup-mobile.png',
              import.meta.url,
            ).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
            fullPage: true,
          })
        await page.setViewportSize({ width: 1440, height: 900 })
        await page.evaluate(() => {
          document.documentElement.dataset.theme = 'light'
        })
      }
      await unlock(page, f)
      if (base === '') await audit(page, 'm12-setup-owner')
      const installationCookie = (await n.context.cookies(f.endpoint)).find(
        (value) => value.name === 'sd_install',
      )
      expect(
        Boolean(
          installationCookie?.httpOnly &&
            installationCookie.secure &&
            installationCookie.path === base + '/',
        ),
      ).toBe(true)
      await details(page)
      await hook(page, 'setup-continue').click()
      await browserExpect(hook(page, 'setup-recovery-codes')).toBeVisible(
        installerNetwork,
      )
      const codes = (await hook(page, 'setup-recovery-codes').innerText())
        .trim()
        .split(/\s+/)
      expect(
        codes.length === 10 &&
          new Set(codes).size === 10 &&
          codes.every((code) =>
            /^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$/.test(code),
          ),
      ).toBe(true)
      if (base === '') await audit(page, 'm12-setup-recovery')
      await browserExpect(hook(page, 'setup-continue')).toBeDisabled()
      await hook(page, 'setup-recovery-saved').check()
      await hook(page, 'setup-continue').click()
      await hook(page, 'setup-back').click()
      await hook(page, 'setup-continue').click()
      await browserExpect(hook(page, 'setup-pair-create')).toBeVisible()
      expect(await hook(page, 'setup-recovery-codes').count()).toBe(0)
      if (base === '') await audit(page, 'm12-setup-extension')
      await hook(page, 'setup-pair-create').click()
      await browserExpect(hook(page, 'setup-pair-code')).toBeVisible()
      const code = await hook(page, 'setup-pair-code').innerText()
      const claimed = await fetch(f.api + 'pairing/claim', {
        method: 'POST',
        headers: {
          Origin: 'chrome-extension://' + 'a'.repeat(32),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          code,
          deviceName: 'Installer fixture',
          extensionId: 'a'.repeat(32),
        }),
      })
      expect(claimed.status).toBe(201)
      const device = (await claimed.json()) as {
        token: string
        scopes: string[]
      }
      expect(device.scopes).toEqual(['capture:write', 'guides:read'])
      await hook(page, 'setup-continue').click()
      await browserExpect(hook(page, 'library-create-empty')).toBeVisible()
      await hook(page, 'library-create-empty').click()
      await hook(page, 'guide-create-title').fill(
        'Guide from installed ZIP',
      )
      await hook(page, 'guide-create-instruction').fill(
        'Review the installation',
      )
      await hook(page, 'guide-create-submit').click()
      await browserExpect(hook(page, 'guide-edit')).toBeVisible()
      await hook(page, 'guide-edit').click()
      await browserExpect(hook(page, 'step-title')).toHaveValue(
        'Review the installation',
      )
      await page.reload()
      await browserExpect(hook(page, 'step-title')).toHaveValue(
        'Review the installation',
      )
      expect((await f.request('claim', { key: f.key })).status).toBe(409)
      const stale = await fetch(f.api + 'guides', {
        headers: {
          Authorization: 'Bearer sd_' + installationCookie?.value,
        },
      })
      expect(stale.status).toBe(401)
      const privateBytes = await f.privateFiles()
      expect(
        privateBytes.some((bytes) =>
          [f.key, installationCookie?.value ?? '', ...codes]
            .filter(Boolean)
            .some((secret) => bytes.includes(Buffer.from(secret))),
        ),
      ).toBe(false)
      expect(
        f.sql<{ n: number }[]>(
          'SELECT count(*) AS n FROM tokens WHERE expires_at IS NOT NULL AND revoked_at IS NOT NULL',
        )[0]?.n,
      ).toBe(1)
      expect(n.errors).toEqual([])
      await n.browser.close()
      browsers.splice(browsers.indexOf(n.browser), 1)
    }
  }, 240000)

  it('retains pending owner details through cancellation, reload and expired-claim recovery', async () => {
    const f = await fixture({ base: '/tools' })
    const n = await native(f)
    await unlock(n.page, f)
    await details(n.page)
    await n.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: n.authenticatorId,
      enabled: false,
    })
    await hook(n.page, 'setup-continue').click()
    await browserExpect
      .poll(
        () =>
          f.sql<{ n: number }[]>('SELECT count(*) AS n FROM members')[0]?.n,
      )
      .toBe(1)
    await hook(n.page, 'setup-cancel').click()
    await n.page.reload()
    await browserExpect(hook(n.page, 'setup-owner-email')).toBeVisible(
      installerNetwork,
    )
    await browserExpect(hook(n.page, 'setup-owner-email')).toBeDisabled()
    f.sql('UPDATE installation SET expires_at=0')
    await n.page.reload()
    await browserExpect(hook(n.page, 'setup-storage-php')).toBeChecked()
    await unlock(n.page, f)
    await n.cdp.send('WebAuthn.setAutomaticPresenceSimulation', {
      authenticatorId: n.authenticatorId,
      enabled: true,
    })
    await hook(n.page, 'setup-continue').click()
    await browserExpect(hook(n.page, 'setup-recovery-codes')).toBeVisible(
      installerNetwork,
    )
    expect(
      f.sql<{ n: number }[]>('SELECT count(*) AS n FROM members')[0]?.n,
    ).toBe(1)
    expect(n.errors).toEqual([])
  }, 90000)

  it('opens explicit browser-only storage without provisioning an owner or sending Storage API requests', async () => {
    const f = await fixture({ base: '/tools' })
    const n = await native(f)
    let apiRequests = 0
    n.page.on('request', (request) => {
      if (request.url().includes('/api/v1/')) apiRequests++
    })
    await hook(n.page, 'setup-storage-browser').check()
    await hook(n.page, 'setup-continue').click()
    await browserExpect(n.page).toHaveURL(/\/tools\/browser\/setup/)
    await accessible(n.page)
    await hook(n.page, 'setup-continue').click()
    await browserExpect(hook(n.page, 'library-create-empty')).toBeVisible()
    expect(apiRequests).toBe(0)
    expect(
      (await n.page.evaluate(() => indexedDB.databases())).length,
    ).toBeGreaterThan(0)
    expect(await exists(join(f.root, 'data/stepdoc.sqlite'))).toBe(false)
    expect(n.errors).toEqual([])
  }, 60000)

  it('fails closed for an invalid installer bootstrap without API requests or a browser workspace', async () => {
    const f = await fixture({ base: '/tools' })
    const n = await native(f)
    let apiRequests = 0
    n.page.on('request', (request) => {
      if (request.url().includes('/api/v1/')) apiRequests++
    })
    await n.page.route(f.origin + f.base + '/setup*', async (route) => {
      const response = await route.fetch()
      await route.fulfill({
        response,
        body: (await response.text()).replace(
          'content="/tools/install.php"',
          'content="https://outside.invalid/install.php"',
        ),
      })
    })
    await n.page.goto(f.origin + f.base + '/setup')
    await browserExpect(
      n.page.getByRole('heading', {
        name: 'App configuration is unavailable',
      }),
    ).toBeVisible()
    expect(apiRequests).toBe(0)
    expect(
      (await n.page.evaluate(() => indexedDB.databases())).length,
    ).toBe(0)
    expect(n.errors).toEqual([])
  }, 60000)

  it.skipIf(!apacheAvailable)(
    'runs the extracted archive on PHP 8.1 Apache with real subdirectory rewrites and first-owner registration',
    async () => {
      const f = await fixture({ base: '/tools', apache: true })
      const n = await native(f)
      const enrollment: Array<{
        action: string
        status?: number
        milliseconds: number
      }> = []
      const started = performance.now()
      n.page.on('request', (request) => {
        const action = new URL(request.url()).searchParams.get('action')
        if (action === 'owner-options' || action === 'owner-verify')
          enrollment.push({
            action,
            milliseconds: Math.round(performance.now() - started),
          })
      })
      n.page.on('response', (response) => {
        const action = new URL(response.url()).searchParams.get('action')
        if (action === 'owner-options' || action === 'owner-verify')
          enrollment.push({
            action,
            status: response.status(),
            milliseconds: Math.round(performance.now() - started),
          })
      })
      await unlock(n.page, f)
      await details(n.page)
      await hook(n.page, 'setup-continue').click()
      try {
        await browserExpect(
          hook(n.page, 'setup-recovery-codes'),
        ).toBeVisible(installerNetwork)
      } catch (error) {
        console.log('Apache enrollment boundary', {
          enrollment,
          heading: await n.page.locator('h1').textContent(),
          feedback: await hook(n.page, 'setup-feedback').textContent(),
          browser: await n.page.evaluate(() => ({
            focus: document.hasFocus(),
            visibility: document.visibilityState,
            secure: isSecureContext,
          })),
          credentialCount: (
            await n.cdp.send('WebAuthn.getCredentials', {
              authenticatorId: n.authenticatorId,
            })
          ).credentials.length,
        })
        throw error
      }
      await hook(n.page, 'setup-recovery-saved').check()
      await hook(n.page, 'setup-continue').click()
      await hook(n.page, 'setup-continue').click()
      await browserExpect(
        hook(n.page, 'library-create-empty'),
      ).toBeVisible()
      const health = await fetch(f.api + 'health')
      expect(health.status).toBe(200)
      expect(
        apiHealthSchema
          .parse(await health.json())
          .checks?.find((item) => item.id === 'backup')?.status,
      ).toBe('ok')
      for (const path of [
        '/setup-key.sha256',
        '/data/stepdoc.sqlite',
        '/vendor/autoload.php',
      ])
        expect((await fetch(f.origin + '/tools' + path)).status).toBe(404)
      expect((await f.request('claim', { key: f.key })).status).toBe(409)
      expect(n.errors).toEqual([])
    },
    120000,
  )
})

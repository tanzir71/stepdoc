import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import {
  apiSessionSchema,
  apiPairingCodeSchema,
  apiDevicesSchema,
  issuedTokenSchema,
} from '@stepdoc/schema/storage-api'
import { guideSchema } from '@stepdoc/schema'
import { authFixture, apiClient, type AuthFixture } from './auth-fixture'
import { authBrowser } from './auth-browser'

let currentFixture: AuthFixture | undefined
beforeEach(async () => {
  currentFixture = await authFixture()
}, 90000)
afterEach(async () => {
  await currentFixture?.close()
  currentFixture = undefined
})
async function withFixture(work: (fixture: AuthFixture) => Promise<void>) {
  if (!currentFixture) throw new Error('Missing authentication fixture')
  await work(currentFixture)
}
async function denied(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  const body = (await response.json()) as {
    error: { code: string; message: string }
  }
  expect(body.error.code).toBe(code)
  expect(body.error.message).toBe('Storage operation failed.')
}
async function emailLogin(fixture: AuthFixture, email: string) {
  const client = apiClient(fixture)
  const sent = await client.request('auth/code/request', 'POST', { email })
  expect(sent.status).toBe(202)
  await sent.arrayBuffer()
  const verified = await client.request('auth/code/verify', 'POST', {
    email,
    code: fixture.smtp.code(email),
  })
  expect(verified.status).toBe(200)
  const session = apiSessionSchema.parse(await verified.json())
  return { client, session, headers: verified.headers }
}
const guide = (id: string) =>
  guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id,
    title: 'Session guide',
    steps: [{ id: 'one', index: 1, type: 'manual', title: 'Continue' }],
    version: 1,
    createdAt: '2026-11-26T00:00:00.000Z',
    updatedAt: '2026-11-26T00:00:00.000Z',
  })

describe('Storage API v1 authentication and devices', () => {
  it(
    'enrolls the initial owner with a real verified resident passkey, then rotates cookie sessions on sign-in',
    async () =>
      withFixture(async (fixture) => {
        const native = await authBrowser(fixture)
        try {
          const anonymous = await native.request(
            'auth/passkey/options',
            'POST',
            { mode: 'register', email: fixture.members.owner.email },
          )
          expect(anonymous.status).toBe(401)
          const credential = await native.ceremony(
            'register',
            fixture.members.owner.email,
            fixture.owner.token,
          )
          const registered = await native.request(
            'auth/passkey/verify',
            'POST',
            credential,
            fixture.owner.token,
          )
          expect(registered.status).toBe(200)
          const session = apiSessionSchema.parse(registered.body)
          expect(session.member.id).toBe(fixture.members.owner.id)
          expect(session.member.role).toBe('owner')
          expect(new Set(session.recoveryCodes).size).toBe(10)
          expect(session.needsPasskey).toBe(false)
          const cookies = await native.context.cookies()
          const original = cookies.find(
            (cookie) => cookie.name === 'sd_session',
          )!
          expect(Boolean(original)).toBe(true)
          expect(
            original.secure &&
              original.httpOnly &&
              original.sameSite === 'Lax' &&
              original.path === '/tools/',
          ).toBe(true)
          expect((await native.request('auth/session')).status).toBe(200)
          expect(
            (await native.request('guides', 'POST', guide('owner-browser')))
              .status,
          ).toBe(201)
          expect(
            (
              await native.request(
                'auth/passkey/verify',
                'POST',
                credential,
                fixture.owner.token,
              )
            ).status,
          ).toBe(400)
          const assertion = await native.ceremony('authenticate')
          const signedIn = await native.request(
            'auth/passkey/verify',
            'POST',
            assertion,
          )
          expect(signedIn.status).toBe(200)
          expect(
            apiSessionSchema.parse(signedIn.body).recoveryCodes,
          ).toBeUndefined()
          const renewed = (await native.context.cookies()).find(
            (cookie) => cookie.name === 'sd_session',
          )!
          expect(renewed.value !== original.value).toBe(true)
          const stale = apiClient(fixture)
          stale.cookies.set('sd_session', original.value)
          await denied(await stale.request('auth/session'), 401, 'unauthorized')
          await native.cdp.send('WebAuthn.removeVirtualAuthenticator', {
            authenticatorId: native.authenticatorId,
          })
          await native.cdp.send('WebAuthn.addVirtualAuthenticator', {
            options: {
              protocol: 'ctap2',
              transport: 'internal',
              hasResidentKey: true,
              hasUserVerification: true,
              isUserVerified: true,
              automaticPresenceSimulation: true,
            },
          })
          const additional = await native.ceremony(
            'register',
            fixture.members.owner.email,
          )
          const added = await native.request(
            'auth/passkey/verify',
            'POST',
            additional,
          )
          expect(added.status).toBe(200)
          expect(
            apiSessionSchema.parse(added.body).recoveryCodes,
          ).toBeUndefined()
          expect((await native.request('auth/logout', 'POST')).status).toBe(204)
          expect((await native.request('auth/session')).status).toBe(401)
          expect(
            (await native.context.cookies()).some(
              (cookie) => cookie.name === 'sd_session',
            ),
          ).toBe(false)
        } finally {
          await native.close()
        }
      }),
    60000,
  )

  it(
    'rejects unverified, wrong-origin, stale, unknown-account and replayed native ceremonies',
    async () =>
      withFixture(async (fixture) => {
        const native = await authBrowser(fixture)
        try {
          const unverified = await native.ceremony(
            'register',
            fixture.members.owner.email,
            fixture.owner.token,
          )
          if (!('attestationObject' in unverified.response))
            throw new Error('Expected an attestation response')
          // None attestation has no attestation signature. Clear only UV in the real
          // authenticator data so the server's mandatory UV check is exercised.
          const attestation = Buffer.from(
            unverified.response.attestationObject,
            'base64url',
          )
          const rpHash = createHash('sha256').update('localhost').digest()
          const offset = attestation.indexOf(rpHash)
          expect(offset >= 0).toBe(true)
          attestation[offset + 32] = attestation[offset + 32]! & ~0x04
          unverified.response.attestationObject =
            attestation.toString('base64url')
          expect(
            (
              await native.request(
                'auth/passkey/verify',
                'POST',
                unverified,
                fixture.owner.token,
              )
            ).status,
          ).toBe(400)
          const enrollment = await native.ceremony(
            'register',
            fixture.members.owner.email,
            fixture.owner.token,
          )
          expect(
            (
              await native.request(
                'auth/passkey/verify',
                'POST',
                enrollment,
                fixture.owner.token,
              )
            ).status,
          ).toBe(200)
          const unknown = await native.ceremony(
            'authenticate',
            'absent@fixture.test',
          )
          expect(
            (await native.request('auth/passkey/verify', 'POST', unknown))
              .status,
          ).toBe(400)
          const wrong = await native.ceremony(
            'authenticate',
            fixture.members.owner.email,
          )
          const client = JSON.parse(
            Buffer.from(wrong.response.clientDataJSON, 'base64url').toString(),
          ) as { origin: string }
          client.origin = 'http://localhost:1'
          wrong.response.clientDataJSON = Buffer.from(
            JSON.stringify(client),
          ).toString('base64url')
          expect(
            (await native.request('auth/passkey/verify', 'POST', wrong)).status,
          ).toBe(400)
          const old = await native.ceremony('authenticate')
          const current = await native.ceremony('authenticate')
          expect(
            (await native.request('auth/passkey/verify', 'POST', old)).status,
          ).toBe(400)
          // A failed submission also consumes the current browser ceremony.
          expect(
            (await native.request('auth/passkey/verify', 'POST', current))
              .status,
          ).toBe(400)
          const valid = await native.ceremony('authenticate')
          expect(
            (await native.request('auth/passkey/verify', 'POST', valid)).status,
          ).toBe(200)
          expect(
            (await native.request('auth/passkey/verify', 'POST', valid)).status,
          ).toBe(400)
        } finally {
          await native.close()
        }
      }),
    60000,
  )

  it('delivers a six-digit SMTP code once, consumes it atomically, and hides unknown addresses and delivery failure', async () =>
    withFixture(async (fixture) => {
      const client = apiClient(fixture),
        email = fixture.members.owner.email
      const unknown = await client.request('auth/code/request', 'POST', {
        email: 'absent@fixture.test',
      })
      expect(unknown.status).toBe(202)
      expect(await unknown.json()).toEqual({ accepted: true })
      expect(fixture.smtp.count()).toBe(0)
      const known = await client.request('auth/code/request', 'POST', { email })
      expect(known.status).toBe(202)
      expect(await known.json()).toEqual({ accepted: true })
      expect(fixture.smtp.count()).toBe(1)
      const code = fixture.smtp.code(email)
      expect(/^[0-9]{6}$/.test(code)).toBe(true)
      const attempts = await Promise.all(
        [client, apiClient(fixture, fixture.peer.origin)].map((client) =>
          client.request('auth/code/verify', 'POST', { email, code }),
        ),
      )
      expect(attempts.map((response) => response.status).sort()).toEqual([
        200, 400,
      ])
      for (const response of attempts) await response.arrayBuffer()
      await denied(
        await client.request('auth/code/verify', 'POST', { email, code }),
        400,
        'invalid_code',
      )
      fixture.smtp.failNext()
      const failed = await client.request('auth/code/request', 'POST', {
        email: fixture.members.editor.email,
      })
      expect(failed.status).toBe(202)
      expect(await failed.json()).toEqual({ accepted: true })
      expect(fixture.smtp.count()).toBe(1)
    }))

  it('bounds code guessing and repeated requests without resetting failed-attempt state', async () =>
    withFixture(async (fixture) => {
      const client = apiClient(fixture),
        email = fixture.members.owner.email
      expect(
        (await client.request('auth/code/request', 'POST', { email })).status,
      ).toBe(202)
      const code = fixture.smtp.code(email),
        wrong = code === '000000' ? '000001' : '000000'
      for (let i = 0; i < 5; i++)
        await denied(
          await client.request('auth/code/verify', 'POST', {
            email,
            code: wrong,
          }),
          400,
          'invalid_code',
        )
      await denied(
        await client.request('auth/code/verify', 'POST', { email, code }),
        400,
        'invalid_code',
      )
      for (let i = 0; i < 2; i++)
        expect(
          (await client.request('auth/code/request', 'POST', { email })).status,
        ).toBe(202)
      await denied(
        await client.request('auth/code/request', 'POST', { email }),
        429,
        'rate_limited',
      )
      expect(fixture.smtp.count()).toBe(3)
      const foreign = await client.request(
        'auth/code/request',
        'POST',
        { email },
        { Origin: 'https://foreign.invalid' },
      )
      expect(foreign.status).toBe(403)
      await foreign.arrayBuffer()
    }))

  it(
    'signs in with each recovery code once, prompts passkey enrollment and survives a server restart',
    async () =>
      withFixture(async (fixture) => {
        const native = await authBrowser(fixture)
        try {
          const credential = await native.ceremony(
            'register',
            fixture.members.owner.email,
            fixture.owner.token,
          )
          const enrolled = await native.request(
            'auth/passkey/verify',
            'POST',
            credential,
            fixture.owner.token,
          )
          expect(enrolled.status).toBe(200)
          const codes = apiSessionSchema.parse(enrolled.body).recoveryCodes!
          const client = apiClient(fixture)
          const first = await client.request('auth/recovery', 'POST', {
            email: fixture.members.owner.email,
            code: codes[0],
          })
          expect(first.status).toBe(200)
          const session = apiSessionSchema.parse(await first.json())
          expect(session.needsPasskey).toBe(true)
          expect(session.recoveryCodes).toBeUndefined()
          await denied(
            await client.request('auth/recovery', 'POST', {
              email: fixture.members.owner.email,
              code: codes[0],
            }),
            400,
            'invalid_code',
          )
          const cookies = [...client.cookies]
          await fixture.restart()
          const restarted = apiClient(fixture)
          for (const [name, value] of cookies)
            restarted.cookies.set(name, value)
          expect((await restarted.request('auth/session')).status).toBe(200)
          await denied(
            await restarted.request('auth/recovery', 'POST', {
              email: fixture.members.owner.email,
              code: codes[0],
            }),
            400,
            'invalid_code',
          )
          const remaining = await restarted.request('auth/recovery', 'POST', {
            email: fixture.members.owner.email,
            code: codes[1],
          })
          expect(remaining.status).toBe(200)
          await remaining.arrayBuffer()
        } finally {
          await native.close()
        }
      }),
    60000,
  )

  it('applies owner/editor/viewer permissions and CSRF protection to cookie-authenticated operations', async () =>
    withFixture(async (fixture) => {
      const owner = await emailLogin(fixture, fixture.members.owner.email)
      const editor = await emailLogin(fixture, fixture.members.editor.email)
      const viewer = await emailLogin(fixture, fixture.members.viewer.email)
      expect(owner.session.member.role).toBe('owner')
      expect(editor.session.member.role).toBe('editor')
      expect(viewer.session.member.role).toBe('viewer')
      const cookieHeader = owner.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith('sd_session='))!
      expect(
        /; Secure/i.test(cookieHeader) &&
          /; HttpOnly/i.test(cookieHeader) &&
          /; SameSite=Lax/i.test(cookieHeader),
      ).toBe(true)
      const created = await editor.client.request(
        'guides',
        'POST',
        guide('editor-cookie'),
      )
      expect(created.status).toBe(201)
      await created.arrayBuffer()
      expect((await viewer.client.request('guides')).status).toBe(200)
      await denied(
        await viewer.client.request('guides', 'POST', guide('viewer-denied')),
        403,
        'forbidden',
      )
      await denied(
        await viewer.client.request('pairing/codes', 'POST'),
        403,
        'forbidden',
      )
      await denied(
        await owner.client.request('guides', 'POST', guide('csrf-denied'), {
          Origin: 'https://foreign.invalid',
        }),
        403,
        'forbidden',
      )
      await denied(
        await owner.client.request('guides', 'POST', guide('csrf-missing'), {
          Origin: '',
        }),
        403,
        'forbidden',
      )
      await denied(
        await owner.client.request('guides', 'GET', undefined, {
          Authorization: 'Bearer sd_' + 'x'.repeat(43),
        }),
        401,
        'unauthorized',
      )
      await denied(
        await owner.client.request('auth/session', 'GET', undefined, {
          Authorization: 'Bearer sd_' + 'x'.repeat(43),
        }),
        401,
        'unauthorized',
      )
      await denied(
        await owner.client.request('auth/passkey/options', 'POST', {
          mode: 'register',
          email: fixture.members.viewer.email,
        }),
        403,
        'forbidden',
      )
      await denied(
        await viewer.client.request('auth/passkey/options', 'POST', {
          mode: 'register',
          email: fixture.members.owner.email,
        }),
        403,
        'forbidden',
      )
      const copied = apiClient(fixture)
      for (const [key, value] of owner.client.cookies)
        copied.cookies.set(key, value)
      expect((await owner.client.request('auth/logout', 'POST')).status).toBe(
        204,
      )
      await denied(await copied.request('auth/session'), 401, 'unauthorized')
    }))

  it('claims one-use pairing codes atomically, binds new Chrome/Firefox origins and returns only capture/read scopes', async () =>
    withFixture(async (fixture) => {
      const owner = await emailLogin(fixture, fixture.members.owner.email)
      const issued = await owner.client.request('pairing/codes', 'POST')
      expect(issued.status).toBe(201)
      const pair = apiPairingCodeSchema.parse(await issued.json())
      expect(Date.parse(pair.expiresAt) - Date.now()).toBeLessThanOrEqual(
        300000,
      )
      const id = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        origin = `chrome-extension://${id}`
      const preflight = await fetch(fixture.server.api + 'pairing/claim', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe(origin)
      const claim = (
        api: string,
        code: string,
        extensionOrigin = origin,
        extensionId = id,
      ) =>
        fetch(api + 'pairing/claim', {
          method: 'POST',
          headers: {
            Origin: extensionOrigin,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            code,
            deviceName: 'Browser device',
            extensionId,
          }),
        })
      const results = await Promise.all(
        [fixture.server, fixture.peer].map((server) =>
          claim(server.api, pair.code),
        ),
      )
      expect(results.map((response) => response.status).sort()).toEqual([
        201, 400,
      ])
      const token = issuedTokenSchema.parse(
        await results.find((response) => response.status === 201)!.json(),
      )
      await results.find((response) => response.status === 400)!.arrayBuffer()
      expect(token.scopes).toEqual(['capture:write', 'guides:read'])
      const scoped = apiClient(fixture)
      expect(
        (
          await scoped.request('guides', 'GET', undefined, {
            Origin: origin,
            Authorization: `Bearer ${token.token}`,
          })
        ).status,
      ).toBe(200)
      await denied(
        await scoped.request('guides', 'POST', guide('paired-denied'), {
          Origin: origin,
          Authorization: `Bearer ${token.token}`,
        }),
        403,
        'forbidden',
      )
      await denied(
        await scoped.request('guides', 'GET', undefined, {
          Origin: fixture.server.origin,
          Authorization: `Bearer ${token.token}`,
        }),
        403,
        'forbidden',
      )
      const devices = apiDevicesSchema.parse(
        await (await owner.client.request('devices')).json(),
      )
      expect(
        devices.some(
          (device) => device.id === token.id && device.kind === 'extension',
        ),
      ).toBe(true)
      expect(JSON.stringify(devices).includes(token.token)).toBe(false)
      expect(
        (await owner.client.request(`devices/${token.id}`, 'DELETE')).status,
      ).toBe(204)
      await denied(
        await scoped.request('guides', 'GET', undefined, {
          Origin: origin,
          Authorization: `Bearer ${token.token}`,
        }),
        401,
        'unauthorized',
      )
      const second = apiPairingCodeSchema.parse(
        await (await owner.client.request('pairing/codes', 'POST')).json(),
      )
      const uuid = '12345678-1234-1234-1234-123456789abc'
      const firefox = await claim(
        fixture.server.api,
        second.code,
        `moz-extension://${uuid}`,
        uuid,
      )
      expect(firefox.status).toBe(201)
      await firefox.arrayBuffer()
      await denied(
        await claim(
          fixture.server.api,
          second.code,
          'https://foreign.invalid',
          uuid,
        ),
        403,
        'forbidden',
      )
      const third = apiPairingCodeSchema.parse(
        await (await owner.client.request('pairing/codes', 'POST')).json(),
      )
      await denied(
        await claim(fixture.server.api, third.code, origin, uuid),
        403,
        'forbidden',
      )
    }))

  it('manages explicit API scopes without privilege escalation or cross-workspace device access', async () =>
    withFixture(async (fixture) => {
      const owner = await emailLogin(fixture, fixture.members.owner.email)
      const editor = await emailLogin(fixture, fixture.members.editor.email)
      const viewer = await emailLogin(fixture, fixture.members.viewer.email)
      const issued = await owner.client.request('tokens', 'POST', {
        name: 'CI reader',
        scopes: ['guides:read'],
      })
      expect(issued.status).toBe(201)
      const token = issuedTokenSchema.parse(await issued.json())
      const api = apiClient(fixture)
      expect(
        (
          await api.request('guides', 'GET', undefined, {
            Authorization: `Bearer ${token.token}`,
          })
        ).status,
      ).toBe(200)
      await denied(
        await api.request('guides', 'POST', guide('api-reader-denied'), {
          Authorization: `Bearer ${token.token}`,
        }),
        403,
        'forbidden',
      )
      await denied(
        await editor.client.request('tokens', 'POST', {
          name: 'Escalate',
          scopes: ['admin'],
        }),
        403,
        'forbidden',
      )
      await denied(
        await viewer.client.request('tokens', 'POST', {
          name: 'Write',
          scopes: ['guides:write'],
        }),
        403,
        'forbidden',
      )
      await denied(
        await owner.client.request('tokens', 'POST', {
          name: 'Invalid',
          scopes: ['guides:read', 'guides:read'],
        }),
        400,
        'invalid_options',
      )
      await denied(
        await owner.client.request(`devices/${fixture.other.id}`, 'DELETE'),
        404,
        'not_found',
      )
      await denied(
        await editor.client.request(`devices/${token.id}`, 'DELETE'),
        404,
        'not_found',
      )
      const editorToken = issuedTokenSchema.parse(
        await (
          await editor.client.request('tokens', 'POST', {
            name: 'Editor own',
            scopes: ['guides:read'],
          })
        ).json(),
      )
      const visible = apiDevicesSchema.parse(
        await (await editor.client.request('devices')).json(),
      )
      expect(visible.some((device) => device.id === editorToken.id)).toBe(true)
      expect(visible.some((device) => device.id === token.id)).toBe(false)
      expect(
        (await editor.client.request(`devices/${editorToken.id}`, 'DELETE'))
          .status,
      ).toBe(204)
      expect(
        (await owner.client.request(`devices/${token.id}`, 'DELETE')).status,
      ).toBe(204)
      await denied(
        await api.request('guides', 'GET', undefined, {
          Authorization: `Bearer ${token.token}`,
        }),
        401,
        'unauthorized',
      )
    }))
})

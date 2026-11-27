import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  apiSessionSchema,
  apiPairingCodeSchema,
  issuedTokenSchema,
} from '@stepdoc/schema/storage-api'
import { guideSchema } from '@stepdoc/schema'
import { authFixture, apiClient, type AuthFixture } from './auth-fixture'
import { authBrowser } from './auth-browser'

let fixture: AuthFixture
beforeAll(async () => {
  fixture = await authFixture()
}, 90000)
afterAll(async () => {
  await fixture?.close()
})
async function login(email: string, source = fixture) {
  const client = apiClient(source)
  const sent = await client.request('auth/code/request', 'POST', { email })
  expect(sent.status).toBe(202)
  await sent.arrayBuffer()
  const signed = await client.request('auth/code/verify', 'POST', {
    email,
    code: source.smtp.code(email),
  })
  expect(signed.status).toBe(200)
  await signed.arrayBuffer()
  return client
}
describe('PHP authentication persistence and expiry', () => {
  it('stores only credential hashes and public key material, never shown-once secrets in DB, WAL or audit', async () => {
    const native = await authBrowser(fixture)
    try {
      const credential = await native.ceremony(
        'register',
        fixture.members.owner.email,
        fixture.owner.token,
      )
      const ceremony = (await native.context.cookies()).find(
        (cookie) => cookie.name === 'sd_auth',
      )!
      const response = await native.request(
        'auth/passkey/verify',
        'POST',
        credential,
        fixture.owner.token,
      )
      expect(response.status).toBe(200)
      const session = apiSessionSchema.parse(response.body)
      const rawSession = (await native.context.cookies()).find(
        (cookie) => cookie.name === 'sd_session',
      )!
      const pairResponse = await native.request('pairing/codes', 'POST')
      expect(pairResponse.status).toBe(201)
      const pair = apiPairingCodeSchema.parse(pairResponse.body)
      const secrets = [
        fixture.owner.token,
        ceremony.value,
        rawSession.value,
        pair.code,
        ...session.recoveryCodes!,
      ]
      for (const name of (await readdir(fixture.dataDir)).filter((name) =>
        name.startsWith('stepdoc.sqlite'),
      )) {
        const bytes = await readFile(join(fixture.dataDir, name))
        expect(
          secrets.some((secret) => bytes.includes(Buffer.from(secret))),
        ).toBe(false)
      }
      expect(
        JSON.stringify(fixture.inspect('SELECT * FROM audit_log')).includes(
          credential.response.clientDataJSON,
        ),
      ).toBe(false)
      const keys = fixture.inspect(
        'SELECT credential_id,public_key,sign_count FROM passkeys',
      ) as { credential_id: string; public_key: string; sign_count: number }[]
      expect(keys.length).toBe(1)
      expect(keys[0]!.public_key.startsWith('-----BEGIN PUBLIC KEY-----')).toBe(
        true,
      )
      expect(keys[0]!.public_key.includes('PRIVATE')).toBe(false)
      for (const [table, column] of [
        ['sessions', 'id_hash'],
        ['auth_challenges', 'id_hash'],
        ['auth_challenges', 'challenge_hash'],
        ['recovery_codes', 'code_hash'],
        ['pairing_codes', 'code_hash'],
        ['auth_rates', 'key_hash'],
      ]) {
        const rows = fixture.inspect(
          `SELECT ${column} AS value FROM ${table}`,
        ) as { value: string }[]
        expect(
          rows.length > 0 &&
            rows.every((row) => /^[a-f0-9]{64}$/.test(row.value)),
        ).toBe(true)
      }
      expect((await readFile(join(fixture.dataDir, 'auth.key'))).length).toBe(
        32,
      )
      expect(fixture.inspect('PRAGMA foreign_key_check')).toEqual([])
    } finally {
      await native.close()
    }
  }, 60000)

  it('rejects expired passkey challenges, email codes, sessions and pairing codes without sleeping', async () => {
    const owner = await login(fixture.members.owner.email)
    const native = await authBrowser(fixture)
    try {
      await native.context.addCookies([
        {
          name: 'sd_session',
          value: owner.cookies.get('sd_session')!,
          domain: 'localhost',
          path: '/tools/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ])
      const credential = await native.ceremony(
        'register',
        fixture.members.owner.email,
      )
      fixture.inspect('UPDATE auth_challenges SET expires_at=0')
      expect(
        (await native.request('auth/passkey/verify', 'POST', credential))
          .status,
      ).toBe(400)
    } finally {
      await native.close()
    }
    const client = apiClient(fixture),
      email = fixture.members.editor.email
    expect(
      (await client.request('auth/code/request', 'POST', { email })).status,
    ).toBe(202)
    const code = fixture.smtp.code(email)
    fixture.inspect('UPDATE login_codes SET expires_at=0')
    const expired = await client.request('auth/code/verify', 'POST', {
      email,
      code,
    })
    expect(expired.status).toBe(400)
    await expired.arrayBuffer()
    const signed = await login(fixture.members.editor.email)
    const pair = apiPairingCodeSchema.parse(
      await (await signed.request('pairing/codes', 'POST')).json(),
    )
    fixture.inspect('UPDATE pairing_codes SET expires_at=0')
    const claim = await signed.request(
      'pairing/claim',
      'POST',
      {
        code: pair.code,
        deviceName: 'Expired',
        extensionId: 'cccccccccccccccccccccccccccccccc',
      },
      { Origin: 'chrome-extension://cccccccccccccccccccccccccccccccc' },
    )
    expect(claim.status).toBe(400)
    await claim.arrayBuffer()
    fixture.inspect('UPDATE sessions SET expires_at=0')
    const session = await signed.request('auth/session')
    expect(session.status).toBe(401)
    await session.arrayBuffer()
  }, 60000)

  it('invalidates old sessions on role change and limits existing member tokens to current permissions', async () => {
    const client = await login(fixture.members.viewer.email)
    const initial = await client.request('guides')
    expect(initial.status).toBe(200)
    await initial.arrayBuffer()
    // Administrative mutation models the later member-management endpoint; authorization is real.
    fixture.inspect(
      `UPDATE members SET role='editor' WHERE id='${fixture.members.viewer.id}'`,
    )
    const stale = await client.request('auth/session')
    expect(stale.status).toBe(401)
    await stale.arrayBuffer()
    fixture.inspect(
      `UPDATE members SET role='viewer' WHERE id='${fixture.members.viewer.id}'`,
    )
    const restored = await client.request('auth/session')
    expect(restored.status).toBe(401)
    await restored.arrayBuffer()
    fixture.inspect(
      `UPDATE members SET role='editor' WHERE id='${fixture.members.viewer.id}'`,
    )
    const editor = await login(fixture.members.viewer.email)
    const token = issuedTokenSchema.parse(
      await (
        await editor.request('tokens', 'POST', {
          name: 'Role-bound writer',
          scopes: ['guides:read', 'guides:write'],
        })
      ).json(),
    )
    fixture.inspect(
      `UPDATE members SET role='viewer' WHERE id='${fixture.members.viewer.id}'`,
    )
    const api = apiClient(fixture)
    const headers = { Authorization: `Bearer ${token.token}` }
    const read = await api.request('guides', 'GET', undefined, headers)
    expect(read.status).toBe(200)
    await read.arrayBuffer()
    const guide = guideSchema.parse({
      schema: 'stepdoc/guide@1',
      id: 'demoted-writer',
      title: 'Denied',
      steps: [{ id: 'one', index: 1, type: 'manual', title: 'Continue' }],
      version: 1,
      createdAt: '2026-11-26T00:00:00.000Z',
      updatedAt: '2026-11-26T00:00:00.000Z',
    })
    const write = await api.request('guides', 'POST', guide, headers)
    expect(write.status).toBe(403)
    await write.arrayBuffer()
    fixture.inspect(
      `DELETE FROM members WHERE id='${fixture.members.viewer.id}'`,
    )
    const removed = await api.request('guides', 'GET', undefined, headers)
    expect(removed.status).toBe(401)
    await removed.arrayBuffer()
    expect(fixture.inspect('PRAGMA foreign_key_check')).toEqual([])
  })

  it('keeps nested API tokens and paired devices linked to their member, and rechecks the pairing issuer', async () => {
    const isolated = await authFixture()
    try {
      const owner = await login(isolated.members.owner.email, isolated)
      const api = apiClient(isolated)
      const request = (
        token: string,
        path: string,
        method = 'GET',
        body?: unknown,
      ) => api.request(path, method, body, { Authorization: `Bearer ${token}` })
      const parent = issuedTokenSchema.parse(
        await (
          await owner.request('tokens', 'POST', {
            name: 'Owner admin',
            scopes: ['admin'],
          })
        ).json(),
      )
      const child = issuedTokenSchema.parse(
        await (
          await request(parent.token, 'tokens', 'POST', {
            name: 'Nested admin',
            scopes: ['admin'],
          })
        ).json(),
      )
      const grandchild = issuedTokenSchema.parse(
        await (
          await request(child.token, 'tokens', 'POST', {
            name: 'Nested writer',
            scopes: ['guides:read', 'guides:write'],
          })
        ).json(),
      )
      const code = async () =>
        apiPairingCodeSchema.parse(
          await (await request(child.token, 'pairing/codes', 'POST')).json(),
        ).code
      const active = await code(),
        demoted = await code(),
        revoked = await code()
      const extensionId = 'c'.repeat(32),
        origin = `chrome-extension://${extensionId}`
      const claim = (pair: string) =>
        api.request(
          'pairing/claim',
          'POST',
          { code: pair, deviceName: 'Inherited device', extensionId },
          { Origin: origin },
        )
      const device = issuedTokenSchema.parse(await (await claim(active)).json())
      expect(
        isolated.inspect(
          'SELECT DISTINCT created_by FROM tokens WHERE created_by IS NOT NULL',
        ),
      ).toEqual([{ created_by: isolated.members.owner.id }])
      expect(
        isolated.inspect(
          'SELECT COUNT(*) AS count FROM tokens WHERE created_by IS NOT NULL',
        ),
      ).toEqual([{ count: 4 }])
      isolated.inspect(
        `UPDATE members SET role='viewer' WHERE id='${isolated.members.owner.id}'`,
      )
      const pending = await claim(demoted)
      expect(pending.status).toBe(400)
      await pending.arrayBuffer()
      const escalation = await request(child.token, 'tokens', 'POST', {
        name: 'Denied',
        scopes: ['admin'],
      })
      expect(escalation.status).toBe(403)
      await escalation.arrayBuffer()
      const write = await request(grandchild.token, 'guides', 'POST', {})
      expect(write.status).toBe(403)
      await write.arrayBuffer()
      const read = await request(grandchild.token, 'guides')
      expect(read.status).toBe(200)
      await read.arrayBuffer()
      isolated.inspect(
        `UPDATE members SET role='owner' WHERE id='${isolated.members.owner.id}'`,
      )
      const revoke = await request(
        isolated.owner.token,
        `devices/${child.id}`,
        'DELETE',
      )
      expect(revoke.status).toBe(204)
      await revoke.arrayBuffer()
      const pendingRevoked = await claim(revoked)
      expect(pendingRevoked.status).toBe(400)
      await pendingRevoked.arrayBuffer()
      isolated.inspect(
        `DELETE FROM members WHERE id='${isolated.members.owner.id}'`,
      )
      for (const token of [parent, child, grandchild, device]) {
        // Native extension GET omits Origin; deletion also removes its CORS registration.
        const removed = await fetch(isolated.server.api + 'guides', {
          headers: { Authorization: `Bearer ${token.token}` },
          signal: AbortSignal.timeout(15000),
        })
        expect(removed.status).toBe(401)
        await removed.arrayBuffer()
      }
      expect(isolated.inspect('PRAGMA foreign_key_check')).toEqual([])
    } finally {
      await isolated.close()
    }
  }, 60000)

  it('rejects a genuine assertion after a cloned virtual authenticator rolls its signature counter back', async () => {
    const owner = await login(fixture.members.owner.email)
    const native = await authBrowser(fixture)
    try {
      await native.context.addCookies([
        {
          name: 'sd_session',
          value: owner.cookies.get('sd_session')!,
          domain: 'localhost',
          path: '/tools/',
          secure: true,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ])
      const enrollment = await native.ceremony(
        'register',
        fixture.members.owner.email,
      )
      expect(
        (await native.request('auth/passkey/verify', 'POST', enrollment))
          .status,
      ).toBe(200)
      const first = await native.ceremony('authenticate')
      expect(
        (await native.request('auth/passkey/verify', 'POST', first)).status,
      ).toBe(200)
      const previous = fixture.inspect(
        `SELECT sign_count FROM passkeys WHERE credential_id='${enrollment.id}'`,
      ) as { sign_count: number }[]
      expect(previous[0]!.sign_count > 1).toBe(true)
      const exported = await native.cdp.send('WebAuthn.getCredentials', {
        authenticatorId: native.authenticatorId,
      })
      const key = exported.credentials[0]!
      await native.cdp.send('WebAuthn.removeVirtualAuthenticator', {
        authenticatorId: native.authenticatorId,
      })
      const clone = await native.cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })
      // Generated test key material stays in memory at the CDP boundary and is never logged.
      await native.cdp.send('WebAuthn.addCredential', {
        authenticatorId: clone.authenticatorId,
        credential: { ...key, signCount: 0 },
      })
      const assertion = await native.ceremony('authenticate')
      expect(
        (await native.request('auth/passkey/verify', 'POST', assertion)).status,
      ).toBe(400)
      expect(
        fixture.inspect(
          `SELECT sign_count FROM passkeys WHERE credential_id='${enrollment.id}'`,
        ),
      ).toEqual(previous)
    } finally {
      await native.close()
    }
  }, 60000)
})

import { describe, expect, it, vi } from 'vitest'
import { DevicesHttpClient } from '../src/http'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
describe('device HTTP client on existing Storage API', () => {
  it('uses exact installation-relative routes, session cookies and mutation statuses without copying credentials into bodies', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (url, init = {}) => {
      const path = new URL(String(url)).pathname
      calls.push({ path, init })
      if (path.endsWith('/devices'))
        return json([
          {
            id: 'one',
            kind: 'extension',
            name: 'Browser',
            scopes: ['guides:read'],
            lastSeenAt: null,
            token: 'MUST_NOT_PROJECT',
          },
        ])
      if (path.endsWith('/pairing/codes'))
        return json(
          { code: 'ABC-DEF', expiresAt: '2026-11-28T00:00:00.000Z' },
          201,
        )
      if (path.endsWith('/tokens'))
        return json(
          { id: 'two', token: 'sd_mock_once', scopes: ['guides:read'] },
          201,
        )
      return new Response(null, { status: 204 })
    })
    const client = new DevicesHttpClient('https://server.test/tools/api/v1/', {
      fetch,
      auth: { kind: 'session' },
    })
    expect(await client.list()).toEqual([
      {
        id: 'one',
        kind: 'extension',
        name: 'Browser',
        scopes: ['guides:read'],
        lastSeenAt: null,
      },
    ])
    expect((await client.pairingCode()).code).toBe('ABC-DEF')
    expect(
      (
        await client.create({
          name: '  Read client  ',
          scopes: ['guides:read'],
        })
      ).token,
    ).toBe('sd_mock_once')
    await client.revoke('two')
    expect(calls.map((call) => [call.path, call.init.method])).toEqual([
      ['/tools/api/v1/devices', 'GET'],
      ['/tools/api/v1/pairing/codes', 'POST'],
      ['/tools/api/v1/tokens', 'POST'],
      ['/tools/api/v1/devices/two', 'DELETE'],
    ])
    expect(calls[2]!.init.body).toBe(
      '{"name":"Read client","scopes":["guides:read"]}',
    )
    for (const { init } of calls) {
      expect(init.credentials).toBe('include')
      expect(init.redirect).toBe('error')
      expect(init.cache).toBe('no-store')
      expect(init.referrerPolicy).toBe('no-referrer')
      expect(new Headers(init.headers).has('Authorization')).toBe(false)
    }
    client.close()
    await expect(client.list()).rejects.toMatchObject({ code: 'closed' })
  })
  it.each([
    { name: '', scopes: ['guides:read'] },
    { name: 'x', scopes: [] },
    { name: 'x', scopes: ['guides:read', 'guides:read'] },
    { name: '😀'.repeat(31), scopes: ['guides:read'] },
  ])('rejects invalid token input before egress: %j', async (input) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = new DevicesHttpClient('https://server.test', { fetch })
    await expect(
      client.create(input as Parameters<typeof client.create>[0]),
    ).rejects.toMatchObject({ code: 'invalid_options' })
    expect(fetch).not.toHaveBeenCalled()
    client.close()
  })
  it('rejects forged privilege escalation and unsafe revoke paths', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ id: 'one', token: 'sd_mock_once', scopes: ['admin'] }, 201),
    )
    const client = new DevicesHttpClient('https://server.test', { fetch })
    await expect(
      client.create({ name: 'Reader', scopes: ['guides:read'] }),
    ).rejects.toMatchObject({ code: 'corrupt_data' })
    for (const id of ['..', 'one/two', '%2f', ''])
      expect(() => client.revoke(id)).toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)
    client.close()
  })
  it('performs one attempt on permission/rate/server failures with fixed errors', async () => {
    for (const [status, code] of [
      [403, 'forbidden'],
      [429, 'rate_limited'],
      [503, 'storage_unavailable'],
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        json({ credential: 'PRIVATE_ERROR' }, status),
      )
      const client = new DevicesHttpClient('https://server.test', { fetch })
      await expect(client.list()).rejects.toMatchObject({ code })
      expect(fetch).toHaveBeenCalledTimes(1)
      client.close()
    }
  })
})

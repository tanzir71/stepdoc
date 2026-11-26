import { describe, it, expect, vi } from 'vitest'
import { guideSchema } from '@stepdoc/schema'
import { type PairingClaim } from '@stepdoc/schema/storage-api'
import {
  HttpAdapter,
  claimPairing,
  storageApiUrl,
  type HttpOptions,
} from '../src/http'
import { StorageError } from '../src/adapter'
import { summary } from '../src/guides'
import source from '../../schema/tests/fixtures/complete.json'

const guide = () => guideSchema.parse(structuredClone(source))
const health = {
  target: 'php-sqlite',
  version: '2.0.0',
  schema: 'stepdoc/guide@1',
  capabilities: { maxUploadBytes: 64 * 1024 * 1024 },
}
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
type Call = { url: URL; init: RequestInit; headers: Headers }
type Handler = (call: Call) => Response | Promise<Response>
function fixture(
  handler: Handler = () => json(guide()),
  customHealth: unknown = health,
) {
  const calls: Call[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
    const call = {
      url: new URL(String(input)),
      init,
      headers: new Headers(init.headers),
    }
    calls.push(call)
    return call.url.pathname.endsWith('/health')
      ? json(customHealth)
      : handler(call)
  })
  const open = (options: HttpOptions = {}) =>
    HttpAdapter.open('https://host.example/subdirectory', {
      ...options,
      fetch: fetcher,
    })
  return { calls, fetcher, open }
}
const claim: PairingClaim = {
  code: 'K7Q-4MX',
  deviceName: 'Work browser',
  extensionId: 'abcdefghijklmnopabcdefghijklmnop',
}
const issued = {
  id: 'device-one',
  token: 'sd_test_private_credential',
  scopes: ['capture:write', 'guides:read'],
}

describe('HTTP request and credential boundaries', () => {
  it.each([
    ['https://host.example', 'https://host.example/api/v1/'],
    ['https://host.example/stepdoc/', 'https://host.example/stepdoc/api/v1/'],
    [
      'https://host.example/stepdoc/api/v1',
      'https://host.example/stepdoc/api/v1/',
    ],
    ['http://127.0.0.1:4321', 'http://127.0.0.1:4321/api/v1/'],
    ['http://[::1]:4321/path', 'http://[::1]:4321/path/api/v1/'],
  ])('normalizes the selected server root %s', (input, expected) =>
    expect(storageApiUrl(input)).toBe(expected),
  )
  it.each([
    'http://remote.example',
    'https://user:PRIVATE@host.example',
    'https://host.example?token=PRIVATE',
    'https://host.example#PRIVATE',
    'file:///local',
    'data:text/plain,PRIVATE',
    'not a URL',
  ])('rejects unsafe configuration without reflecting it: %s', (input) => {
    try {
      storageApiUrl(input)
      throw new Error('Expected rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError)
      expect(String(error)).not.toContain('PRIVATE')
    }
  })
  it('probes health anonymously and obtains fresh bearer credentials only for authenticated requests', async () => {
    let credential = 'sd_test_first'
    const token = vi.fn(() => credential),
      f = fixture()
    const adapter = await f.open({ auth: { kind: 'bearer', token } })
    expect(token).not.toHaveBeenCalled()
    await adapter.getGuide(guide().id)
    credential = 'sd_test_rotated'
    await adapter.getGuide(guide().id)
    expect(f.calls.map((call) => call.headers.get('authorization'))).toEqual([
      null,
      'Bearer sd_test_first',
      'Bearer sd_test_rotated',
    ])
    for (const call of f.calls) {
      expect(call.init.credentials).toBe('omit')
      expect(call.init.redirect).toBe('error')
      expect(call.init.cache).toBe('no-store')
      expect(call.init.referrerPolicy).toBe('no-referrer')
      expect(call.init.mode).toBe('cors')
    }
    expect(JSON.stringify(adapter)).not.toContain('sd_test')
    expect(JSON.stringify(adapter)).not.toContain('host.example')
    expect(Object.isFrozen(adapter.capabilities)).toBe(true)
    adapter.close()
  })
  it('uses cookies only for session requests and never for the public handshake', async () => {
    const f = fixture(),
      adapter = await f.open()
    await adapter.getGuide(guide().id)
    expect(f.calls.map((call) => call.init.credentials)).toEqual([
      'omit',
      'include',
    ])
    expect(f.calls.every((call) => !call.headers.has('authorization'))).toBe(
      true,
    )
    adapter.close()
  })
  it('does not obtain credentials for an incompatible host', async () => {
    const token = vi.fn(() => 'PRIVATE_CREDENTIAL'),
      f = fixture(undefined, { ...health, schema: 'wrong' })
    await expect(
      f.open({ auth: { kind: 'bearer', token } }),
    ).rejects.toMatchObject({ code: 'corrupt_data' })
    expect(token).not.toHaveBeenCalled()
  })
  it.each([
    null,
    [],
    { timeoutMs: 0 },
    { timeoutMs: Infinity },
    { maxJsonBytes: 0 },
    { fetch: null },
    { auth: null },
    { auth: { kind: 'bearer', token: 'PRIVATE' } },
  ])('rejects invalid transport settings %j', async (options) => {
    await expect(
      HttpAdapter.open(
        'https://host.example',
        options as unknown as HttpOptions,
      ),
    ).rejects.toMatchObject({ code: 'invalid_options' })
  })
  it('sanitizes thrown and malformed credential-provider results without sending a request', async () => {
    for (const token of [
      () => {
        throw new Error('PRIVATE_PROVIDER_DETAIL')
      },
      () => 'bad\r\nPRIVATE_HEADER',
    ]) {
      const f = fixture(),
        adapter = await f.open({ auth: { kind: 'bearer', token } })
      const error = await adapter.getGuide(guide().id).catch((error) => error)
      expect(error).toMatchObject({ code: 'unauthorized' })
      expect(String(error)).not.toContain('PRIVATE')
      expect(f.calls).toHaveLength(1)
      adapter.close()
    }
  })
})

describe('Storage API guide and history operations', () => {
  it('sends only supported encoded query parameters and validates summaries', async () => {
    const f = fixture(() =>
        json({
          items: [{ ...summary(guide()), unexpectedToken: 'PRIVATE' }],
          nextCursor: 'opaque?next',
        }),
      ),
      adapter = await f.open()
    const query = {
      q: 'plan & owner@example.test',
      status: 'needs-review' as const,
      collection: null,
      cursor: 'opaque+/=',
    }
    Object.defineProperty(query, 'typedValue', {
      get() {
        throw new Error('PRIVATE')
      },
    })
    const page = await adapter.listGuides(query)
    expect([...f.calls[1]!.url.searchParams]).toEqual([
      ['q', query.q],
      ['status', 'needs-review'],
      ['collection', ''],
      ['cursor', 'opaque+/='],
    ])
    expect(Object.keys(page.items[0]!)).not.toContain('unexpectedToken')
    expect(page.nextCursor).toBe('opaque?next')
    adapter.close()
  })
  it('snapshots a query across async transport and rejects repeated cursors', async () => {
    let finish: (response: Response) => void = () => {}
    const f = fixture(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      ),
      adapter = await f.open()
    const query = { cursor: 'same' },
      pending = adapter.listGuides(query)
    query.cursor = 'mutated'
    finish(json({ items: [], nextCursor: 'same' }))
    await expect(pending).rejects.toMatchObject({ code: 'corrupt_data' })
    adapter.close()
  })
  it('creates a detached version-one document and saves with an exact If-Match', async () => {
    const f = fixture(({ init, headers }) => {
        const doc = JSON.parse(String(init.body))
        return json(
          {
            ...doc,
            version:
              init.method === 'POST' ? 1 : Number(headers.get('if-match')) + 1,
          },
          init.method === 'POST' ? 201 : 200,
        )
      }),
      adapter = await f.open()
    const input = { ...guide(), version: 23 },
      created = await adapter.createGuide(input)
    expect(input.version).toBe(23)
    expect(created.version).toBe(1)
    created.title = 'Edited'
    const saved = await adapter.saveGuide(created, 1)
    expect(saved.version).toBe(2)
    expect(created.version).toBe(1)
    expect(f.calls[2]!.headers.get('if-match')).toBe('1')
    expect(f.calls[2]!.headers.get('content-type')).toBe('application/json')
    expect(saved.title).toBe('Edited')
    adapter.close()
  })
  it('rejects invalid/private guide data and mismatched versions before HTTP', async () => {
    const f = fixture(),
      adapter = await f.open()
    const input = guide()
    Object.defineProperty(input, 'typedValue', {
      enumerable: true,
      get() {
        throw new Error('PRIVATE_TYPED')
      },
    })
    await expect(adapter.createGuide(input)).rejects.toMatchObject({
      code: 'invalid_guide',
    })
    await expect(
      adapter.saveGuide(guide(), guide().version + 1),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(adapter.getGuide('../escape')).rejects.toMatchObject({
      code: 'invalid_guide',
    })
    await expect(
      adapter.listGuides({ q: 'a'.repeat(1001) }),
    ).rejects.toMatchObject({ code: 'invalid_query' })
    expect(f.calls).toHaveLength(1)
    adapter.close()
  })
  it('loads unlimited history, a requested version and DELETE 204', async () => {
    const doc = guide(),
      versions = Array.from({ length: 1100 }, (_, i) => ({
        version: i + 1,
        at: doc.updatedAt,
        by: 'Editor',
        summary: 'Saved',
      }))
    const f = fixture(({ url, init }) =>
        init.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : url.pathname.endsWith('/versions')
            ? json(versions)
            : json({ ...doc, version: 42 }),
      ),
      adapter = await f.open()
    expect(await adapter.listVersions(doc.id)).toHaveLength(1100)
    expect((await adapter.getVersion(doc.id, 42)).version).toBe(42)
    await adapter.deleteGuide(doc.id)
    expect(f.calls.at(-1)!.init.method).toBe('DELETE')
    adapter.close()
  })
  it.each([
    'wrong-id',
    'wrong-version',
    'wrong-uuid',
    'duplicate-history',
    'duplicate-summary',
  ])('rejects response identity/integrity failures: %s', async (failure) => {
    const doc = guide(),
      f = fixture(() => {
        if (failure === 'duplicate-history') {
          const row = {
            version: 1,
            at: doc.updatedAt,
            by: 'Editor',
            summary: '',
          }
          return json([row, row])
        }
        if (failure === 'duplicate-summary')
          return json({ items: [summary(doc), summary(doc)], nextCursor: null })
        return json(
          {
            ...doc,
            id: failure === 'wrong-id' ? 'other-guide' : doc.id,
            version: failure === 'wrong-version' ? 99 : doc.version,
            uuid:
              failure === 'wrong-uuid'
                ? '6aaa6aaa-6aaa-46aa-86aa-6aaa6aaa6aaa'
                : doc.uuid,
          },
          failure === 'wrong-uuid' ? 201 : 200,
        )
      }),
      adapter = await f.open()
    const pending =
      failure === 'duplicate-history'
        ? adapter.listVersions(doc.id)
        : failure === 'duplicate-summary'
          ? adapter.listGuides()
          : failure === 'wrong-version'
            ? adapter.getVersion(doc.id, 1)
            : failure === 'wrong-uuid'
              ? adapter.createGuide(doc)
              : adapter.getGuide(doc.id)
    await expect(pending).rejects.toMatchObject({ code: 'corrupt_data' })
    adapter.close()
  })
  it('enforces read-only configuration before writes but permits reads', async () => {
    const f = fixture(),
      adapter = await f.open({ readOnly: true })
    await adapter.getGuide(guide().id)
    await expect(adapter.createGuide(guide())).rejects.toMatchObject({
      code: 'unsupported',
    })
    await expect(adapter.deleteGuide(guide().id)).rejects.toMatchObject({
      code: 'unsupported',
    })
    expect(f.calls).toHaveLength(2)
    adapter.close()
    await expect(adapter.createGuide(guide())).rejects.toMatchObject({
      code: 'closed',
    })
  })
})

describe('bounded raster transport', () => {
  it('treats an unusable returned blob key as corrupt server data', async () => {
    const f = fixture(() => json({ key: '..' }, 201)),
      adapter = await f.open()
    await expect(
      adapter.putBlob(guide().id, {
        file: new Blob([png], { type: 'image/png' }),
        stepId: 'one',
        kind: 'rendered',
      }),
    ).rejects.toMatchObject({ code: 'corrupt_data' })
    adapter.close()
  })
  it('uploads exact multipart fields with a neutral filename and no hand-built boundary', async () => {
    const f = fixture(() =>
        json({ key: 'blobs/new.png', extra: 'PRIVATE' }, 201),
      ),
      adapter = await f.open()
    const upload = {
      file: new File([png], 'PRIVATE_CUSTOMER.png', { type: 'image/png' }),
      stepId: 'step/one',
      kind: 'rendered' as const,
    }
    Object.defineProperty(upload, 'value', {
      get() {
        throw new Error('PRIVATE_TYPED')
      },
    })
    expect(await adapter.putBlob(guide().id, upload)).toEqual({
      key: 'blobs/new.png',
    })
    const call = f.calls[1]!,
      body = call.init.body as FormData
    expect(call.headers.has('content-type')).toBe(false)
    expect([...body.keys()]).toEqual(['file', 'stepId', 'kind'])
    expect((body.get('file') as File).name).toBe('image.png')
    expect(body.get('stepId')).toBe('step/one')
    expect(body.get('kind')).toBe('rendered')
    adapter.close()
  })
  it('rejects non-raster content and respects advertised upload limits', async () => {
    const f = fixture(undefined, {
        ...health,
        capabilities: { maxUploadBytes: 4 },
      }),
      adapter = await f.open()
    await expect(
      adapter.putBlob(guide().id, {
        file: new Blob([png], { type: 'image/png' }),
        stepId: 'one',
        kind: 'original',
      }),
    ).rejects.toMatchObject({ code: 'upload_too_large' })
    await expect(
      adapter.putBlob(guide().id, {
        file: new Blob(['x'], { type: 'image/svg+xml' }),
        stepId: 'one',
        kind: 'original',
      }),
    ).rejects.toMatchObject({ code: 'invalid_blob' })
    expect(f.calls).toHaveLength(1)
    adapter.close()
  })
  it('treats keys as opaque path components and reads rasters independently of upload capacity', async () => {
    const f = fixture(
        () => new Response(png, { headers: { 'content-type': 'image/png' } }),
        { ...health, capabilities: { maxUploadBytes: 0 } },
      ),
      adapter = await f.open()
    const key = 'blobs/path/../opaque?query#fragment'
    const blob = await adapter.getBlob(key)
    expect(blob.type).toBe('image/png')
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(png)
    expect(f.calls[1]!.url.pathname).toBe(
      '/subdirectory/api/v1/blobs/' + encodeURIComponent(key),
    )
    expect(f.calls[1]!.url.search).toBe('')
    expect(f.calls[1]!.headers.get('accept')).toBe('image/png, image/webp')
    for (const bad of ['.', '..', '\u0000'])
      await expect(adapter.getBlob(bad)).rejects.toMatchObject({
        code: 'invalid_blob',
      })
    adapter.close()
  })
  it.each(['mime', 'signature', 'size'])(
    'rejects invalid download %s',
    async (failure) => {
      const f = fixture(
          () =>
            new Response(failure === 'signature' ? new Uint8Array([1]) : png, {
              headers: {
                'content-type':
                  failure === 'mime' ? 'image/svg+xml' : 'image/png',
                ...(failure === 'size'
                  ? { 'content-length': String(65 * 1024 * 1024) }
                  : {}),
              },
            }),
        ),
        adapter = await f.open()
      await expect(adapter.getBlob('key')).rejects.toMatchObject({
        code: 'corrupt_data',
      })
      adapter.close()
    },
  )
})

describe('sanitized failures, bounds and lifecycle', () => {
  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [413, 'upload_too_large'],
    [423, 'redaction_open'],
    [429, 'rate_limited'],
    [503, 'storage_unavailable'],
  ])('maps status %s without exposing a server body', async (status, code) => {
    const f = fixture(
        () =>
          new Response('PRIVATE_SERVER_CREDENTIAL', { status: Number(status) }),
      ),
      adapter = await f.open()
    const error = await adapter.getGuide(guide().id).catch((error) => error)
    expect(error).toMatchObject({ code })
    expect(String(error)).not.toContain('PRIVATE')
    expect(error.cause).toBeUndefined()
    adapter.close()
  })
  it.each(['html', 'json', 'utf8', 'declared', 'stream', 'status', 'redirect'])(
    'fails closed on invalid response %s',
    async (failure) => {
      const f = fixture(() => {
          if (failure === 'html')
            return new Response('<html>PRIVATE', {
              headers: { 'content-type': 'text/html' },
            })
          if (failure === 'json')
            return new Response('{PRIVATE', {
              headers: { 'content-type': 'application/json' },
            })
          if (failure === 'utf8')
            return new Response(new Uint8Array([255]), {
              headers: { 'content-type': 'application/json' },
            })
          if (failure === 'declared')
            return new Response('{}', {
              headers: {
                'content-type': 'application/json',
                'content-length': '10000',
              },
            })
          if (failure === 'stream')
            return new Response('{"padding":"' + 'x'.repeat(800) + '"}', {
              headers: {
                'content-type': 'application/json',
                'content-length': '2',
              },
            })
          if (failure === 'redirect') {
            const response = json(guide())
            Object.defineProperty(response, 'redirected', { value: true })
            return response
          }
          return json(guide(), 202)
        }),
        adapter = await f.open({ maxJsonBytes: 512 })
      await expect(adapter.getGuide(guide().id)).rejects.toMatchObject({
        code: 'corrupt_data',
      })
      adapter.close()
    },
  )
  it('sanitizes network exceptions and never automatically retries a write', async () => {
    const f = fixture(() => {
        throw new Error('PRIVATE_NATIVE_URL_OR_TOKEN')
      }),
      adapter = await f.open()
    const error = await adapter.createGuide(guide()).catch((error) => error)
    expect(error).toMatchObject({ code: 'storage_unavailable' })
    expect(String(error)).not.toContain('PRIVATE')
    expect(f.calls).toHaveLength(2)
    adapter.close()
  })
  it('bounds even a non-cooperative fetch and can close during credential lookup', async () => {
    const f = fixture(() => new Promise(() => {})),
      adapter = await f.open({ timeoutMs: 20 })
    await expect(adapter.getGuide(guide().id)).rejects.toMatchObject({
      code: 'storage_unavailable',
    })
    adapter.close()
    const second = fixture(),
      waiting = await second.open({
        auth: { kind: 'bearer', token: () => new Promise(() => {}) },
      })
    const rejected = expect(waiting.getGuide(guide().id)).rejects.toMatchObject(
      { code: 'closed' },
    )
    waiting.close()
    await rejected
    expect(second.calls).toHaveLength(1)
  })
})

describe('pairing-code exchange', () => {
  it('accepts an external cancellation signal without forwarding a code after abort', async () => {
    const f = fixture(() => new Promise(() => {})),
      controller = new AbortController()
    const pending = claimPairing('https://host.example', claim, {
      fetch: f.fetcher,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'storage_unavailable' })
    expect(f.calls.length).toBeLessThanOrEqual(1)
    expect(f.calls.every((call) => call.url.pathname.endsWith('/health'))).toBe(
      true,
    )
  })
  it('validates health and exchanges only the explicit anonymous fields', async () => {
    const f = fixture(() =>
      json({ ...issued, privateMetadata: 'not returned' }, 201),
    )
    const result = await claimPairing(
      'https://host.example/subdirectory',
      claim,
      { fetch: f.fetcher },
    )
    expect(result).toEqual(issued)
    expect(JSON.parse(String(f.calls[1]!.init.body))).toEqual(claim)
    expect(f.calls[1]!.url.pathname).toBe('/subdirectory/api/v1/pairing/claim')
    expect(
      f.calls.every(
        (call) =>
          call.init.credentials === 'omit' &&
          !call.headers.has('authorization'),
      ),
    ).toBe(true)
  })
  it.each([
    'bad-code',
    'extra-input',
    'bad-token',
    'missing-scope',
    'wide-scope',
    'duplicate-scope',
    'expired',
  ])('rejects unsafe/expired pairing %s', async (failure) => {
    const f = fixture(() =>
      failure === 'expired'
        ? json({ error: { code: 'expired', message: 'PRIVATE' } }, 400)
        : json(
            {
              ...issued,
              ...(failure === 'bad-token' ? { token: 'bad\r\nPRIVATE' } : {}),
              ...(failure === 'missing-scope'
                ? { scopes: ['guides:read'] }
                : failure === 'wide-scope'
                  ? { scopes: [...issued.scopes, 'admin'] }
                  : failure === 'duplicate-scope'
                    ? { scopes: ['capture:write', 'capture:write'] }
                    : {}),
            },
            201,
          ),
    )
    const input =
      failure === 'bad-code'
        ? { ...claim, code: 'bad' }
        : failure === 'extra-input'
          ? { ...claim, value: 'PRIVATE_TYPED' }
          : claim
    const error = await claimPairing('https://host.example', input, {
      fetch: f.fetcher,
    }).catch((error) => error)
    expect(error).toMatchObject({
      code: ['bad-code', 'extra-input', 'expired'].includes(failure)
        ? 'invalid_pairing'
        : 'corrupt_data',
    })
    expect(String(error)).not.toContain('PRIVATE')
    if (failure === 'bad-code' || failure === 'extra-input')
      expect(f.calls).toHaveLength(0)
  })
})

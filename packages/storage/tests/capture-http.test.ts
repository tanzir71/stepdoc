import { describe, expect, it, vi } from 'vitest'
import { guideSchema, type Guide } from '@stepdoc/schema'
import {
  CaptureHttpClient,
  captureImageBlob,
  MAX_CAPTURE_INLINE_BYTES,
  type CaptureHttpOptions,
} from '../src/http'
import source from '../../schema/tests/fixtures/minimal.json'

const png = 'data:image/png;base64,iVBORw0KGgoAAAAA'
const input = () =>
  guideSchema.parse({
    ...source,
    id: 'capture-native-session',
    uuid: '123e4567-e89b-42d3-a456-426614174001',
    steps: [
      {
        ...source.steps[0],
        screenshot: { original: png, rendered: png, width: 1, height: 1 },
      },
    ],
  })
const stored = (doc = input()) =>
  guideSchema.parse({
    ...doc,
    steps: doc.steps.map((step) => ({
      ...step,
      screenshot: {
        ...step.screenshot,
        original: 'native/original.png',
        rendered: 'native/rendered.webp',
      },
    })),
  })
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
const error = (status: number) =>
  json({ error: { message: 'PRIVATE_SERVER_DETAIL' } }, status)
type Call = { url: URL; init: RequestInit; headers: Headers }
function fixture(
  handler: (call: Call) => Response | Promise<Response> = ({ init }) =>
    init.method === 'GET'
      ? error(404)
      : json(
          { guide: stored(), editUrl: '/tenant/g/capture-native-session/edit' },
          201,
        ),
  maximum = 1024 * 1024,
) {
  const calls: Call[] = []
  const fetcher = vi.fn<typeof fetch>(async (url, init = {}) => {
    const call = {
      url: new URL(String(url)),
      init,
      headers: new Headers(init.headers),
    }
    calls.push(call)
    return call.url.pathname.endsWith('/health')
      ? json({
          target: 'php-sqlite',
          version: 'fixture',
          schema: 'stepdoc/guide@1',
          capabilities: { maxUploadBytes: maximum },
        })
      : handler(call)
  })
  const token = vi.fn(() => 'sd_private_capture_token')
  const open = (options: Partial<CaptureHttpOptions> = {}) =>
    CaptureHttpClient.open('https://host.example/tenant', {
      token,
      fetch: fetcher,
      ...options,
    })
  return { calls, fetcher, token, open }
}
describe('scoped capture HTTP client', () => {
  it('uses only anonymous health, guides:read identity recovery and capture:write sessions', async () => {
    const f = fixture(),
      client = await f.open()
    expect(f.token).not.toHaveBeenCalled()
    expect(Object.isFrozen(client.capabilities)).toBe(true)
    expect(JSON.stringify(client)).not.toMatch(/private|host\.example/)
    expect('createGuide' in client).toBe(false)
    const result = await client.upload(input())
    expect(result.guide.id).toBe(input().id)
    expect(result.editUrl).toBe(
      'https://host.example/tenant/g/capture-native-session/edit',
    )
    expect(
      f.calls.map((call) => [call.url.pathname, call.init.method]),
    ).toEqual([
      ['/tenant/api/v1/health', 'GET'],
      ['/tenant/api/v1/guides/capture-native-session', 'GET'],
      ['/tenant/api/v1/sessions', 'POST'],
    ])
    expect(JSON.parse(f.calls[2]!.init.body as string)).toEqual(input())
    expect(f.calls[0]!.headers.has('authorization')).toBe(false)
    for (const call of f.calls) {
      expect(call.init).toMatchObject({
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        mode: 'cors',
      })
      expect(call.headers.has('cookie')).toBe(false)
    }
    expect(f.token).toHaveBeenCalledTimes(2)
    client.close()
    await expect(client.upload(input())).rejects.toMatchObject({
      code: 'closed',
    })
  })
  it('reads fresh credentials for the lookup and upload', async () => {
    const f = fixture(),
      client = await f.open({
        token: vi
          .fn()
          .mockReturnValueOnce('sd_first')
          .mockReturnValueOnce('sd_second'),
      })
    await client.upload(input())
    expect(
      f.calls.slice(1).map((call) => call.headers.get('authorization')),
    ).toEqual(['Bearer sd_first', 'Bearer sd_second'])
    client.close()
  })
  it('captures an immutable request before asynchronous credential lookup', async () => {
    let release!: (value: string) => void
    const waiting = new Promise<string>((resolve) => {
      release = resolve
    })
    const f = fixture(),
      client = await f.open({ token: () => waiting }),
      doc = input()
    const task = client.upload(doc)
    doc.title = 'Changed while waiting'
    doc.steps[0]!.screenshot!.rendered = 'https://foreign.example/PRIVATE'
    release('sd_private_capture_token')
    await task
    expect(JSON.parse(f.calls[2]!.init.body as string)).toEqual(input())
    client.close()
  })
  it('aborts before lookup/post on cancellation and does not resume after closing credentials', async () => {
    const controller = new AbortController(),
      f = fixture(),
      cancelled = await f.open({ signal: controller.signal })
    controller.abort()
    await expect(cancelled.upload(input())).rejects.toMatchObject({
      code: 'storage_unavailable',
    })
    expect(f.token).not.toHaveBeenCalled()
    cancelled.close()
    let release!: (value: string) => void
    const wait = new Promise<string>((resolve) => {
      release = resolve
    })
    let entered!: () => void
    const credentialLookup = new Promise<void>((resolve) => {
      entered = resolve
    })
    const waiting = await f.open({
        token: () => {
          entered()
          return wait
        },
      }),
      task = waiting.upload(input())
    await credentialLookup
    waiting.close()
    await expect(task).rejects.toMatchObject({ code: 'closed' })
    release('sd_private_capture_token')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(f.calls.every((call) => call.url.pathname.endsWith('/health'))).toBe(
      true,
    )
  })
  it('does not send credentials when public health is incompatible', async () => {
    const token = vi.fn(() => 'PRIVATE')
    await expect(
      CaptureHttpClient.open('https://host.example', {
        token,
        fetch: async () => json({ schema: 'unknown' }),
      }),
    ).rejects.toMatchObject({ code: 'corrupt_data' })
    expect(token).not.toHaveBeenCalled()
  })
  it.each([null, [], {}, { token: 'PRIVATE' }])(
    'requires a private bearer provider: %j',
    async (options) => {
      await expect(
        CaptureHttpClient.open(
          'https://host.example',
          options as unknown as CaptureHttpOptions,
        ),
      ).rejects.toMatchObject({ code: 'invalid_options' })
    },
  )
  it('returns a later matching revision without posting or changing it', async () => {
    const saved = stored()
    saved.version = 7
    saved.title = 'Already edited'
    saved.status = 'published'
    const f = fixture(() => json(saved)),
      client = await f.open()
    const result = await client.upload(input())
    expect(result.guide).toEqual(saved)
    expect(f.calls).toHaveLength(2)
    client.close()
  })
  it('rejects an ID collision without uploading or overwriting', async () => {
    const saved = stored()
    saved.uuid = '123e4567-e89b-42d3-a456-426614174002'
    const f = fixture(() => json(saved)),
      client = await f.open()
    await expect(client.upload(input())).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(f.calls).toHaveLength(2)
    client.close()
  })
  it('reads a matching winner after a concurrent conflict without a second POST', async () => {
    let gets = 0
    const f = fixture(({ init }) =>
        init.method === 'POST'
          ? error(409)
          : ++gets === 1
            ? error(404)
            : json({ ...stored(), version: 2 }),
      ),
      client = await f.open()
    expect((await client.upload(input())).guide.version).toBe(2)
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(
      1,
    )
    client.close()
  })
  it('retains a conflict when no matching guide can be recovered', async () => {
    const f = fixture(({ init }) => error(init.method === 'POST' ? 409 : 404)),
      client = await f.open()
    await expect(client.upload(input())).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(
      1,
    )
    client.close()
  })
  it.each([
    'https://foreign.example/g/capture-native-session/edit',
    'http://host.example/tenant/g/capture-native-session/edit',
    'https://person:PRIVATE@host.example/tenant/g/capture-native-session/edit',
    '/tenant/g/capture-native-session/edit?token=PRIVATE',
    '/tenant/g/capture-native-session/edit#PRIVATE',
    '/g/capture-native-session/edit',
    '/tenant/g/other-guide/edit',
    'javascript:PRIVATE',
    'data:text/html,PRIVATE',
    '//foreign.example/PRIVATE',
  ])(
    'rejects an untrusted editor destination without reflecting it: %s',
    async (editUrl) => {
      const f = fixture(({ init }) =>
          init.method === 'GET'
            ? error(404)
            : json({ guide: stored(), editUrl }, 201),
        ),
        client = await f.open()
      const failure = await client
        .upload(input())
        .catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'corrupt_data' })
      expect(String(failure)).not.toContain('PRIVATE')
      client.close()
    },
  )
  it.each([
    'g/capture-native-session/edit',
    './g/capture-native-session/edit',
    'https://host.example/tenant/g/capture-native-session/edit',
  ])('normalizes a safe editor destination: %s', async (editUrl) => {
    const f = fixture(({ init }) =>
        init.method === 'GET'
          ? error(404)
          : json({ guide: stored(), editUrl }, 201),
      ),
      client = await f.open()
    expect((await client.upload(input())).editUrl).toBe(
      'https://host.example/tenant/g/capture-native-session/edit',
    )
    client.close()
  })
  it.each([
    (doc: Guide) => {
      doc.uuid = undefined
    },
    (doc: Guide) => {
      doc.version = 2
    },
    (doc: Guide) => {
      doc.status = 'published'
    },
    (doc: Guide) => {
      doc.publish = { isPublic: true, targets: [] }
    },
    (doc: Guide) => {
      doc.publish = { isPublic: false, targets: ['link'] }
    },
  ])(
    'requires a new private capture before touching credentials',
    async (mutate) => {
      const f = fixture(),
        client = await f.open(),
        doc = input()
      mutate(doc)
      await expect(client.upload(doc)).rejects.toMatchObject({
        code: 'invalid_guide',
      })
      expect(f.token).not.toHaveBeenCalled()
      client.close()
    },
  )
  it('rejects typed fill literals and unknown credential fields before lookup', async () => {
    const f = fixture(),
      client = await f.open(),
      doc = input()
    doc.steps[0]!.action = 'fill'
    doc.steps[0]!.value = { kind: 'literal', literal: 'PRIVATE_TYPED_VALUE' }
    await expect(client.upload(doc)).rejects.toMatchObject({
      code: 'invalid_guide',
    })
    await expect(
      client.upload({ ...input(), token: 'PRIVATE' } as Guide),
    ).rejects.toMatchObject({ code: 'invalid_guide' })
    expect(f.token).not.toHaveBeenCalled()
    client.close()
  })
  it('refuses open redactions before lookup', async () => {
    const f = fixture(),
      client = await f.open(),
      doc = input()
    doc.steps[0]!.redactions.push({
      kind: 'email',
      source: 'auto',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      status: 'open',
    })
    await expect(client.upload(doc)).rejects.toMatchObject({
      code: 'redaction_open',
    })
    expect(f.token).not.toHaveBeenCalled()
    client.close()
  })
  it.each([
    'https://foreign.example/PRIVATE',
    'blob:PRIVATE',
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:image/png;base64,',
    'data:image/png;base64,AAAA',
    'data:image/png;base64,a===',
    'data:image/png;base64,iVBORw0KGgoAAAAA\n',
  ])('rejects non-inline/invalid rasters before lookup: %s', async (image) => {
    const f = fixture(),
      client = await f.open(),
      doc = input()
    doc.steps[0]!.screenshot!.rendered = image
    await expect(client.upload(doc)).rejects.toMatchObject({
      code: 'invalid_blob',
    })
    expect(f.token).not.toHaveBeenCalled()
    client.close()
  })
  it('enforces advertised, per-data-URL and total JSON budgets before lookup', async () => {
    for (const [maximum, options, image] of [
      [4, {}, png],
      [1024, {}, 'x'.repeat(MAX_CAPTURE_INLINE_BYTES + 1)],
      [1024, { maxJsonBytes: 512 }, png],
    ] as const) {
      const f = fixture(undefined, maximum),
        client = await f.open(options),
        doc = input()
      doc.steps[0]!.screenshot!.rendered = image
      if ('maxJsonBytes' in options) doc.steps[0]!.notes = 'é'.repeat(512)
      await expect(client.upload(doc)).rejects.toMatchObject({
        code: 'upload_too_large',
      })
      expect(f.token).not.toHaveBeenCalled()
      client.close()
    }
  })
  it.each([0, -1, 16385])(
    'rejects invalid screenshot geometry %s',
    async (width) => {
      const f = fixture(),
        client = await f.open(),
        doc = input()
      doc.steps[0]!.screenshot!.width = width
      await expect(client.upload(doc)).rejects.toMatchObject({
        code: 'invalid_blob',
      })
      expect(f.token).not.toHaveBeenCalled()
      client.close()
    },
  )
  it('does not retry a failed POST and recovers its committed guide on manual retry', async () => {
    let committed = false
    const f = fixture(({ init }) => {
        if (init.method === 'POST') {
          committed = true
          throw new Error('PRIVATE_NETWORK_DETAIL')
        }
        return committed ? json(stored()) : error(404)
      }),
      client = await f.open()
    const failure = await client
      .upload(input())
      .catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: 'storage_unavailable' })
    expect(String(failure)).not.toContain('PRIVATE')
    expect((await client.upload(input())).guide.id).toBe(input().id)
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(
      1,
    )
    client.close()
  })
  it.each([401, 403, 429])(
    'does not POST after an unsuccessful identity read (%s)',
    async (status) => {
      const f = fixture(() => error(status)),
        client = await f.open()
      await expect(client.upload(input())).rejects.toMatchObject({
        code:
          status === 401
            ? 'unauthorized'
            : status === 403
              ? 'forbidden'
              : 'rate_limited',
      })
      expect(
        f.calls.filter((call) => call.init.method === 'POST'),
      ).toHaveLength(0)
      client.close()
    },
  )
  it('decodes only bounded PNG/WebP bytes without fetching a URL', async () => {
    const blob = await captureImageBlob(png)
    expect(blob.type).toBe('image/png')
    expect(blob.size).toBe(12)
    await expect(
      captureImageBlob(null as unknown as string),
    ).rejects.toMatchObject({ code: 'invalid_blob' })
    await expect(captureImageBlob(png, -1)).rejects.toMatchObject({
      code: 'invalid_options',
    })
  })
})

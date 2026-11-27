import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { guideSchema, type Guide } from '@stepdoc/schema'
import {
  apiHealthSchema,
  apiGuidePageSchema,
  apiVersionsSchema,
} from '@stepdoc/schema/storage-api'
import { HttpAdapter } from '@stepdoc/storage/http'
import { provision, type ContractFixture } from './fixtures'

// The HTTP assertions are shared. Only target provisioning/startup is target-specific.
let fixture: ContractFixture
const document = (id: string, title = 'Contract guide'): Guide =>
  guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id,
    uuid: crypto.randomUUID(),
    title,
    steps: [
      { id: 'step-one', index: 1, type: 'manual', title: 'Open settings' },
    ],
    version: 1,
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
  })
async function call(path: string, options: RequestInit = {}, token?: string) {
  const headers = new Headers(options.headers)
  if (token !== '')
    headers.set('Authorization', `Bearer ${token ?? fixture.owner.token}`)
  if (typeof options.body === 'string' && !headers.has('Content-Type'))
    headers.set('Content-Type', 'application/json')
  return fetch(fixture.server.api + path, {
    ...options,
    headers,
    redirect: 'manual',
  })
}
const json = (response: Response): Promise<unknown> =>
  response.json() as Promise<unknown>
const create = async (guide: Guide, token?: string) => {
  const response = await call(
    'guides',
    { method: 'POST', body: JSON.stringify(guide) },
    token,
  )
  expect(response.status).toBe(201)
  return guideSchema.parse(await json(response))
}
async function error(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  const body = (await json(response)) as {
    error: { code: string; message: string }
  }
  expect(body.error.code).toBe(code)
  expect(typeof body.error.message).toBe('string')
  expect(response.headers.get('content-type')).toContain('application/json')
  return body
}
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB30AAAAASUVORK5CYII=',
  'base64',
)
function multipart(
  kind = 'rendered',
  stepId = 'step-one',
  data = png,
  type = 'image/png',
) {
  const body = new FormData()
  body.set('file', new Blob([data], { type }), 'ignored-private-name.png')
  body.set('stepId', stepId)
  body.set('kind', kind)
  return body
}

beforeAll(async () => {
  fixture = await provision()
})
afterAll(async () => {
  await fixture?.close()
})
describe('Storage API v1 contract', () => {
  it('reports actual capabilities anonymously without exposing host paths', async () => {
    const response = await call('health', {}, '')
    expect(response.status).toBe(200)
    const body = await json(response)
    const health = apiHealthSchema.parse(body)
    expect(health.target).toBe(fixture.target)
    expect(health.capabilities.maxUploadBytes).toBe(fixture.maxUploadBytes)
    expect(typeof health.capabilities.passkeys).toBe('boolean')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
  it('requires a valid non-revoked bearer with the operation scope', async () => {
    await error(await call('guides', {}, ''), 401, 'unauthorized')
    await error(
      await call('guides', {}, 'sd_' + 'x'.repeat(43)),
      401,
      'unauthorized',
    )
    await error(
      await call(
        'guides',
        { method: 'POST', body: JSON.stringify(document('reader-write')) },
        fixture.reader.token,
      ),
      403,
      'forbidden',
    )
    await error(
      await call(
        'guides',
        { method: 'POST', body: JSON.stringify(document('capture-write')) },
        fixture.capture.token,
      ),
      403,
      'forbidden',
    )
    const revoked = fixture.issue(['guides:read'])
    fixture.revoke(revoked.id)
    await error(await call('guides', {}, revoked.token), 401, 'unauthorized')
  })
  it('creates schema-normalized guides with stable identity and rejects duplicates', async () => {
    const guide = await create(document('identity-guide'))
    expect(guide.version).toBe(1)
    expect(guide.createdAt).toBe('2026-11-26T00:00:00Z')
    expect(guide.updatedAt).not.toBe(guide.createdAt)
    const response = await call('guides/identity-guide')
    expect(response.headers.get('etag')).toBe('"1"')
    expect(guideSchema.parse(await json(response))).toEqual(guide)
    await error(
      await call('guides', { method: 'POST', body: JSON.stringify(guide) }),
      409,
      'conflict',
    )
    const minimal = {
      schema: 'stepdoc/guide@1',
      id: 'normalized-guide',
      title: 'Minimal',
      steps: [{ id: 'one', index: 1, type: 'manual', title: 'Continue' }],
      version: 12,
      createdAt: guide.createdAt,
      updatedAt: guide.createdAt,
    }
    const normalized = await call('guides', {
      method: 'POST',
      body: JSON.stringify(minimal),
    })
    expect(normalized.status).toBe(201)
    const stored = await json(normalized)
    expect(stored).toEqual(guideSchema.parse(stored))
    expect(guideSchema.parse(stored).version).toBe(1)
  })
  it('validates full guide@1 before storing: typed fills, secret examples, unknown fields and references', async () => {
    const cases: unknown[] = [
      { ...document('bad-schema'), schema: 'guide@2' },
      { ...document('bad-extra'), extra: 'PRIVATE_FIELD' },
      {
        ...document('bad-literal'),
        steps: [
          {
            id: 'one',
            index: 1,
            type: 'action',
            title: 'Fill',
            action: 'fill',
            value: { kind: 'literal', literal: 'PRIVATE_TYPED_VALUE' },
          },
        ],
      },
      {
        ...document('bad-secret'),
        variables: [
          { name: 'password', kind: 'secret', example: 'PRIVATE_SECRET' },
        ],
      },
      {
        ...document('bad-ref'),
        steps: [
          {
            id: 'one',
            index: 1,
            type: 'action',
            title: 'Fill',
            action: 'fill',
            value: { kind: 'variable', variable: 'missing' },
          },
        ],
      },
      {
        ...document('bad-duplicates'),
        steps: [
          { id: 'one', index: 1, type: 'manual', title: 'A' },
          { id: 'one', index: 2, type: 'manual', title: 'B' },
        ],
      },
      { ...document('bad-format'), uuid: 'invalid' },
    ]
    for (const body of cases) {
      const result = await error(
        await call('guides', { method: 'POST', body: JSON.stringify(body) }),
        400,
        'invalid_guide',
      )
      expect(JSON.stringify(result)).not.toContain('PRIVATE_')
      await error(
        await call(`guides/${(body as { id: string }).id}`),
        404,
        'not_found',
      )
    }
  })
  it('writes unlimited immutable versions and enforces If-Match atomically across processes', async () => {
    const original = await create(document('versioned-guide'))
    const first = { ...original, title: 'Writer A' },
      second = { ...original, title: 'Writer B' }
    const responses = await Promise.all([
      call('guides/versioned-guide', {
        method: 'PUT',
        headers: { 'If-Match': '1' },
        body: JSON.stringify(first),
      }),
      fetch(fixture.peer.api + 'guides/versioned-guide', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${fixture.owner.token}`,
          'If-Match': '1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(second),
      }),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ])
    let latest = guideSchema.parse(
      await json(await call('guides/versioned-guide')),
    )
    for (let index = 0; index < 12; index++) {
      const response = await call('guides/versioned-guide', {
        method: 'PUT',
        headers: { 'If-Match': `"${latest.version}"` },
        body: JSON.stringify({
          ...latest,
          title: `Version ${latest.version + 1}`,
        }),
      })
      expect(response.status).toBe(200)
      latest = guideSchema.parse(await json(response))
    }
    expect(latest.version).toBe(14)
    const history = apiVersionsSchema.parse(
      await json(await call('guides/versioned-guide/versions')),
    )
    expect(history.map((version) => version.version)).toEqual(
      Array.from({ length: 14 }, (_, index) => 14 - index),
    )
    expect(
      guideSchema.parse(
        await json(await call('guides/versioned-guide/versions/1')),
      ),
    ).toEqual(original)
    await error(
      await call('guides/versioned-guide', {
        method: 'PUT',
        body: JSON.stringify(latest),
      }),
      400,
      'invalid_guide',
    )
    await error(
      await call('guides/versioned-guide', {
        method: 'PUT',
        headers: { 'If-Match': '"14' },
        body: JSON.stringify(latest),
      }),
      400,
      'invalid_guide',
    )
    await error(
      await call('guides/versioned-guide', {
        method: 'PUT',
        headers: { 'If-Match': '14' },
        body: JSON.stringify({ ...latest, uuid: crypto.randomUUID() }),
      }),
      400,
      'invalid_guide',
    )
  })
  it('keeps workspaces, history and scope checks isolated even for matching slugs', async () => {
    const primary = await create(document('same-slug', 'Primary private guide'))
    await error(
      await call('guides/same-slug', {}, fixture.other.token),
      404,
      'not_found',
    )
    await error(
      await call('guides/same-slug/versions', {}, fixture.other.token),
      404,
      'not_found',
    )
    const other = await create(
      document('same-slug', 'Other private guide'),
      fixture.other.token,
    )
    expect(other.uuid).not.toBe(primary.uuid)
    const page = apiGuidePageSchema.parse(
      await json(await call('guides', {}, fixture.other.token)),
    )
    expect(page.items.map((guide) => guide.title)).toEqual([
      'Other private guide',
    ])
    await error(
      await call(
        'guides/same-slug',
        { method: 'DELETE' },
        fixture.reader.token,
      ),
      403,
      'forbidden',
    )
  })
  it('serves unchanged raster bytes after access checks and attaches only same-guide blob keys', async () => {
    let guide = await create(document('blob-guide'))
    const response = await call('guides/blob-guide/blobs', {
      method: 'POST',
      body: multipart(),
    })
    expect(response.status).toBe(201)
    const { key } = (await json(response)) as { key: string }
    const bytes = await call(`blobs/${key}`)
    expect(bytes.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await bytes.arrayBuffer())).toEqual(png)
    const oversized = Buffer.alloc(fixture.maxUploadBytes + 1)
    png.copy(oversized)
    await error(
      await call('guides/blob-guide/blobs', {
        method: 'POST',
        body: multipart('rendered', 'step-one', oversized),
      }),
      413,
      'upload_too_large',
    )
    guide.steps[0]!.screenshot = {
      original: key,
      rendered: key,
      width: 1,
      height: 1,
      devicePixelRatio: 1,
    }
    const saved = await call('guides/blob-guide', {
      method: 'PUT',
      headers: { 'If-Match': '1' },
      body: JSON.stringify(guide),
    })
    expect(saved.status).toBe(200)
    guide = guideSchema.parse(await json(saved))
    expect(guide.version).toBe(2)
    const foreign = await create(document('foreign-blobs'))
    foreign.steps[0]!.screenshot = guide.steps[0]!.screenshot
    await error(
      await call('guides/foreign-blobs', {
        method: 'PUT',
        headers: { 'If-Match': '1' },
        body: JSON.stringify(foreign),
      }),
      400,
      'invalid_blob',
    )
    await error(
      await call(`blobs/${key}`, {}, fixture.other.token),
      404,
      'not_found',
    )
    await error(await call(`blobs/${key}/../stepdoc.sqlite`), 404, 'not_found')
    await error(
      await fetch(fixture.server.origin + '/data/stepdoc.sqlite'),
      404,
      'not_found',
    )
    await error(
      await call(
        'guides/blob-guide/blobs',
        { method: 'POST', body: multipart() },
        fixture.capture.token,
      ),
      403,
      'forbidden',
    )
    await error(
      await call('guides/blob-guide/blobs', {
        method: 'POST',
        body: multipart('rendered', 'missing'),
      }),
      400,
      'invalid_blob',
    )
    await error(
      await call('guides/blob-guide/blobs', {
        method: 'POST',
        body: multipart(
          'rendered',
          'step-one',
          Buffer.from('<svg>PRIVATE</svg>'),
          'image/svg+xml',
        ),
      }),
      400,
      'invalid_blob',
    )
  })
  it('soft-deletes guides and blocks related historical/blob reads without losing archived versions', async () => {
    const before = guideSchema.parse(
      await json(await call('guides/blob-guide')),
    )
    const key = before.steps[0]!.screenshot!.rendered
    expect((await call('guides/blob-guide', { method: 'DELETE' })).status).toBe(
      204,
    )
    await error(await call('guides/blob-guide'), 404, 'not_found')
    await error(await call('guides/blob-guide/versions/1'), 404, 'not_found')
    await error(await call(`blobs/${key}`), 404, 'not_found')
  })
  it('binds CORS to registered extension origins and binds extension tokens to that origin', async () => {
    const headers = {
      Origin: fixture.extensionOrigin,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'authorization, content-type, if-match',
    }
    const preflight = await call('guides', { method: 'OPTIONS', headers }, '')
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(
      fixture.extensionOrigin,
    )
    expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*')
    await error(
      await call('guides', {
        headers: { Origin: 'https://unregistered.example' },
      }),
      403,
      'forbidden',
    )
    const privilegedRead = await call('guides', {}, fixture.extension.token)
    expect(privilegedRead.status).toBe(200)
    await privilegedRead.arrayBuffer()
    await error(
      await call(
        'guides',
        {
          method: 'POST',
          body: JSON.stringify(document('origin-required-write')),
        },
        fixture.extension.token,
      ),
      403,
      'forbidden',
    )
    const response = await call(
      'guides',
      { headers: { Origin: fixture.extensionOrigin } },
      fixture.extension.token,
    )
    expect(response.status).toBe(200)
    fixture.revoke(fixture.extension.id)
    const revoked = await call(
      'guides',
      { headers: { Origin: fixture.extensionOrigin } },
      fixture.extension.token,
    )
    await error(revoked, 401, 'unauthorized')
    expect(revoked.headers.get('access-control-allow-origin')).toBe(
      fixture.extensionOrigin,
    )
  })
  it('persists revocation and guide versions across server restart', async () => {
    await fixture.restart()
    const result = await call('guides/identity-guide')
    expect(result.status).toBe(200)
    await error(
      await call(
        'guides',
        { headers: { Origin: fixture.extensionOrigin } },
        fixture.extension.token,
      ),
      401,
      'unauthorized',
    )
    expect(
      apiVersionsSchema.parse(
        await json(await call('guides/versioned-guide/versions')),
      ),
    ).toHaveLength(14)
  })
  it('interoperates with the actual HttpAdapter for CRUD, blob retrieval and version history', async () => {
    const adapter = await HttpAdapter.open(fixture.server.api, {
      auth: { kind: 'bearer', token: () => fixture.owner.token },
    })
    try {
      let guide = await adapter.createGuide(document('adapter-guide'))
      const { key } = await adapter.putBlob(guide.id, {
        file: new Blob([png], { type: 'image/png' }),
        stepId: 'step-one',
        kind: 'rendered',
      })
      guide.steps[0]!.screenshot = {
        rendered: key,
        original: null,
        width: 1,
        height: 1,
        devicePixelRatio: 1,
      }
      guide = await adapter.saveGuide(guide, 1)
      expect(guide.version).toBe(2)
      expect(await adapter.getGuide(guide.id)).toEqual(guide)
      expect(await (await adapter.getBlob(key)).arrayBuffer()).toEqual(
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      )
      expect(
        (await adapter.listVersions(guide.id)).map(
          (version) => version.version,
        ),
      ).toEqual([2, 1])
      expect(
        (await adapter.getVersion(guide.id, 1)).steps[0]!.screenshot,
      ).toBeUndefined()
      await expect(adapter.saveGuide(guide, 1)).rejects.toMatchObject({
        code: 'conflict',
      })
      await adapter.deleteGuide(guide.id)
      await expect(adapter.getBlob(key)).rejects.toMatchObject({
        code: 'not_found',
      })
    } finally {
      adapter.close()
    }
  })
  it('pages a filtered library with opaque query-bound cursors, including review and replay filters', async () => {
    const guides: Guide[] = []
    for (let index = 0; index < 7; index++) {
      const guide = document(`paging-${index}`, `Résumé ${index}`)
      guide.collectionId = 'contract-page'
      guide.tags = ['Case Search']
      guide.steps[0]!.lowConfidence = index === 1
      if (index === 2) guide.verification = { status: 'passed' }
      if (index === 3) guide.status = 'archived'
      guides.push(await create(guide))
    }
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const params = new URLSearchParams({
        collection: 'contract-page',
        q: 'RÉSUMÉ',
      })
      if (cursor) params.set('cursor', cursor)
      const response = await call(`guides?${params}`)
      expect(response.status).toBe(200)
      const page = apiGuidePageSchema.parse(await json(response))
      seen.push(...page.items.map((guide) => guide.id))
      if (pages === 0) {
        expect(page.nextCursor).not.toBeNull()
        const wrongQuery = new URLSearchParams({
          collection: 'different',
          cursor: page.nextCursor!,
        })
        await error(await call(`guides?${wrongQuery}`), 400, 'invalid_query')
      }
      cursor = page.nextCursor
      expect(++pages).toBeLessThan(10)
    } while (cursor)
    const expected = [...guides].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    )
    expect(seen).toEqual(expected.map((guide) => guide.id))
    const review = apiGuidePageSchema.parse(
      await json(
        await call('guides?collection=contract-page&status=needs-review'),
      ),
    )
    expect(review.items.map((guide) => guide.id)).toEqual(['paging-1'])
    const replay = apiGuidePageSchema.parse(
      await json(
        await call('guides?collection=contract-page&status=replay-passed'),
      ),
    )
    expect(replay.items.map((guide) => guide.id)).toEqual(['paging-2'])
    const archived = apiGuidePageSchema.parse(
      await json(await call('guides?collection=contract-page&status=archived')),
    )
    expect(archived.items.map((guide) => guide.id)).toEqual(['paging-3'])
    await error(await call('guides?q[]=array'), 400, 'invalid_query')
    await error(await call('guides?status=unknown'), 400, 'invalid_query')
    await error(await call('guides?cursor=not-a-cursor'), 400, 'invalid_query')
    await error(
      await call('guides?q=' + 'a'.repeat(1001)),
      400,
      'invalid_query',
    )
  })
  it('returns safe JSON errors for unsupported methods, media types, bad JSON and oversized metadata', async () => {
    await error(
      await call('guides', { method: 'PATCH' }),
      405,
      'method_not_allowed',
    )
    await error(
      await call('guides', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'PRIVATE_NOT_JSON',
      }),
      415,
      'unsupported_media_type',
    )
    await error(
      await call('guides', { method: 'POST', body: '{"PRIVATE_BROKEN":' }),
      400,
      'invalid_guide',
    )
    await error(
      await call('guides', {
        method: 'POST',
        body: ' '.repeat(8 * 1024 * 1024 + 1),
      }),
      413,
      'upload_too_large',
    )
    await error(
      await call(
        'guides',
        { headers: { Cookie: 'sd_session=PRIVATE_FORGED' } },
        '',
      ),
      401,
      'unauthorized',
    )
    const guide = document('not-public')
    guide.publish = { isPublic: true, targets: ['link'] }
    await error(
      await call('guides', { method: 'POST', body: JSON.stringify(guide) }),
      403,
      'forbidden',
    )
    await error(await call('guides/not-public'), 404, 'not_found')
    const response = await call(
      'guides',
      {
        method: 'OPTIONS',
        headers: {
          Origin: fixture.extensionOrigin,
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'x-unexpected',
        },
      },
      '',
    )
    await error(response, 403, 'forbidden')
  })
})

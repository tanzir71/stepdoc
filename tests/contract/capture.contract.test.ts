import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest'
import { guideSchema, type Guide } from '@stepdoc/schema'
import {
  apiBlobKeySchema,
  apiCaptureResultSchema,
  apiVersionsSchema,
} from '@stepdoc/schema/storage-api'
import { CaptureHttpClient, HttpAdapter } from '@stepdoc/storage/http'
import { provision, type ContractFixture } from './fixtures'

let fixture: ContractFixture
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB30AAAAASUVORK5CYII=',
  'base64',
)
const dataUrl = 'data:image/png;base64,' + png.toString('base64')
const capture = (id: string): Guide =>
  guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id,
    uuid: crypto.randomUUID(),
    title: 'Captured workflow',
    steps: [
      {
        id: 'first',
        index: 1,
        type: 'action',
        action: 'fill',
        title: 'Fill field',
        value: { kind: 'secret', variable: 'field' },
        screenshot: {
          original: dataUrl,
          rendered: dataUrl,
          width: 1,
          height: 1,
        },
      },
    ],
    variables: [{ name: 'field', kind: 'secret' }],
    version: 1,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T00:00:00Z',
  })
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  token = fixture.capture.token,
  api = fixture.server.api,
) {
  return fetch(api + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined || body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  })
}
function form(
  guide: Guide,
  kind = 'rendered',
  stepId = 'first',
  bytes = png,
  mime = 'image/png',
) {
  const body = new FormData()
  body.set('file', new Blob([bytes], { type: mime }), 'private-upload-name.png')
  body.set('stepId', stepId)
  body.set('kind', kind)
  body.set('captureUuid', guide.uuid!)
  return body
}
async function stage(
  guide: Guide,
  kind = 'rendered',
  token = fixture.capture.token,
) {
  const response = await request(
    `guides/${guide.id}/blobs`,
    'POST',
    form(guide, kind),
    token,
  )
  expect(response.status).toBe(201)
  return apiBlobKeySchema.parse(await response.json()).key
}
async function denied(response: Response, status: number, code: string) {
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
}
beforeAll(async () => {
  fixture = await provision({ maxUploadBytes: 16 * 1024 * 1024 })
}, 90000)
afterAll(async () => {
  await fixture?.close()
})

describe('Storage API v1 capture ingestion', () => {
  it('uses the shared UUID format and Unicode code-point limit for capture step metadata', async () => {
    const input = capture('capture-unicode-stage')
    input.uuid = `urn:uuid:${input.uuid}`
    input.steps[0]!.id = '𝌆'.repeat(200)
    const response = await request(
      `guides/${input.id}/blobs`,
      'POST',
      form(input, 'rendered', input.steps[0]!.id),
    )
    expect(response.status).toBe(201)
    const key = apiBlobKeySchema.parse(await response.json()).key
    input.steps[0]!.screenshot = {
      ...input.steps[0]!.screenshot!,
      original: null,
      rendered: key,
    }
    const committed = await request('sessions', 'POST', input)
    expect(committed.status).toBe(201)
    expect(
      apiCaptureResultSchema.parse(await committed.json()).guide.steps[0]!.id,
    ).toBe(input.steps[0]!.id)
    await denied(
      await request(
        `guides/${input.id}/blobs`,
        'POST',
        form(input, 'rendered', '𝌆'.repeat(201)),
      ),
      400,
      'invalid_blob',
    )
  })
  it('atomically stores inline client-prepared bytes, identity, first version and an installation-scoped editor URL', async () => {
    const input = capture('capture-inline')
    const response = await request('sessions', 'POST', input)
    expect(response.status).toBe(201)
    const result = apiCaptureResultSchema.parse(await response.json())
    expect(result.editUrl).toBe(`/tools/g/${input.id}/edit`)
    expect(result.guide.uuid).toBe(input.uuid)
    expect(result.guide.createdAt).toBe(input.createdAt)
    expect(result.guide.version).toBe(1)
    expect(result.guide.variables).toEqual(input.variables)
    for (const kind of ['original', 'rendered'] as const) {
      const key = result.guide.steps[0]!.screenshot![kind]!
      expect(key).toMatch(/^[a-f0-9]{48}\.png$/)
      const bytes = await request(`blobs/${key}`)
      expect(bytes.status).toBe(200)
      expect(Buffer.from(await bytes.arrayBuffer())).toEqual(png)
    }
    expect(
      apiVersionsSchema.parse(
        await (await request(`guides/${input.id}/versions`)).json(),
      ),
    ).toHaveLength(1)
  })
  it('leaves no guide on a late malformed image, typed literal, open redaction or invalid capture geometry', async () => {
    const invalid = capture('capture-late-invalid')
    invalid.steps[0]!.screenshot!.rendered =
      'data:image/svg+xml;base64,PHN2Zz4='
    await denied(
      await request('sessions', 'POST', invalid),
      400,
      'invalid_blob',
    )
    await denied(await request(`guides/${invalid.id}`), 404, 'not_found')
    const literal = capture('capture-typed-literal')
    literal.steps[0]!.value = {
      kind: 'literal',
      literal: 'PRIVATE_TYPED_VALUE',
    }
    await denied(
      await request('sessions', 'POST', literal),
      400,
      'invalid_guide',
    )
    const open = capture('capture-open-mask')
    open.steps[0]!.redactions.push({
      kind: 'field',
      source: 'auto',
      status: 'open',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    })
    await denied(await request('sessions', 'POST', open), 423, 'redaction_open')
    const geometry = capture('capture-bad-geometry')
    geometry.steps[0]!.screenshot!.width = 0
    await denied(
      await request('sessions', 'POST', geometry),
      400,
      'invalid_blob',
    )
    for (const doc of [literal, open, geometry])
      await denied(await request(`guides/${doc.id}`), 404, 'not_found')
  })
  it('keeps staged bytes and guides private, deduplicates stage retries, then promotes only referenced image roles', async () => {
    const input = capture('capture-staged')
    const original = await stage(input, 'original'),
      rendered = await stage(input)
    expect(await stage(input)).toBe(rendered)
    await denied(await request(`guides/${input.id}`), 404, 'not_found')
    await denied(await request(`blobs/${rendered}`), 404, 'not_found')
    input.steps[0]!.screenshot = {
      ...input.steps[0]!.screenshot!,
      original,
      rendered,
    }
    const response = await request('sessions', 'POST', input)
    expect(response.status).toBe(201)
    const saved = apiCaptureResultSchema.parse(await response.json()).guide
    expect(saved.steps[0]!.screenshot).toEqual(input.steps[0]!.screenshot)
    expect(
      Buffer.from(await (await request(`blobs/${rendered}`)).arrayBuffer()),
    ).toEqual(png)
    await denied(
      await request(`guides/${input.id}/blobs`, 'POST', form(input)),
      409,
      'conflict',
    )
  })
  it('enforces capture scope, stage issuer/workspace/identity and exact step/image role without general guide writes', async () => {
    const input = capture('capture-bound')
    const key = await stage(input, 'original')
    await denied(
      await request('sessions', 'POST', input, fixture.reader.token),
      403,
      'forbidden',
    )
    const writer = fixture.issue(['guides:read', 'guides:write'])
    await denied(
      await request(
        `guides/${input.id}/blobs`,
        'POST',
        form(input),
        writer.token,
      ),
      403,
      'forbidden',
    )
    const generic = form(input)
    generic.delete('captureUuid')
    await denied(
      await request(`guides/${input.id}/blobs`, 'POST', generic),
      403,
      'forbidden',
    )
    await denied(await request('guides', 'POST', input), 403, 'forbidden')
    const peer = fixture.issue(['capture:write', 'guides:read'])
    await denied(
      await request('sessions', 'POST', input, peer.token),
      409,
      'conflict',
    )
    await denied(
      await request('sessions', 'POST', {
        ...input,
        uuid: crypto.randomUUID(),
      }),
      409,
      'conflict',
    )
    input.steps[0]!.screenshot = {
      ...input.steps[0]!.screenshot!,
      original: null,
      rendered: key,
    }
    await denied(await request('sessions', 'POST', input), 400, 'invalid_blob')
    const borrowed = {
      ...input,
      id: 'capture-borrowed',
      uuid: crypto.randomUUID(),
    }
    await denied(
      await request('sessions', 'POST', borrowed),
      400,
      'invalid_blob',
    )
    await denied(
      await request('sessions', 'POST', input, fixture.other.token),
      400,
      'invalid_blob',
    )
    await denied(
      await request(`blobs/${key}`, 'GET', undefined, fixture.other.token),
      404,
      'not_found',
    )
  })
  it('serializes racing commits across PHP processes and returns a newer editor version unchanged on retry', async () => {
    const input = capture('capture-race')
    const replies = await Promise.all([
      request('sessions', 'POST', input),
      request(
        'sessions',
        'POST',
        input,
        fixture.capture.token,
        fixture.peer.api,
      ),
    ])
    for (const response of replies) expect(response.status).toBe(201)
    const [first, second] = await Promise.all(
      replies.map(async (response) =>
        apiCaptureResultSchema.parse(await response.json()),
      ),
    )
    expect(first!.guide).toEqual(second!.guide)
    const editor = await HttpAdapter.open(fixture.server.api, {
      auth: { kind: 'bearer', token: () => fixture.owner.token },
    })
    try {
      const saved = await editor.saveGuide(
        { ...first!.guide, title: 'Later editor change' },
        1,
      )
      const retry = await request('sessions', 'POST', input)
      expect(retry.status).toBe(201)
      expect(apiCaptureResultSchema.parse(await retry.json()).guide).toEqual(
        saved,
      )
      expect(await editor.listVersions(input.id)).toHaveLength(2)
      await editor.deleteGuide(input.id)
      await denied(await request('sessions', 'POST', input), 404, 'not_found')
    } finally {
      editor.close()
    }
  })
  it('streams images larger than the JSON/inline budget through capture-scoped multipart without exposing pending bytes', async () => {
    const input = capture('capture-large')
    const padded = Buffer.concat([png, Buffer.alloc(9 * 1024 * 1024)])
    const large = 'data:image/png;base64,' + padded.toString('base64')
    input.steps[0]!.screenshot = {
      ...input.steps[0]!.screenshot!,
      original: large,
      rendered: large,
    }
    const staged: string[] = [],
      jsonSizes: number[] = []
    const fetcher: typeof fetch = async (url, init) => {
      if (typeof init?.body === 'string')
        jsonSizes.push(Buffer.byteLength(init.body))
      const response = await fetch(url, init)
      if (init?.body instanceof FormData) {
        staged.push(apiBlobKeySchema.parse(await response.clone().json()).key)
        await denied(await request(`blobs/${staged.at(-1)!}`), 404, 'not_found')
        await denied(await request(`guides/${input.id}`), 404, 'not_found')
      }
      return response
    }
    const beforeWrite = vi.fn(async () => {
      expect(staged).toHaveLength(0)
    })
    const client = await CaptureHttpClient.open(fixture.server.api, {
      token: () => fixture.capture.token,
      fetch: fetcher,
      timeoutMs: 30000,
    })
    try {
      const result = await client.upload(input, beforeWrite)
      expect(beforeWrite).toHaveBeenCalledOnce()
      expect(staged).toHaveLength(2)
      expect(jsonSizes).toHaveLength(1)
      expect(jsonSizes[0]!).toBeLessThan(8192)
      expect(result.editUrl).toBe(
        `${fixture.server.origin}/tools/g/${input.id}/edit`,
      )
      for (const key of staged)
        expect(
          Buffer.from(
            await (await request(`blobs/${key}`)).arrayBuffer(),
          ).equals(padded),
        ).toBe(true)
    } finally {
      client.close()
    }
  }, 60000)
  it('retains pending bytes across server restart and resumes a failed sequential upload without a partial guide', async () => {
    const input = capture('capture-resume')
    let fail = true,
      writes = 0
    const token = () => fixture.capture.token
    const client = await CaptureHttpClient.open(fixture.server.api, {
      token,
      fetch: async (url, init) => {
        if (init?.body instanceof FormData && ++writes === 2 && fail)
          throw new Error('PRIVATE_NETWORK_DETAIL')
        return fetch(url, init)
      },
    })
    const file = new Blob([png], { type: 'image/png' })
    const images = vi.fn(async () => ({
      original: file,
      rendered: file,
      width: 1,
      height: 1,
    }))
    try {
      await expect(client.uploadPrepared(input, images)).rejects.toMatchObject({
        code: 'storage_unavailable',
      })
      await denied(await request(`guides/${input.id}`), 404, 'not_found')
    } finally {
      client.close()
    }
    await fixture.restart()
    fail = false
    const resumed = await CaptureHttpClient.open(fixture.server.api, { token })
    try {
      const result = await resumed.uploadPrepared(input, images)
      expect(result.guide.id).toBe(input.id)
      expect(
        apiVersionsSchema.parse(
          await (await request(`guides/${input.id}/versions`)).json(),
        ),
      ).toHaveLength(1)
    } finally {
      resumed.close()
    }
  })
})

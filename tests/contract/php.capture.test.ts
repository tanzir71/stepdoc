import { beforeAll, afterAll, it, expect } from 'vitest'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { guideSchema } from '@stepdoc/schema'
import {
  apiBlobKeySchema,
  apiCaptureResultSchema,
} from '@stepdoc/schema/storage-api'
import { phpFixture } from './php-fixture'

let fixture: Awaited<ReturnType<typeof phpFixture>>
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB30AAAAASUVORK5CYII=',
  'base64',
)
const url = 'data:image/png;base64,' + png.toString('base64')
const guide = (id: string) =>
  guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id,
    uuid: crypto.randomUUID(),
    title: 'Capture lifecycle',
    steps: [
      {
        id: 'one',
        index: 1,
        type: 'manual',
        title: 'Continue',
        screenshot: { original: null, rendered: url, width: 1, height: 1 },
      },
    ],
    version: 1,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T00:00:00Z',
  })
type Capture = ReturnType<typeof guide>
const call = (
  path: string,
  method = 'GET',
  body?: unknown,
  api = fixture.server.api,
) =>
  fetch(api + path, {
    method,
    headers: {
      Authorization: `Bearer ${fixture.capture.token}`,
      ...(body === undefined || body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined
      ? {}
      : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  })
const filePath = (key: string) => {
  expect(key).toMatch(/^[a-f0-9]{48}\.png$/)
  return join(fixture.dataDir, 'blobs', key)
}
async function stage(input: Capture, bytes = png, api = fixture.server.api) {
  const body = new FormData()
  body.set(
    'file',
    new Blob([bytes], { type: 'image/png' }),
    'PRIVATE_UPLOAD_NAME.png',
  )
  body.set('stepId', 'one')
  body.set('kind', 'rendered')
  body.set('captureUuid', input.uuid!)
  const response = await call(`guides/${input.id}/blobs`, 'POST', body, api)
  expect(response.status).toBe(201)
  return apiBlobKeySchema.parse(await response.json()).key
}
async function files() {
  return (
    await readdir(join(fixture.dataDir, 'blobs')).catch(() => [] as string[])
  ).sort()
}
beforeAll(async () => {
  fixture = await phpFixture()
}, 90000)
afterAll(async () => {
  await fixture?.close()
})

it('replaces private stage bytes, repairs corruption on resend and lazily expires only uncommitted files', async () => {
  const input = guide('capture-private-replace')
  const first = await stage(input)
  const changed = Buffer.concat([png, Buffer.from([1])])
  const second = await stage(input, changed)
  expect(second).not.toBe(first)
  expect(await files()).toEqual([second])
  expect(await stage(input, changed)).toBe(second)
  await writeFile(filePath(second), 'CORRUPT')
  input.steps[0]!.screenshot!.rendered = second
  const corrupt = await call('sessions', 'POST', input)
  expect(corrupt.status).toBe(500)
  await corrupt.arrayBuffer()
  const absent = await call(`guides/${input.id}`)
  expect(absent.status).toBe(404)
  await absent.arrayBuffer()
  const repaired = await stage(input, changed)
  expect(repaired).not.toBe(second)
  expect((await readFile(filePath(repaired))).equals(changed)).toBe(true)
  expect(await files()).toEqual([repaired])
  fixture.inspect(
    "UPDATE capture_uploads SET updated_at=0 WHERE guide_id='capture-private-replace'",
  )
  const saved = guide('capture-retain-committed'),
    savedKey = await stage(saved)
  expect(await files()).toEqual([savedKey])
  saved.steps[0]!.screenshot!.rendered = savedKey
  expect((await call('sessions', 'POST', saved)).status).toBe(201)
  fixture.inspect(
    "UPDATE capture_uploads SET updated_at=0 WHERE guide_id='capture-retain-committed'",
  )
  const fresh = guide('capture-trigger-expiry'),
    freshKey = await stage(fresh)
  expect(await files()).toEqual([savedKey, freshKey].sort())
  const retained = await call(`blobs/${savedKey}`)
  expect(retained.status).toBe(200)
  expect(Buffer.from(await retained.arrayBuffer()).equals(png)).toBe(true)
  expect(fixture.inspect('PRAGMA foreign_key_check')).toEqual([])
})

it('rolls back new inline files without deleting prior pending bytes, and never persists URLs, filenames or rejected typed values', async () => {
  const input = guide('capture-file-rollback')
  const key = await stage(input)
  const before = await files()
  input.steps[0]!.screenshot = {
    ...input.steps[0]!.screenshot!,
    original: url,
    rendered: 'data:image/svg+xml;base64,PHN2Zz4=',
  }
  const failure = await call('sessions', 'POST', input)
  expect(failure.status).toBe(400)
  await failure.arrayBuffer()
  expect(await files()).toEqual(before)
  expect(
    fixture.inspect(
      "SELECT key FROM capture_blobs WHERE guide_id='capture-file-rollback'",
    ),
  ).toEqual([{ key }])
  expect(
    fixture.inspect("SELECT id FROM guides WHERE id='capture-file-rollback'"),
  ).toEqual([])
  const literal = guide('capture-rejected-literal')
  literal.steps[0]!.action = 'fill'
  literal.steps[0]!.value = {
    kind: 'literal',
    literal: 'PRIVATE_TYPED_CAPTURE',
  }
  const denied = await call('sessions', 'POST', literal)
  expect(denied.status).toBe(400)
  await denied.arrayBuffer()
  for (const name of ['stepdoc.sqlite', 'stepdoc.sqlite-wal']) {
    const bytes = await readFile(join(fixture.dataDir, name)).catch(() =>
      Buffer.alloc(0),
    )
    for (const secret of ['PRIVATE_UPLOAD_NAME', 'PRIVATE_TYPED_CAPTURE', url])
      expect(bytes.includes(Buffer.from(secret))).toBe(false)
  }
})

it('deduplicates concurrent staged uploads across real PHP processes and commits their bytes only once', async () => {
  const input = guide('capture-stage-race')
  const [first, second] = await Promise.all([
    stage(input),
    stage(input, png, fixture.peer.api),
  ])
  expect(first).toBe(second)
  input.steps[0]!.screenshot!.rendered = first!
  const responses = await Promise.all([
    call('sessions', 'POST', input),
    call('sessions', 'POST', input, fixture.peer.api),
  ])
  for (const response of responses) {
    expect(response.status).toBe(201)
    expect(
      apiCaptureResultSchema.parse(await response.json()).guide.steps[0]!
        .screenshot!.rendered,
    ).toBe(first)
  }
  expect(
    fixture.inspect(
      "SELECT COUNT(*) AS n FROM blobs WHERE guide_id='capture-stage-race'",
    ),
  ).toEqual([{ n: 1 }])
  expect(
    fixture.inspect(
      "SELECT COUNT(*) AS n FROM guide_versions WHERE guide_id='capture-stage-race'",
    ),
  ).toEqual([{ n: 1 }])
})

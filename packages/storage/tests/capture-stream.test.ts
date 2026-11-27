import { describe, it, expect, vi } from 'vitest'
import { guideSchema, type Guide } from '@stepdoc/schema'
import { CaptureHttpClient, type CaptureImageProvider } from '../src/http'

const file = new Blob(
  [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0)],
  { type: 'image/png' },
)
const input = (): Guide =>
  guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id: 'capture-stream',
    uuid: '123e4567-e89b-42d3-a456-426614174001',
    title: 'Capture',
    steps: [1, 2].map((index) => ({
      id: `step-${index}`,
      index,
      type: 'manual',
      title: 'Continue',
      screenshot: {
        original: 'PRIVATE_SOURCE',
        rendered: 'PRIVATE_RENDER',
        width: 1,
        height: 1,
      },
    })),
    version: 1,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T00:00:00Z',
  })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
function fixture(blobUpload = true) {
  const calls: Array<{ path: string; init: RequestInit }> = []
  let existing: Guide | undefined, afterStage: (() => void) | undefined
  const token = vi.fn(() => 'sd_fresh_private')
  const fetcher = vi.fn<typeof fetch>(async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    calls.push({ path, init })
    if (path.endsWith('/health'))
      return json({
        target: 'php-sqlite',
        version: 'fixture',
        schema: 'stepdoc/guide@1',
        capabilities: {
          maxUploadBytes: 4096,
          maxJsonBytes: 4096,
          captureBlobUpload: blobUpload,
        },
      })
    if (init.method === 'GET') return existing ? json(existing) : json({}, 404)
    if (init.body instanceof FormData) {
      expect(init.body.get('captureUuid')).toBe(input().uuid)
      expect(init.body.get('stepId')).toMatch(/^step-[12]$/)
      expect(init.body.get('kind')).toMatch(/^(original|rendered)$/)
      expect((init.body.get('file') as Blob).size).toBe(12)
      afterStage?.()
      return json({ key: `pending-${calls.length}.png` }, 201)
    }
    const guide = guideSchema.parse(JSON.parse(init.body as string))
    if (!blobUpload)
      for (const step of guide.steps)
        step.screenshot = {
          ...step.screenshot!,
          original: 'stored-original.png',
          rendered: 'stored-rendered.png',
        }
    return json({ guide, editUrl: '/tenant/g/capture-stream/edit' }, 201)
  })
  const open = () =>
    CaptureHttpClient.open('https://server.test/tenant', {
      token,
      fetch: fetcher,
    })
  return {
    calls,
    token,
    fetcher,
    open,
    existing: (value: Guide) => {
      existing = value
    },
    afterStage: (run: () => void) => {
      afterStage = run
    },
  }
}
const images: CaptureImageProvider = async () => ({
  original: file,
  rendered: file,
  width: 1,
  height: 1,
})

describe('sequential capture staging', () => {
  it('isolates provider metadata mutations from the validated guide', async () => {
    const f = fixture(),
      client = await f.open()
    try {
      await client.uploadPrepared(input(), async (step, index) => {
        step.action = 'fill'
        step.value = { kind: 'literal', literal: 'PRIVATE_PROVIDER_VALUE' }
        return images(step, index)
      })
      const body = f.calls.at(-1)!.init.body as string
      expect(body).not.toContain('PRIVATE_PROVIDER_VALUE')
      expect(
        guideSchema
          .parse(JSON.parse(body))
          .steps.every((step) => step.value === undefined),
      ).toBe(true)
    } finally {
      client.close()
    }
  })
  it.each([true, false])(
    'does not persist intent if image preparation fails before any upload (blob support %s)',
    async (support) => {
      const f = fixture(support),
        client = await f.open(),
        before = vi.fn()
      try {
        await expect(
          client.uploadPrepared(
            input(),
            async () => {
              throw new Error('PRIVATE_IMAGE_FAILURE')
            },
            before,
          ),
        ).rejects.toMatchObject({ code: 'invalid_blob' })
        expect(before).not.toHaveBeenCalled()
        expect(f.calls.some((call) => call.init.method === 'POST')).toBe(false)
      } finally {
        client.close()
      }
    },
  )
  it('persists intent once, prepares each pair only after the previous uploads and posts metadata only', async () => {
    const f = fixture(),
      client = await f.open()
    const before = vi.fn(async () => {
      expect(f.calls).toHaveLength(2)
    })
    const provider = vi.fn<CaptureImageProvider>(async (_step, index) => {
      expect(
        f.calls.filter((call) => call.init.body instanceof FormData),
      ).toHaveLength(index * 2)
      expect(before).toHaveBeenCalledTimes(index === 0 ? 0 : 1)
      return images(_step, index)
    })
    try {
      const result = await client.uploadPrepared(input(), provider, before)
      expect(provider).toHaveBeenCalledTimes(2)
      expect(
        result.guide.steps.every((step) =>
          step.screenshot!.rendered.startsWith('pending-'),
        ),
      ).toBe(true)
      expect(f.calls.at(-1)!.init.body).not.toMatch(/PRIVATE|data:/)
      expect(f.calls.map((call) => call.init.method)).toEqual([
        'GET',
        'GET',
        'POST',
        'POST',
        'POST',
        'POST',
        'POST',
      ])
      expect(f.token).toHaveBeenCalledTimes(6)
      for (const call of f.calls) expect(call.init.credentials).toBe('omit')
      expect(JSON.stringify(client)).not.toMatch(
        /sd_fresh|PRIVATE|SOURCE|RENDER|server\.test/,
      )
    } finally {
      client.close()
    }
  })
  it.each([true, false])(
    'preserves a caller intent/guard failure without sending a write (blob support %s)',
    async (support) => {
      const f = fixture(support),
        client = await f.open(),
        failure = new Error('Durable intent failed')
      try {
        await expect(
          client.uploadPrepared(input(), images, async () => {
            throw failure
          }),
        ).rejects.toBe(failure)
        expect(f.calls.some((call) => call.init.method === 'POST')).toBe(false)
      } finally {
        client.close()
      }
    },
  )
  it('recovers an existing later editor revision without preparing or uploading any image', async () => {
    const f = fixture(),
      saved = input()
    saved.version = 3
    for (const step of saved.steps)
      step.screenshot = {
        ...step.screenshot!,
        original: 'original.png',
        rendered: 'rendered.png',
      }
    f.existing(saved)
    const client = await f.open(),
      provider = vi.fn(images),
      before = vi.fn()
    try {
      expect(
        (await client.uploadPrepared(input(), provider, before)).guide.version,
      ).toBe(3)
      expect(provider).not.toHaveBeenCalled()
      expect(before).not.toHaveBeenCalled()
      expect(f.calls).toHaveLength(2)
    } finally {
      client.close()
    }
  })
  it('stops after cancellation between staged images and never commits a partial guide', async () => {
    const f = fixture(),
      client = await f.open()
    f.afterStage(() => client.close())
    await expect(client.uploadPrepared(input(), images)).rejects.toMatchObject({
      code: 'closed',
    })
    expect(
      f.calls.filter((call) => call.init.body instanceof FormData),
    ).toHaveLength(1)
    expect(f.calls.some((call) => call.path.endsWith('/sessions'))).toBe(false)
  })
  it('rejects typed literals and unresolved masks before lookup or provider access', async () => {
    const f = fixture(),
      client = await f.open(),
      provider = vi.fn(images)
    try {
      const literal = input()
      literal.steps[0]!.action = 'fill'
      literal.steps[0]!.value = { kind: 'literal', literal: 'PRIVATE_TYPED' }
      await expect(
        client.uploadPrepared(literal, provider),
      ).rejects.toMatchObject({ code: 'invalid_guide' })
      const open = input()
      open.steps[0]!.redactions.push({
        kind: 'field',
        source: 'auto',
        status: 'open',
        rect: { x: 0, y: 0, width: 1, height: 1 },
      })
      await expect(client.uploadPrepared(open, provider)).rejects.toMatchObject(
        { code: 'redaction_open' },
      )
      expect(f.token).not.toHaveBeenCalled()
      expect(provider).not.toHaveBeenCalled()
    } finally {
      client.close()
    }
  })
  it('falls back to bounded inline transport for older servers without blob staging', async () => {
    const f = fixture(false),
      client = await f.open()
    try {
      await client.uploadPrepared(input(), images)
      expect(f.calls.some((call) => call.init.body instanceof FormData)).toBe(
        false,
      )
      const sent = guideSchema.parse(
        JSON.parse(f.calls.at(-1)!.init.body as string),
      )
      expect(sent.steps[0]!.screenshot!.original).toMatch(
        /^data:image\/png;base64,/,
      )
    } finally {
      client.close()
    }
  })
  it('refuses an untrusted staging response before commit', async () => {
    const f = fixture(),
      original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (url, init) =>
      init?.body instanceof FormData
        ? json({ key: 'data:image/png;base64,PRIVATE' }, 201)
        : original(url, init),
    )
    const client = await f.open()
    try {
      await expect(
        client.uploadPrepared(input(), images),
      ).rejects.toMatchObject({ code: 'corrupt_data' })
      expect(f.calls.some((call) => call.path.endsWith('/sessions'))).toBe(
        false,
      )
    } finally {
      client.close()
    }
  })
})

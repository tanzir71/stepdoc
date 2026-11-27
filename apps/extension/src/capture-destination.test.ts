import { afterEach, describe, expect, it, vi } from 'vitest'
import { guideSchema } from '@stepdoc/schema'
import {
  CaptureDestinations,
  DestinationFailure,
  destinationChoice,
} from './capture-destination'
import {
  captureDestinationSchema,
  captureSaveCommandSchema,
} from '@stepdoc/schema/capture-destination'
import type { ConnectionVaultState } from '@stepdoc/schema/pairing'
import type { ConnectionVault } from './connection-vault'
import { captureUploadSource, type CaptureDraft } from './review'

vi.mock('./review', () => ({ captureUploadSource: vi.fn() }))
const session = '123e4567-e89b-42d3-a456-426614174001'
const png = 'data:image/png;base64,iVBORw0KGgoAAAAA'
const guide = () =>
  guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id: `capture-${session}`,
    uuid: session,
    title: 'Capture',
    steps: [
      {
        id: 'one',
        index: 1,
        type: 'manual',
        title: 'Open settings',
        screenshot: { original: png, rendered: png, width: 1, height: 1 },
      },
    ],
    version: 1,
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
  })
const draft: CaptureDraft = {
  sessionId: session,
  title: 'Capture',
  steps: [],
  images: [],
  startedAt: '2026-11-26T00:00:00Z',
  startedUrl: 'https://source.test',
}
function setup() {
  const state: ConnectionVaultState = {
    version: 1,
    generation: crypto.randomUUID(),
    connection: {
      server: 'https://server.test/ops/api/v1/',
      deviceId: 'device-one',
      deviceName: 'Fixture',
      token: 'sd_PRIVATE_fixture',
      scopes: ['capture:write', 'guides:read'],
      status: 'ready',
      pairedAt: '2026-11-26T00:00:00Z',
      checkedAt: null,
    },
  }
  const vault: ConnectionVault = {
    read: vi.fn(async () => structuredClone(state)),
    write: vi.fn(),
    forget: vi.fn(),
  }
  const choice = {
    kind: 'server' as const,
    server: state.connection!.server,
    deviceId: state.connection!.deviceId,
    generation: state.generation,
  }
  const controller = new CaptureDestinations(vault)
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.mocked(captureUploadSource).mockReturnValue({
    guide: guide(),
    images: async () => {
      const file = new Blob(
        [
          Uint8Array.from(atob(png.split(',')[1]!), (char) =>
            char.charCodeAt(0),
          ),
        ],
        { type: 'image/png' },
      )
      return { original: file, rendered: file, width: 1, height: 1 }
    },
  })
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  const fetcher = vi.fn<typeof fetch>(async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/health'))
      return json({
        target: 'node-postgres',
        version: 'fixture',
        schema: 'stepdoc/guide@1',
        capabilities: { maxUploadBytes: 1000 },
      })
    if (init.method === 'GET') return json({}, 404)
    const stored = guide()
    stored.steps[0]!.screenshot!.original = 'stored/original'
    stored.steps[0]!.screenshot!.rendered = 'stored/rendered'
    return json({ guide: stored, editUrl: `/ops/g/${stored.id}/edit` }, 201)
  })
  vi.stubGlobal('fetch', fetcher)
  const operation = {
    signal: new AbortController().signal,
    guard: vi.fn(async () => {}),
    started: vi.fn(async () => {}),
  }
  return { state, vault, choice, controller, calls, fetcher, operation }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
describe('private capture destination binding', () => {
  it('defaults older captures to local and rejects unexpected credential fields', () => {
    expect(destinationChoice(undefined)).toEqual({ kind: 'browser' })
    expect(
      captureDestinationSchema.safeParse({ kind: 'browser', token: 'PRIVATE' })
        .success,
    ).toBe(false)
    expect(
      captureSaveCommandSchema.safeParse({
        type: 'SAVE_CAPTURE',
        keepLocal: true,
        token: 'PRIVATE',
      }).success,
    ).toBe(false)
  })
  it('allows local recovery without reading an unavailable vault', async () => {
    const f = setup()
    vi.mocked(f.vault.read).mockRejectedValue(new Error('PRIVATE'))
    expect(await f.controller.validate({ kind: 'browser' })).toEqual({
      kind: 'browser',
    })
    expect(f.vault.read).not.toHaveBeenCalled()
  })
  it.each(['generation', 'server', 'deviceId'] as const)(
    'binds the exact %s before obtaining a credential',
    async (key) => {
      const f = setup()
      const choice = {
        ...f.choice,
        [key]: key === 'generation' ? crypto.randomUUID() : 'other',
      }
      await expect(f.controller.validate(choice)).rejects.toMatchObject({
        code: 'connection_changed',
      })
      expect(f.calls).toHaveLength(0)
    },
  )
  it.each(['paired', 'ready', 'unavailable'] as const)(
    'retains an authorized destination while status is %s',
    async (status) => {
      const f = setup()
      f.state.connection!.status = status
      expect(await f.controller.validate(f.choice)).toEqual(f.choice)
    },
  )
  it('refuses a revoked or absent connection before network access', async () => {
    const f = setup()
    f.state.connection!.status = 'revoked'
    await expect(
      f.controller.upload(draft, f.choice, f.operation),
    ).rejects.toMatchObject({ code: 'revoked' })
    f.state.connection = null
    await expect(
      f.controller.upload(draft, f.choice, f.operation),
    ).rejects.toMatchObject({ code: 'no_connection' })
    expect(f.calls).toHaveLength(0)
  })
  it('prepares pixels, records pending-write intent and returns only a metadata receipt', async () => {
    const f = setup()
    f.operation.started.mockImplementation(async () => {
      expect(f.calls.map((call) => call.init.method)).toEqual(['GET', 'GET'])
    })
    const receipt = await f.controller.upload(draft, f.choice, f.operation)
    expect(captureUploadSource).toHaveBeenCalledOnce()
    expect(f.operation.started).toHaveBeenCalledOnce()
    expect(receipt).toEqual({ id: guide().id, destination: f.choice })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE')
    expect(await f.controller.editor(receipt, session)).toBe(
      `https://server.test/ops/g/${guide().id}/edit`,
    )
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(
      1,
    )
  })
  it('revalidates the private vault after public health and never posts to a changed connection', async () => {
    const f = setup(),
      original = f.fetcher.getMockImplementation()!
    f.fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init)
      if (String(url).endsWith('/health'))
        f.state.generation = crypto.randomUUID()
      return response
    })
    await expect(
      f.controller.upload(draft, f.choice, f.operation),
    ).rejects.toMatchObject({ code: 'connection_changed' })
    expect(f.calls).toHaveLength(1)
    expect(f.operation.started).not.toHaveBeenCalled()
  })
  it('does not mark an upload attempt when image preparation fails', async () => {
    const f = setup()
    vi.mocked(captureUploadSource).mockImplementation(() => {
      throw new DestinationFailure('too_large')
    })
    await expect(
      f.controller.upload(draft, f.choice, f.operation),
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(f.calls).toHaveLength(0)
    expect(f.operation.started).not.toHaveBeenCalled()
  })
  it('does not send a write when the current capture or durable intent guard fails', async () => {
    const f = setup()
    f.operation.started.mockRejectedValue(new DestinationFailure('stale'))
    await expect(
      f.controller.upload(draft, f.choice, f.operation),
    ).rejects.toMatchObject({ code: 'stale' })
    expect(f.calls.filter((call) => call.init.method === 'POST')).toHaveLength(
      0,
    )
  })
  it('does not resume after cancellation', async () => {
    const f = setup(),
      controller = new AbortController()
    controller.abort()
    await expect(
      f.controller.upload(draft, f.choice, {
        ...f.operation,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.calls).toHaveLength(0)
  })
  it('never opens a receipt from another capture or an untrusted URL field', async () => {
    const f = setup()
    await expect(
      f.controller.editor(
        { id: 'other-guide', destination: f.choice },
        session,
      ),
    ).rejects.toMatchObject({ code: 'stale' })
    await expect(
      f.controller.editor(
        {
          id: guide().id,
          destination: f.choice,
          editUrl: 'https://foreign.test/PRIVATE',
        } as never,
        session,
      ),
    ).rejects.toMatchObject({ code: 'stale' })
    expect(f.calls).toHaveLength(0)
  })
})

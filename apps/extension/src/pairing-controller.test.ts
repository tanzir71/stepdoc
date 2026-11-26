import { describe, it, expect, vi, afterEach } from 'vitest'
import { PairingController } from './pairing-controller'
import { PairingFailure, type ConnectionVault } from './connection-vault'
import {
  connectionVaultSchema,
  pairingCommandSchema,
  pairingStateSchema,
  type ConnectionVaultState,
  type PrivateConnection,
  type PairingState,
} from '@stepdoc/schema/pairing'

const secret = 'sd_fixture_private_pairing_credential'
const code = 'K7Q-4MX'
const health = {
  target: 'node-postgres',
  version: 'fixture',
  schema: 'stepdoc/guide@1',
  capabilities: { maxUploadBytes: 1000 },
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
class MemoryVault implements ConnectionVault {
  value: ConnectionVaultState = {
    version: 1,
    generation: crypto.randomUUID(),
    connection: null,
  }
  fail = false
  async read() {
    if (this.fail) throw new PairingFailure('storage_unavailable')
    return structuredClone(this.value)
  }
  async write(
    expected: string,
    connection: PrivateConnection,
    guard: () => boolean,
  ) {
    if (expected !== this.value.generation) throw new PairingFailure('conflict')
    if (!guard()) throw new PairingFailure('cancelled')
    this.value = {
      version: 1,
      generation: crypto.randomUUID(),
      connection: structuredClone(connection),
    }
    return this.read()
  }
  async forget(expected: string | null, guard: () => boolean) {
    if (expected !== this.value.generation) throw new PairingFailure('conflict')
    if (!guard()) throw new PairingFailure('cancelled')
    this.value = {
      version: 1,
      generation: crypto.randomUUID(),
      connection: null,
    }
    return this.read()
  }
}
function setup() {
  const vault = new MemoryVault(),
    events: PairingState[] = [],
    canChange = vi.fn(async () => true)
  const controller = new PairingController({
    vault,
    extensionId: 'registered-browser',
    deviceName: 'StepDoc fixture',
    canChange,
    changed: (state) => {
      events.push(state)
    },
  })
  return { vault, events, canChange, controller }
}
function network(claimStatus = 201, readStatus = 200) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    return url.endsWith('/health')
      ? json(health)
      : url.endsWith('/pairing/claim')
        ? json(
            {
              id: 'fixture-device',
              token: secret,
              scopes: ['capture:write', 'guides:read'],
            },
            claimStatus,
          )
        : json({ items: [], nextCursor: null }, readStatus)
  })
}
async function connect(
  f: ReturnType<typeof setup>,
  attemptId = crypto.randomUUID(),
) {
  return f.controller.handle({
    type: 'PAIR_CONNECT',
    attemptId,
    expectedGeneration: f.vault.value.generation,
    server: 'https://ops.example',
    code,
  })
}
afterEach(() => vi.restoreAllMocks())

describe('private pairing protocol and controller', () => {
  it('persists only the explicit credential record and projects no token/code', async () => {
    network()
    const f = setup()
    expect(await connect(f)).toEqual({ ok: true })
    expect(f.vault.value.connection?.token).toBe(secret)
    expect(f.vault.value.connection?.server).toBe('https://ops.example/api/v1/')
    const state = await f.controller.state()
    expect(state.connection?.status).toBe('paired')
    expect(JSON.stringify(state)).not.toContain(secret)
    expect(JSON.stringify(state)).not.toContain(code)
    expect(connectionVaultSchema.safeParse(f.vault.value).success).toBe(true)
    expect(
      pairingStateSchema.safeParse({ ...state, token: secret }).success,
    ).toBe(false)
  })
  it('validates read access, keeps a revoked credential recoverable and can forget it', async () => {
    const fetcher = network()
    const f = setup()
    await connect(f)
    const check = () =>
      f.controller.handle({
        type: 'PAIR_TEST',
        attemptId: crypto.randomUUID(),
        expectedGeneration: f.vault.value.generation,
      })
    expect(await check()).toEqual({ ok: true })
    expect(f.vault.value.connection?.status).toBe('ready')
    fetcher.mockImplementation(async (input) =>
      String(input).endsWith('/health')
        ? json(health)
        : json({ error: { code: 'revoked', message: 'PRIVATE_SERVER' } }, 401),
    )
    expect(await check()).toEqual({ ok: false, error: 'revoked' })
    expect(f.vault.value.connection?.status).toBe('revoked')
    expect(f.vault.value.connection?.token).toBe(secret)
    expect(
      await f.controller.handle({
        type: 'PAIR_FORGET',
        expectedGeneration: f.vault.value.generation,
      }),
    ).toEqual({ ok: true })
    expect(f.vault.value.connection).toBeNull()
    expect(JSON.stringify(await f.controller.state())).not.toContain(secret)
  })
  it('does not consume a code while capture/another private operation is active', async () => {
    const fetcher = network(),
      f = setup()
    f.canChange.mockResolvedValue(false)
    expect(await connect(f)).toEqual({ ok: false, error: 'busy' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(f.vault.value.connection).toBeNull()
  })
  it('reserves forgetting before its asynchronous capture guard', async () => {
    const f = setup(),
      fetcher = network()
    let release: (allowed: boolean) => void = () => {}
    f.canChange.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const forgetting = f.controller.handle({
      type: 'PAIR_FORGET',
      expectedGeneration: f.vault.value.generation,
    })
    expect(f.controller.busy).toBe(true)
    expect(await connect(f)).toEqual({ ok: false, error: 'busy' })
    expect(
      await f.controller.handle({
        type: 'PAIR_FORGET',
        expectedGeneration: f.vault.value.generation,
      }),
    ).toEqual({ ok: false, error: 'busy' })
    expect(fetcher).not.toHaveBeenCalled()
    release(true)
    expect(await forgetting).toEqual({ ok: true })
    expect(f.controller.busy).toBe(false)
  })
  it('rejects stale generations before claim and retains an earlier connection on a bad code', async () => {
    const fetcher = network(),
      f = setup()
    await connect(f)
    const previous = structuredClone(f.vault.value)
    fetcher.mockClear()
    expect(
      await f.controller.handle({
        type: 'PAIR_CONNECT',
        attemptId: crypto.randomUUID(),
        expectedGeneration: crypto.randomUUID(),
        server: 'https://ops.example',
        code,
      }),
    ).toEqual({ ok: false, error: 'conflict' })
    expect(fetcher).not.toHaveBeenCalled()
    network(400)
    expect(await connect(f)).toEqual({ ok: false, error: 'invalid_code' })
    expect(f.vault.value).toEqual(previous)
  })
  it('cancels a pending exchange immediately and cannot store a late response', async () => {
    let reply: (value: Response) => void = () => {}
    const fetcher = network(),
      f = setup(),
      attemptId = crypto.randomUUID()
    fetcher.mockImplementation(async (input) =>
      String(input).endsWith('/health')
        ? json(health)
        : new Promise((resolve) => {
            reply = resolve
          }),
    )
    const pending = connect(f, attemptId)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(
      await f.controller.handle({ type: 'PAIR_CANCEL', attemptId }),
    ).toEqual({ ok: true })
    expect(await pending).toEqual({ ok: false, error: 'cancelled' })
    reply(
      json(
        {
          id: 'late-device',
          token: secret,
          scopes: ['capture:write', 'guides:read'],
        },
        201,
      ),
    )
    await Promise.resolve()
    expect(f.vault.value.connection).toBeNull()
    expect(f.controller.busy).toBe(false)
  })
  it('keeps one concurrent attempt and protects a newer generation at commit', async () => {
    let reply: (value: Response) => void = () => {}
    const fetcher = network(),
      f = setup()
    fetcher.mockImplementation(async (input) =>
      String(input).endsWith('/health')
        ? json(health)
        : new Promise((resolve) => {
            reply = resolve
          }),
    )
    const pending = connect(f)
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(await connect(f)).toEqual({ ok: false, error: 'busy' })
    f.vault.value.generation = crypto.randomUUID()
    reply(
      json(
        {
          id: 'late-device',
          token: secret,
          scopes: ['capture:write', 'guides:read'],
        },
        201,
      ),
    )
    expect(await pending).toEqual({ ok: false, error: 'conflict' })
    expect(f.vault.value.connection).toBeNull()
  })
  it('reports corrupt/unavailable vault state without any credential metadata', async () => {
    const f = setup()
    f.vault.fail = true
    expect(await f.controller.state()).toMatchObject({
      generation: null,
      connection: null,
      error: 'storage_unavailable',
    })
    expect(await connect(f)).toEqual({
      ok: false,
      error: 'storage_unavailable',
    })
    f.vault.fail = false
    expect(await f.controller.handle({ type: 'PAIR_STATUS' })).toMatchObject({
      ok: true,
      state: { generation: f.vault.value.generation, error: null },
    })
  })
  it('rejects unexpected transport fields and keeps pending state free of code data', async () => {
    const f = setup()
    expect(
      pairingCommandSchema.safeParse({ type: 'PAIR_STATUS', token: secret })
        .success,
    ).toBe(false)
    expect(
      pairingCommandSchema.safeParse({
        type: 'PAIR_CONNECT',
        attemptId: crypto.randomUUID(),
        expectedGeneration: f.vault.value.generation,
        server: 'https://ops.example',
        code,
        value: 'PRIVATE_TYPED',
      }).success,
    ).toBe(false)
    expect(
      await f.controller.handle({
        type: 'PAIR_CANCEL',
        attemptId: crypto.randomUUID(),
      }),
    ).toEqual({ ok: false, error: 'conflict' })
  })
})

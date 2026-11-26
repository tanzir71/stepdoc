import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Narrator,
  type LocalRecognition,
  type SpeechResultEvent,
  type NarrationStatus,
} from './narration'
import { narrationText } from './narration-text'

class Speech implements LocalRecognition {
  static instances: Speech[] = []
  static available = vi.fn(async () => 'available')
  static install = vi.fn(async () => true)
  processLocally = false
  continuous = false
  interimResults = true
  lang = ''
  onstart: (() => void) | null = null
  onspeechstart: (() => void) | null = null
  onresult: ((event: SpeechResultEvent) => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  start = vi.fn(() => this.onstart?.())
  abort = vi.fn()
  constructor() {
    Speech.instances.push(this)
  }
  result(text: string, index = 0, isFinal = true) {
    this.onresult?.({
      resultIndex: index,
      results: Array.from({ length: index + 1 }, () => ({
        isFinal,
        0: { transcript: text },
      })),
    })
  }
}
const sessionId = '11111111-1111-4111-8111-111111111111'
const context = {
  phase: 'recording',
  enabled: true,
  sessionId,
  stepId: 'first',
}
const narrators: Narrator[] = []
function setup(supported = true) {
  const calls: Record<string, unknown>[] = [],
    statuses: NarrationStatus[] = []
  const rpc = vi.fn(async (command: Record<string, unknown>) => {
    calls.push(command)
    return { ok: true }
  })
  const narrator = new Narrator(supported ? Speech : undefined, rpc, (status) =>
    statuses.push(status),
  )
  narrators.push(narrator)
  return { narrator, calls, rpc, statuses }
}
afterEach(() => {
  narrators.splice(0).forEach((narrator) => narrator.cancel())
  Speech.instances = []
  Speech.available.mockReset().mockResolvedValue('available')
  Speech.install.mockReset().mockResolvedValue(true)
  vi.useRealTimers()
})
async function ready() {
  const result = setup()
  result.narrator.sync(context)
  expect(Speech.instances).toHaveLength(0)
  await result.narrator.prepare('en-US')
  await Promise.resolve()
  return { ...result, speech: Speech.instances.at(-1)! }
}
describe('private on-device narration', () => {
  it('defaults to no recognition and requires explicit local-only setup', async () => {
    const { speech } = await ready()
    expect(Speech.install).toHaveBeenCalledWith({
      langs: ['en-US'],
      processLocally: true,
    })
    expect(Speech.available).toHaveBeenCalledWith({
      langs: ['en-US'],
      processLocally: true,
    })
    expect(speech.processLocally).toBe(true)
    expect(speech.interimResults).toBe(false)
    expect(speech.continuous).toBe(true)
    expect(speech.start).toHaveBeenCalledOnce()
  })
  it('redacts final speech before transport, ignores interim/duplicate results and pins the utterance to its first step', async () => {
    const { narrator, speech, calls } = await ready()
    speech.onspeechstart!()
    speech.result('INTERIM_PRIVATE', 0, false)
    narrator.sync({ ...context, stepId: 'second' })
    speech.result('Send to private@example.test with card 4111 1111 1111 1111')
    speech.result('DUPLICATE_PRIVATE')
    await Promise.resolve()
    expect(
      calls.filter((command) => command.type === 'NARRATION_APPEND'),
    ).toEqual([
      expect.objectContaining({
        stepId: 'first',
        sequence: 1,
        text: 'Send to [REDACTED] with card [REDACTED]',
      }),
    ])
    expect(JSON.stringify(calls)).not.toMatch(
      /INTERIM_PRIVATE|DUPLICATE_PRIVATE|private@example|4111 1111/,
    )
  })
  it('requires an actual speech boundary and a captured step', async () => {
    const { narrator, speech, calls, statuses } = await ready()
    speech.result('No speech boundary')
    narrator.sync({ ...context, stepId: undefined })
    speech.onspeechstart!()
    speech.result('No step', 1)
    expect(calls.some((command) => command.type === 'NARRATION_APPEND')).toBe(
      false,
    )
    expect(statuses.at(-1)).toBe('skipped')
  })
  it.each(['pausing', 'paused', 'stopping', 'review', 'idle'])(
    'aborts immediately at %s and ignores late final events',
    async (phase) => {
      const { narrator, speech, calls } = await ready()
      speech.onspeechstart!()
      const late = speech.onresult!
      narrator.sync({ ...context, phase })
      expect(speech.abort).toHaveBeenCalledOnce()
      late({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: 'LATE_PRIVATE' } }],
      })
      expect(calls.some((command) => command.type === 'NARRATION_APPEND')).toBe(
        false,
      )
    },
  )
  it('resumes only an armed session and does not resume on reload', async () => {
    const { narrator, speech } = await ready()
    narrator.sync({ ...context, phase: 'paused' })
    narrator.sync(context)
    await Promise.resolve()
    expect(Speech.instances).toHaveLength(2)
    expect(speech.abort).toHaveBeenCalledOnce()
    const fresh = setup()
    fresh.narrator.sync(context)
    expect(Speech.instances).toHaveLength(2)
  })
  it('cancels pending language setup without starting the microphone', async () => {
    let resolve!: (ready: boolean) => void
    Speech.install.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const { narrator } = setup()
    narrator.sync(context)
    const pending = narrator.prepare('en-US')
    narrator.cancel()
    resolve(true)
    expect(await pending).toBe(false)
    expect(Speech.instances).toHaveLength(0)
  })
  it('invalidates pending setup when capture ends, and never arms a later session', async () => {
    let resolve!: (ready: boolean) => void
    Speech.install.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const { narrator } = setup()
    narrator.sync(context)
    const pending = narrator.prepare('en-US')
    narrator.sync({ ...context, phase: 'review' })
    resolve(true)
    expect(await pending).toBe(false)
    narrator.sync({ ...context, sessionId: crypto.randomUUID() })
    expect(Speech.instances).toHaveLength(0)
  })
  it('revokes armed consent when a session changes without a fresh preparation', async () => {
    const { narrator, speech } = await ready()
    narrator.sync({ ...context, sessionId: crypto.randomUUID() })
    await Promise.resolve()
    expect(speech.abort).toHaveBeenCalledOnce()
    expect(Speech.instances).toHaveLength(1)
  })
  it('handles a synchronous extension-context invalidation during release', async () => {
    const { narrator, rpc, speech } = await ready()
    rpc.mockImplementationOnce(() => {
      throw new Error('PRIVATE_CONTEXT_ERROR')
    })
    expect(() => narrator.cancel()).not.toThrow()
    expect(speech.abort).toHaveBeenCalledOnce()
  })
  it('handles an unavailable native constructor without an unhandled rejection', async () => {
    class UnavailableSpeech extends Speech {
      constructor() {
        super()
        throw new Error('PRIVATE_NATIVE_ERROR')
      }
    }
    const statuses: NarrationStatus[] = []
    const narrator = new Narrator(
      UnavailableSpeech,
      async () => ({ ok: true }),
      (status) => statuses.push(status),
    )
    narrators.push(narrator)
    narrator.sync(context)
    await narrator.prepare('en-US')
    await Promise.resolve()
    expect(statuses.at(-1)).toBe('unavailable')
    expect(Speech.instances[0]!.start).not.toHaveBeenCalled()
  })
  it.each(['unavailable', 'downloading', 'downloadable'])(
    'never falls back to remote recognition when %s',
    async (availability) => {
      Speech.available.mockResolvedValueOnce(availability)
      const { narrator, statuses } = setup()
      narrator.sync(context)
      expect(await narrator.prepare('en-US')).toBe(false)
      expect(Speech.instances).toHaveLength(0)
      expect(statuses.at(-1)).toBe('unavailable')
    },
  )
  it('reports unsupported browsers, denied installation and invalid language tags safely', async () => {
    const unsupported = setup(false)
    expect(await unsupported.narrator.prepare('en-US')).toBe(false)
    expect(unsupported.statuses.at(-1)).toBe('unsupported')
    const denied = setup()
    Speech.install.mockRejectedValueOnce(new Error('PRIVATE_SERVICE_ERROR'))
    expect(await denied.narrator.prepare('en-US')).toBe(false)
    expect(await denied.narrator.prepare('invalid_!')).toBe(false)
    expect(denied.statuses.at(-1)).toBe('unavailable')
  })
  it('stops after microphone errors, owner conflicts or failed writes', async () => {
    const { speech, narrator, rpc, statuses } = await ready()
    speech.onerror!({ error: 'not-allowed PRIVATE_ERROR' })
    expect(speech.abort).toHaveBeenCalledOnce()
    expect(statuses.at(-1)).toBe('failed')
    rpc.mockResolvedValueOnce({ ok: false })
    await narrator.prepare('en-US')
    await Promise.resolve()
    expect(statuses.at(-1)).toBe('busy')
    await narrator.prepare('en-US')
    await Promise.resolve()
    const next = Speech.instances.at(-1)!
    rpc.mockResolvedValueOnce({ ok: false })
    next.onspeechstart!()
    next.result('A note')
    await Promise.resolve()
    expect(statuses.at(-1)).toBe('failed')
  })
  it('renews ownership and restarts a normal recognition end without retaining old transcripts', async () => {
    vi.useFakeTimers()
    const { speech, calls } = await ready()
    await vi.advanceTimersByTimeAsync(2500)
    expect(
      calls.filter((command) => command.type === 'NARRATION_CLAIM'),
    ).toHaveLength(2)
    speech.onend!()
    await vi.advanceTimersByTimeAsync(750)
    expect(Speech.instances).toHaveLength(2)
    expect(speech.onresult).toBeNull()
  })
  it('rejects oversized/empty transcripts instead of retaining a partially redacted value', () => {
    expect(narrationText('x'.repeat(4001))).toBeNull()
    expect(narrationText(' \n ')).toBeNull()
    expect(narrationText('Use\u0000the settings')).toBe('Use the settings')
    expect(
      narrationText('token ghp_1234567890abcdefghijklmnopqrstuvwxyz'),
    ).not.toContain('ghp_')
  })
})

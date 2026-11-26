import { narrationText } from './narration-text'

// Deliberately require the local-only API; the prefixed cloud API is not a fallback.
export interface SpeechResultEvent {
  resultIndex: number
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
}
export interface LocalRecognition {
  processLocally: boolean
  continuous: boolean
  interimResults: boolean
  lang: string
  onstart: (() => void) | null
  onspeechstart: (() => void) | null
  onresult: ((event: SpeechResultEvent) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  abort(): void
}
export interface LocalSpeechConstructor {
  new (): LocalRecognition
  prototype: LocalRecognition
  available(options: { langs: string[]; processLocally: true }): Promise<string>
  install(options: { langs: string[]; processLocally: true }): Promise<boolean>
}
export interface NarrationContext {
  phase: string
  enabled: boolean
  sessionId?: string
  stepId?: string
}
export const narrationMessages = {
  off: 'Narration is off.',
  cancelled: 'Narration is off.',
  unsupported:
    'On-device speech recognition is unavailable in this browser. Capture still works.',
  preparing: 'Preparing on-device speech recognition…',
  ready: 'Narration is ready. Speak after a step appears to add notes.',
  listening:
    'Listening on this device. Speak after a step appears to add notes.',
  paused: 'Narration is paused.',
  unavailable:
    'Narration could not start. Check microphone permission and the language pack, then retry.',
  busy: 'Narration is active in another controls window. Close it before retrying.',
  failed:
    'Narration stopped. The capture is retained; start narration to retry.',
  added: 'Narration added to step notes.',
  skipped: 'Speech was not saved. Speak after a captured step appears.',
} as const
export type NarrationStatus = keyof typeof narrationMessages

export function localSpeech(): LocalSpeechConstructor | undefined {
  const Constructor = (
    globalThis as unknown as { SpeechRecognition?: LocalSpeechConstructor }
  ).SpeechRecognition
  return Constructor &&
    typeof Constructor.available === 'function' &&
    typeof Constructor.install === 'function' &&
    'processLocally' in Constructor.prototype
    ? Constructor
    : undefined
}

/** One controls document owns the microphone. Closing it synchronously aborts recognition. */
export class Narrator {
  readonly owner = crypto.randomUUID()
  private context: NarrationContext = { phase: 'idle', enabled: false }
  private armed = false
  private armedSession?: string
  private preparing = false
  private generation = 0
  private sequence = 0
  private recognition?: LocalRecognition
  private heartbeat?: ReturnType<typeof setInterval>
  private restart?: ReturnType<typeof setTimeout>
  private language = 'en-US'
  constructor(
    private readonly Constructor: LocalSpeechConstructor | undefined,
    private readonly rpc: (
      command: Record<string, unknown>,
    ) => Promise<{ ok: boolean }>,
    private readonly status: (status: NarrationStatus) => void,
  ) {}
  private send(command: Record<string, unknown>): Promise<{ ok: boolean }> {
    try {
      return this.rpc(command)
    } catch {
      return Promise.resolve({ ok: false })
    }
  }
  async prepare(language: string): Promise<boolean> {
    this.armed = false
    this.armedSession = undefined
    this.stop()
    const generation = ++this.generation
    if (!this.Constructor) {
      this.status('unsupported')
      return false
    }
    try {
      this.language = Intl.getCanonicalLocales(language)[0]!
    } catch {
      this.status('unavailable')
      return false
    }
    if (!this.language) {
      this.status('unavailable')
      return false
    }
    this.preparing = true
    this.status('preparing')
    try {
      // Called directly from an explicit button: install may require user activation.
      const options = { langs: [this.language], processLocally: true as const }
      const installed = await this.Constructor.install(options)
      if (generation !== this.generation) return false
      if (
        !installed ||
        (await this.Constructor.available(options)) !== 'available'
      )
        throw new Error('Unavailable')
      if (generation !== this.generation) return false
      this.armed = true
      this.status('ready')
      void this.listen()
      return true
    } catch {
      if (generation === this.generation) this.status('unavailable')
      return false
    } finally {
      if (generation === this.generation) this.preparing = false
    }
  }
  sync(context: NarrationContext) {
    const previous = this.context
    this.context = context
    if (this.armedSession && context.sessionId !== this.armedSession)
      this.cancel()
    if (
      !context.enabled ||
      ['idle', 'review', 'saving'].includes(context.phase)
    ) {
      if (
        !context.enabled ||
        context.phase !== 'idle' ||
        previous.phase !== 'idle'
      )
        this.cancel()
      else if (!this.preparing) this.armed = false
      this.stop()
      return
    }
    if (
      context.phase !== 'recording' ||
      context.sessionId !== previous.sessionId
    ) {
      this.stop()
      if (context.phase === 'paused' || context.phase === 'pausing')
        this.status('paused')
    }
    if (context.phase === 'recording') void this.listen()
  }
  private async listen() {
    if (
      !this.armed ||
      !this.Constructor ||
      this.recognition ||
      this.restart ||
      this.context.phase !== 'recording' ||
      !this.context.sessionId
    )
      return
    const sessionId = this.context.sessionId
    this.armedSession = sessionId
    let recognition: LocalRecognition
    try {
      recognition = new this.Constructor()
    } catch {
      this.armed = false
      this.status('unavailable')
      return
    }
    this.recognition = recognition
    const current = () =>
      this.recognition === recognition &&
      this.armed &&
      this.context.phase === 'recording' &&
      this.context.sessionId === sessionId
    const fail = (status: NarrationStatus) => {
      if (!current()) return
      this.armed = false
      this.stop()
      this.status(status)
    }
    let target: string | undefined
    const seen = new Set<number>()
    try {
      if (!('processLocally' in recognition)) throw new Error('Unsupported')
      recognition.processLocally = true
      if (recognition.processLocally !== true) throw new Error('Unsupported')
      recognition.lang = this.language
      recognition.continuous = true
      recognition.interimResults = false
      const reply = await this.send({
        type: 'NARRATION_CLAIM',
        owner: this.owner,
        sessionId,
      })
      if (!current()) return
      if (!reply.ok) {
        fail('busy')
        return
      }
      let claiming = false
      this.heartbeat = setInterval(() => {
        if (!current() || claiming) return
        claiming = true
        void this.send({
          type: 'NARRATION_CLAIM',
          owner: this.owner,
          sessionId,
        })
          .then(
            (reply) => {
              if (!reply.ok) fail('failed')
            },
            () => fail('failed'),
          )
          .finally(() => {
            claiming = false
          })
      }, 2500)
      recognition.onstart = () => {
        if (current()) this.status('listening')
      }
      recognition.onspeechstart = () => {
        if (current()) target = this.context.stepId
      }
      recognition.onresult = (event) => {
        if (!current()) return
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i]
          if (!result?.isFinal || seen.has(i)) continue
          seen.add(i)
          const text = narrationText(result[0].transcript)
          if (!target || !text) {
            this.status('skipped')
            continue
          }
          const command = {
            type: 'NARRATION_APPEND',
            owner: this.owner,
            sessionId,
            stepId: target,
            sequence: ++this.sequence,
            text,
          }
          void this.send(command).then(
            (reply) => {
              if (current()) reply.ok ? this.status('added') : fail('failed')
            },
            () => fail('failed'),
          )
        }
      }
      recognition.onerror = () => fail('failed')
      recognition.onend = () => {
        if (!current()) return
        this.stop()
        this.restart = setTimeout(() => {
          this.restart = undefined
          void this.listen()
        }, 750)
      }
      recognition.start()
    } catch {
      fail('unavailable')
    }
  }
  private stop() {
    clearInterval(this.heartbeat)
    clearTimeout(this.restart)
    this.heartbeat = undefined
    this.restart = undefined
    const recognition = this.recognition
    this.recognition = undefined
    if (recognition) {
      recognition.onstart =
        recognition.onspeechstart =
        recognition.onresult =
        recognition.onerror =
        recognition.onend =
          null
      try {
        recognition.abort()
      } catch {}
      void this.send({ type: 'NARRATION_RELEASE', owner: this.owner }).catch(
        () => {},
      )
    }
  }
  cancel(notify = false) {
    this.generation++
    this.preparing = this.armed = false
    this.stop()
    this.status(notify ? 'cancelled' : 'off')
  }
}

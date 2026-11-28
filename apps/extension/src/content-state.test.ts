import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
import { localCaptureSchema } from '@stepdoc/schema/capture'
import { startContent } from './content'

type State = Record<string, unknown>
type Listener = (
  message: State,
  sender: State,
  respond: (value: unknown) => void,
) => boolean | void
const runtime = vi.hoisted(() => ({
  sendMessage: vi.fn<(message: State) => Promise<unknown>>(),
  addListener: vi.fn<(listener: Listener) => void>(),
}))
vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendMessage: runtime.sendMessage,
      onMessage: { addListener: runtime.addListener },
    },
  },
}))
// These tests exercise the real content listener, URL polling, metadata builder
// and sanitization. Floating UI rendering is covered in the native suites.
vi.mock('./blur-controls', () => ({
  BlurControls: class {
    update() {}
  },
}))
vi.mock('./recording-controls', () => ({
  RecordingControls: class {
    update() {}
  },
}))
vi.mock('./guide-content', () => ({
  GuideContent: class {
    install() {}
    handle() {
      return false
    }
  },
}))

describe('content recorder state and navigation ordering', () => {
  let dom: JSDOM
  let listener: Listener
  let resolveInitial: (value: State) => void
  const session = crypto.randomUUID()
  const otherSession = crypto.randomUUID()
  const state = (recording: boolean, sessionId = session): State => ({
    recording,
    captureSessionId: sessionId,
    capturePill: null,
  })
  const refresh = (recording = true, sessionId = session) =>
    listener(
      {
        type: 'STATE',
        recording,
        sessionId,
        capturePill: null,
      },
      {},
      () => {},
    )
  const navigate = (path: string) =>
    dom.window.history.pushState(null, '', path)
  const captures = () =>
    runtime.sendMessage.mock.calls
      .filter(([message]) => message.type === 'CAPTURE')
      .map(([message]) => localCaptureSchema.parse(message.event).step)

  beforeEach(() => {
    vi.useFakeTimers()
    dom = new JSDOM(
      '<!doctype html><html><head><title>Recorder fixture</title></head><body></body></html>',
      {
        url: 'https://example.test/start?PRIVATE_QUERY#PRIVATE_FRAGMENT',
      },
    )
    for (const [key, value] of Object.entries({
      window: dom.window,
      document: dom.window.document,
      MutationObserver: dom.window.MutationObserver,
      Element: dom.window.Element,
      HTMLElement: dom.window.HTMLElement,
      innerWidth: 1440,
      innerHeight: 900,
    }))
      vi.stubGlobal(key, value)
    const initial = new Promise<State>((resolve) => {
      resolveInitial = resolve
    })
    runtime.sendMessage.mockImplementation(async (message) =>
      message.type === 'CONTENT_STATE' ? initial : { ok: true },
    )
    runtime.addListener.mockImplementation((value) => {
      listener = value
    })
    startContent()
  })
  afterEach(async () => {
    vi.clearAllTimers()
    dom.window.close()
    await Promise.resolve()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('retains a pending SPA navigation across same-session state refreshes', async () => {
    resolveInitial(state(true))
    await vi.advanceTimersByTimeAsync(0)
    navigate('/next?PRIVATE_QUERY#PRIVATE_FRAGMENT')
    refresh()
    refresh()
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toMatchObject([
      { action: 'navigate', url: 'https://example.test/next' },
    ])
    refresh()
    await vi.advanceTimersByTimeAsync(1000)
    expect(captures()).toHaveLength(1)
  })

  it('does not record paused navigation and resets its baseline on resume', async () => {
    resolveInitial(state(true))
    await vi.advanceTimersByTimeAsync(0)
    refresh(false)
    navigate('/while-paused')
    await vi.advanceTimersByTimeAsync(500)
    refresh()
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toHaveLength(0)
    navigate('/after-resume')
    refresh()
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toMatchObject([
      { action: 'navigate', url: 'https://example.test/after-resume' },
    ])
  })

  it('ignores an old initial response after a recording broadcast', async () => {
    refresh()
    resolveInitial(state(false))
    await vi.advanceTimersByTimeAsync(0)
    navigate('/after-start')
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toMatchObject([
      { action: 'navigate', url: 'https://example.test/after-start' },
    ])
  })

  it('does not reactivate a canceled old session from its initial response', async () => {
    refresh(false, otherSession)
    resolveInitial(state(true))
    await vi.advanceTimersByTimeAsync(0)
    navigate('/after-cancel')
    await vi.advanceTimersByTimeAsync(500)
    expect(captures()).toHaveLength(0)
  })

  it('starts a new session at its current URL without replaying the old change', async () => {
    resolveInitial(state(true))
    await vi.advanceTimersByTimeAsync(0)
    navigate('/new-session')
    refresh(true, otherSession)
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toHaveLength(0)
    navigate('/new-session-next')
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toMatchObject([
      { action: 'navigate', url: 'https://example.test/new-session-next' },
    ])
  })

  it.each([false, true])(
    'ignores a delayed older state across a session boundary: %s',
    async (oldActive) => {
      listener(
        {
          type: 'STATE',
          recording: true,
          sessionId: otherSession,
          stateRevision: 20,
        },
        {},
        () => {},
      )
      listener(
        {
          type: 'STATE',
          recording: oldActive,
          sessionId: session,
          stateRevision: 19,
        },
        {},
        () => {},
      )
      navigate('/after-delayed-state')
      await vi.advanceTimersByTimeAsync(250)
      expect(captures()).toMatchObject([
        { action: 'navigate', url: 'https://example.test/after-delayed-state' },
      ])
      expect(
        runtime.sendMessage.mock.calls.find(
          ([message]) => message.type === 'CAPTURE',
        )?.[0].sessionId,
      ).toBe(otherSession)
    },
  )

  it('ignores a delayed pause after the same session resumes', async () => {
    listener(
      { type: 'STATE', recording: true, sessionId: session, stateRevision: 22 },
      {},
      () => {},
    )
    listener(
      {
        type: 'STATE',
        recording: false,
        paused: true,
        sessionId: session,
        stateRevision: 21,
      },
      {},
      () => {},
    )
    navigate('/after-delayed-pause')
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toMatchObject([
      { action: 'navigate', url: 'https://example.test/after-delayed-pause' },
    ])
  })

  it('orders a versioned initial reply against a more recent broadcast', async () => {
    listener(
      {
        type: 'STATE',
        recording: true,
        sessionId: otherSession,
        stateRevision: 20,
      },
      {},
      () => {},
    )
    resolveInitial({ ...state(false), stateRevision: 19 })
    await vi.advanceTimersByTimeAsync(0)
    navigate('/after-versioned-initial')
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toHaveLength(1)
  })

  it('accepts a genuinely newer initial reply instead of discarding a later pause', async () => {
    listener(
      { type: 'STATE', recording: true, sessionId: session, stateRevision: 20 },
      {},
      () => {},
    )
    resolveInitial({ ...state(false), stateRevision: 21 })
    await vi.advanceTimersByTimeAsync(0)
    navigate('/while-newer-paused')
    await vi.advanceTimersByTimeAsync(250)
    expect(captures()).toHaveLength(0)
  })
})

import { browser } from 'wxt/browser'
import {
  observePage,
  guessExpectation,
  editable,
  CaptureMetadataError,
  FrameTracker,
  localDocumentUrl,
  isCaptureUi,
} from '@stepdoc/core/capture'
import { BlurControls } from './blur-controls'
import { GuideContent } from './guide-content'
import { RecordingControls } from './recording-controls'
import { FRAME_PROBE, frameProbeSchema } from '@stepdoc/schema/capture'
import {
  captureEvent,
  captureNavigation,
  captureDocumentId,
  type CapturedEvent,
} from './capture-event'
import type { Step } from '@stepdoc/schema'

export function startContent() {
  const listeners: (() => void)[] = []
  const installListeners = () => listeners.forEach((install) => install())
  const listen = <K extends keyof WindowEventMap>(
    type: K,
    callback: (event: WindowEventMap[K]) => void,
    capture = true,
  ) => {
    const install = () => window.addEventListener(type, callback, capture)
    listeners.push(install)
    install()
  }
  // document.open/write clears Window listeners without replacing this isolated
  // world. Re-register the same function objects (native duplicate suppression).
  new MutationObserver(() => {
    installListeners()
    updateUi()
    guide.install()
  }).observe(document, {
    childList: true,
    subtree: true,
  })
  const tracker = new FrameTracker(document, captureDocumentId())
  const guide = new GuideContent(document, captureDocumentId(), (message) =>
    browser.runtime.sendMessage(message),
  )
  let armedNonce = '',
    armedUntil = 0
  // Installed at document_start before page listeners. Only a parent WindowProxy
  // and a short-lived background nonce are accepted; no page data is returned.
  listen(
    'message',
    (event: MessageEvent) => {
      if (!event.isTrusted || event.source !== parent || window === parent)
        return
      const probe = frameProbeSchema.safeParse(event.data)
      if (
        !probe.success ||
        probe.data.nonce !== armedNonce ||
        Date.now() > armedUntil
      )
        return
      event.stopImmediatePropagation()
      void browser.runtime
        .sendMessage({ ...probe.data, documentId: captureDocumentId() })
        .catch(() => {})
    },
    true,
  )
  let recording = false
  let blurMode = false,
    blurBusy = false,
    manualCount = 0
  let modeRequest = 0
  let pendingMode: number | undefined
  let sessionId = ''
  let pillView: unknown
  let previousUrl = ''
  const touched = new WeakSet<Element>()
  const ui = new BlurControls(document, () => {
    void setBlurMode(false)
  })
  const pill = new RecordingControls(document, (command) =>
    browser.runtime.sendMessage(command),
  )
  const updateUi = () => {
    ui.update(
      recording && blurMode,
      manualCount,
      blurBusy,
      window === window.top,
    )
    pill.update(pillView, !blurMode)
  }
  const setBlurMode = async (on: boolean) => {
    const capturedSession = sessionId
    const request = ++modeRequest
    pendingMode = request
    // Arm privacy synchronously on the source page. In-flight STATE broadcasts
    // cannot undo it, and turning it off waits for the background acknowledgement.
    blurMode = true
    updateUi()
    try {
      const result = await browser.runtime.sendMessage({
        type: 'SET_BLUR_MODE',
        sessionId: capturedSession,
        on,
      })
      if (!result.ok) fail(capturedSession)
      else if (capturedSession === sessionId && pendingMode === request) {
        pendingMode = undefined
        blurMode = recording && on
        updateUi()
      }
    } catch {
      fail(capturedSession)
    }
  }
  const selectBlur = async (element: Element) => {
    if (blurBusy) return
    const capturedSession = sessionId
    blurBusy = true
    updateUi()
    try {
      tracker.manual.add(element)
      const result = await browser.runtime.sendMessage({
        type: 'REDACTION_CHANGED',
        sessionId: capturedSession,
        documentId: captureDocumentId(),
        count: tracker.manual.count,
      })
      if (!result.ok) fail(capturedSession)
    } catch {
      fail(capturedSession)
    } finally {
      if (capturedSession === sessionId) {
        blurBusy = false
        updateUi()
      }
    }
  }
  const stateChanged = (
    active: boolean,
    nonce: string,
    mode: boolean,
    count: number,
    paused = false,
    view?: unknown,
  ) => {
    if (nonce !== sessionId || (!active && !paused)) {
      tracker.manual.clear()
      blurBusy = false
      pendingMode = undefined
    }
    recording = active
    sessionId = nonce
    blurMode = active && (pendingMode !== undefined || mode)
    manualCount = count
    pillView = view
    updateUi()
  }
  const fail = (failedSession = sessionId) => {
    void browser.runtime
      .sendMessage({ type: 'CAPTURE_ERROR', sessionId: failedSession })
      .catch(() => {})
  }
  const send = (event: CapturedEvent) => {
    const sentSession = sessionId
    return browser.runtime
      .sendMessage({ type: 'CAPTURE', sessionId: sentSession, event })
      .then((result) => {
        if (!result.ok && recording && sentSession === sessionId)
          fail(sentSession)
      })
      .catch(() => {
        if (recording && sentSession === sessionId) fail(sentSession)
      })
  }
  const action = (
    element: Element,
    kind: NonNullable<Step['action']>,
    click?: { x: number; y: number },
    key?: string,
  ) => {
    try {
      const scope = element.getRootNode() as Document | ShadowRoot
      const observationUrl = () =>
        window === window.top ? localDocumentUrl(document) : null
      const before = observePage(document, scope, observationUrl())
      const event = captureEvent(element, kind, click, key)
      const capturedSession = sessionId
      void send(event)
      setTimeout(() => {
        if (sessionId !== capturedSession || !recording) return
        try {
          const expect = guessExpectation(
            before,
            observePage(document, scope, observationUrl()),
          )
          if (expect)
            void browser.runtime
              .sendMessage({
                type: 'EXPECTATION',
                sessionId,
                id: event.step.id,
                expect,
              })
              .catch(() => fail(capturedSession))
        } catch {
          fail()
        }
      }, 200)
    } catch {
      fail()
    }
  }
  const elementOf = (event: Event): Element | undefined => {
    const node = event.composedPath()[0]
    return node instanceof Element ? node : undefined
  }
  browser.runtime.onMessage.addListener((message, _sender, respond) => {
    if (guide.handle(message, respond)) return true
    if (message.type === 'FRAME_SNAPSHOT') {
      void (async () => {
        try {
          installListeners()
          if (
            typeof message.nonce !== 'string' ||
            !/^[0-9a-f-]{36}$/i.test(message.nonce)
          )
            throw new Error()
          armedNonce = message.nonce
          armedUntil = Date.now() + 2_000
          await Promise.all([ui.suspend(), pill.suspend()])
          respond(
            tracker.snapshot(
              message.nonce,
              message.smartBlur !== false,
              message.geometryOnly === true,
            ),
          )
        } catch {
          respond({ ok: false, error: 'Capture metadata unavailable' })
        }
      })()
      return true
    }
    if (message.type === 'FRAME_RELEASE') {
      ui.release()
      pill.release()
      respond({ ok: true })
      return
    }
    if (message.type === 'FRAME_PROBE') {
      if (
        message.nonce !== armedNonce ||
        Date.now() > armedUntil ||
        !Array.isArray(message.tokens) ||
        message.tokens.length > 128
      ) {
        respond({ ok: false })
        return
      }
      tracker.probe(message.nonce, message.tokens, FRAME_PROBE)
      respond({ ok: true })
      return
    }
    if (message.type === 'STATE') {
      installListeners()
      stateChanged(
        !!message.recording && !message.producerStopped,
        message.sessionId ?? '',
        !!message.blurMode,
        message.manualCount ?? 0,
        !!message.paused,
        message.capturePill,
      )
      previousUrl = localDocumentUrl(document) ?? ''
      respond({ ok: true })
    }
    if (message.type === 'CAPTURE_PAGE') {
      try {
        respond({ ok: true, event: captureNavigation() })
      } catch {
        respond({ ok: false, error: 'Capture metadata unavailable' })
      }
    }
  })
  void browser.runtime
    .sendMessage({ type: 'CONTENT_STATE' })
    .then((state) => {
      stateChanged(
        !!state.recording && !state.producerStopped,
        state.captureSessionId ?? '',
        !!state.captureBlurMode,
        state.captureManualCount ?? 0,
        !!state.paused,
        state.capturePill,
      )
      previousUrl = localDocumentUrl(document) ?? ''
    })
    .catch(() => {})
  void browser.runtime.sendMessage({ type: 'GUIDE_READY' }).catch(() => {})
  listen(
    'mousedown',
    (event) => {
      const element = elementOf(event)
      if (!recording || !event.isTrusted || !element || isCaptureUi(element))
        return
      if (blurMode || blurBusy) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      const actionable =
        element.closest(
          'button,a,input,select,textarea,[role="button"],[role="checkbox"],[role="radio"]',
        ) ?? element
      const type = actionable.getAttribute('type')
      const kind =
        type === 'checkbox' || type === 'radio'
          ? (actionable as HTMLInputElement).checked && type === 'checkbox'
            ? 'uncheck'
            : 'check'
          : 'click'
      action(actionable, kind, { x: event.clientX, y: event.clientY })
    },
    true,
  )
  listen(
    'input',
    (event) => {
      const element = elementOf(event)
      if (
        recording &&
        !blurMode &&
        !blurBusy &&
        event.isTrusted &&
        element &&
        !isCaptureUi(element) &&
        editable(element)
      )
        touched.add(element)
    },
    true,
  )
  const commit = (element: Element) => {
    if (!touched.has(element)) return
    touched.delete(element)
    action(element, element.getAttribute('type') === 'file' ? 'upload' : 'fill')
  }
  listen(
    'focusout',
    (event) => {
      const element = elementOf(event)
      if (
        recording &&
        !blurMode &&
        !blurBusy &&
        event.isTrusted &&
        element &&
        !isCaptureUi(element) &&
        editable(element)
      )
        commit(element)
    },
    true,
  )
  listen(
    'change',
    (event) => {
      const element = elementOf(event)
      if (
        !recording ||
        blurMode ||
        blurBusy ||
        !event.isTrusted ||
        !element ||
        isCaptureUi(element)
      )
        return
      if (element.localName === 'select') action(element, 'select')
      if (element.getAttribute('type') === 'file') action(element, 'upload')
    },
    true,
  )
  listen(
    'keydown',
    (event) => {
      const element = elementOf(event)
      if (
        event.isTrusted &&
        event.altKey &&
        event.shiftKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        event.code === 'KeyS' &&
        element
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat)
          void browser.runtime.sendMessage({ type: 'SHORTCUT' }).catch(() => {})
        return
      }
      if (!recording || !event.isTrusted || !element) return
      if (
        (event.code === 'KeyB' || event.key.toLowerCase() === 'b') &&
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) void setBlurMode(!blurMode)
        return
      }
      if (blurMode && event.key === 'Escape') {
        event.preventDefault()
        event.stopImmediatePropagation()
        void setBlurMode(false)
        return
      }
      if (isCaptureUi(element)) return
      if (
        (blurMode || blurBusy) &&
        (event.key === 'Enter' || event.key === ' ')
      ) {
        event.preventDefault()
        event.stopImmediatePropagation()
        if (!event.repeat) void selectBlur(element)
        return
      }
      if (blurMode || blurBusy) {
        if (event.key !== 'Tab') {
          event.stopImmediatePropagation()
          if (editable(element) || element.localName === 'select')
            event.preventDefault()
        }
        return
      }
      if (recording && event.isTrusted && event.key === 'Enter' && element) {
        commit(element)
        action(element, 'press', undefined, 'Enter')
      }
    },
    true,
  )
  listen('pointerdown', (event) => {
    const element = elementOf(event)
    if (
      !recording ||
      !event.isTrusted ||
      !element ||
      isCaptureUi(element) ||
      (!blurMode && !blurBusy)
    )
      return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (event.button === 0) void selectBlur(element)
  })
  listen('click', (event) => {
    const element = elementOf(event)
    if (
      recording &&
      event.isTrusted &&
      element &&
      !isCaptureUi(element) &&
      (blurMode || blurBusy)
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  })
  listen('pointermove', (event) => {
    if (!blurMode || !event.isTrusted) return
    const element = elementOf(event)
    if (element && !isCaptureUi(element)) ui.hover(element)
  })
  listen('focusin', (event) => {
    const element = elementOf(event)
    if (blurMode && event.isTrusted && element && !isCaptureUi(element))
      ui.hover(element)
  })
  listen('keyup', (event) => {
    const element = elementOf(event)
    if (
      recording &&
      event.isTrusted &&
      element &&
      !isCaptureUi(element) &&
      (blurMode || blurBusy) &&
      (event.key === 'Enter' || event.key === ' ')
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
  })
  // Isolated-world history wrappers cannot observe the page world's pushState.
  // Observe only the stripped URL while recording; no query/fragment is retained.
  setInterval(() => {
    if (!recording || window !== window.top) return
    try {
      const url = localDocumentUrl(document)
      if (!url) throw new CaptureMetadataError('invalid_url')
      if (url !== previousUrl) {
        previousUrl = url
        void send(captureNavigation())
      }
    } catch (error) {
      if (error instanceof CaptureMetadataError) fail()
    }
  }, 250)
}

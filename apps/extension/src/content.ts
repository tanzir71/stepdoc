import { browser } from 'wxt/browser'
import {
  observePage,
  guessExpectation,
  editable,
  CaptureMetadataError,
  FrameTracker,
  localDocumentUrl,
} from '@stepdoc/core/capture'
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
  new MutationObserver(installListeners).observe(document, {
    childList: true,
    subtree: true,
  })
  const tracker = new FrameTracker(document, captureDocumentId())
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
  let sessionId = ''
  let previousUrl = ''
  const touched = new WeakSet<Element>()
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
        if (!result.ok) fail(sentSession)
      })
      .catch(() => fail(sentSession))
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
    if (message.type === 'FRAME_SNAPSHOT') {
      try {
        installListeners()
        if (
          typeof message.nonce !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(message.nonce)
        )
          throw new Error()
        armedNonce = message.nonce
        armedUntil = Date.now() + 2_000
        respond(tracker.snapshot(message.nonce))
      } catch {
        respond({ ok: false, error: 'Capture metadata unavailable' })
      }
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
      recording = message.recording
      sessionId = message.sessionId ?? ''
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
      recording = !!state.recording
      sessionId = state.captureSessionId ?? ''
      previousUrl = localDocumentUrl(document) ?? ''
    })
    .catch(() => {})
  listen(
    'mousedown',
    (event) => {
      const element = elementOf(event)
      if (!recording || !event.isTrusted || !element) return
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
      if (recording && event.isTrusted && element && editable(element))
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
      if (recording && event.isTrusted && element && editable(element))
        commit(element)
    },
    true,
  )
  listen(
    'change',
    (event) => {
      const element = elementOf(event)
      if (!recording || !event.isTrusted || !element) return
      if (element.localName === 'select') action(element, 'select')
      if (element.getAttribute('type') === 'file') action(element, 'upload')
    },
    true,
  )
  listen(
    'keydown',
    (event) => {
      const element = elementOf(event)
      if (recording && event.isTrusted && event.key === 'Enter' && element) {
        commit(element)
        action(element, 'press', undefined, 'Enter')
      }
    },
    true,
  )
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

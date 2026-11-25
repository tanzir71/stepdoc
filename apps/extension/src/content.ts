import { browser } from 'wxt/browser'
import {
  fieldMasks,
  observePage,
  guessExpectation,
  documentUrl,
  editable,
  CaptureMetadataError,
} from '@stepdoc/core/capture'
import {
  captureEvent,
  captureNavigation,
  captureDocumentId,
  type CapturedEvent,
} from './capture-event'
import type { Step } from '@stepdoc/schema'

export function startContent() {
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
      const before = observePage(document, scope)
      const event = captureEvent(element, kind, click, key)
      const capturedSession = sessionId
      void send(event)
      setTimeout(() => {
        if (sessionId !== capturedSession || !recording) return
        try {
          const expect = guessExpectation(before, observePage(document, scope))
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
    if (message.type === 'STATE') {
      recording = message.recording
      sessionId = message.sessionId ?? ''
      try {
        previousUrl = documentUrl(document)
      } catch {
        previousUrl = ''
      }
      respond({ ok: true })
    }
    if (message.type === 'CAPTURE_PAGE' || message.type === 'GET_MASKS') {
      try {
        respond(
          message.type === 'CAPTURE_PAGE'
            ? { ok: true, event: captureNavigation() }
            : {
                ok: true,
                documentId: captureDocumentId(),
                masks: fieldMasks(document),
                url: documentUrl(document),
                viewport: { width: innerWidth, height: innerHeight },
                devicePixelRatio,
              },
        )
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
      try {
        previousUrl = documentUrl(document)
      } catch {
        previousUrl = ''
      }
    })
    .catch(() => {})
  addEventListener(
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
  addEventListener(
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
  addEventListener(
    'focusout',
    (event) => {
      const element = elementOf(event)
      if (recording && event.isTrusted && element && editable(element))
        commit(element)
    },
    true,
  )
  addEventListener(
    'change',
    (event) => {
      const element = elementOf(event)
      if (!recording || !event.isTrusted || !element) return
      if (element.localName === 'select') action(element, 'select')
      if (element.getAttribute('type') === 'file') action(element, 'upload')
    },
    true,
  )
  addEventListener(
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
      const url = documentUrl(document)
      if (url !== previousUrl) {
        previousUrl = url
        void send(captureNavigation())
      }
    } catch (error) {
      if (error instanceof CaptureMetadataError) fail()
    }
  }, 250)
}

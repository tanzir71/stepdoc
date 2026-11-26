import {
  guideCss,
  resolveGuideTarget,
  frameSelector,
  rectOf,
  isCaptureUi,
} from '@stepdoc/core/capture'
import {
  guideMeLocateSchema,
  guideMeViewSchema,
  type GuideMeView,
  type GuideMeStep,
} from '@stepdoc/schema/guide-me'
import { captureId } from '@stepdoc/core/capture'
import { GuideOverlay } from './guide-overlay'

type Request = (message: unknown) => Promise<unknown>
export class GuideContent {
  private view?: GuideMeView
  private current?: {
    runId: string
    sequence: number
    token: string
    element: Element
    step: GuideMeStep
    touched: boolean
    done: boolean
  }
  private ui: GuideOverlay
  private listeners: (() => void)[] = []
  constructor(
    private readonly document: Document,
    private readonly documentId: string,
    private readonly request: Request,
  ) {
    this.ui = new GuideOverlay(document, (command) => {
      void request(command).catch(() => {})
    })
    const listen = <K extends keyof WindowEventMap>(
      name: K,
      fn: (event: WindowEventMap[K]) => void,
    ) => {
      this.listeners.push(() =>
        document.defaultView!.addEventListener(name, fn, true),
      )
    }
    for (const name of [
      'click',
      'dblclick',
      'input',
      'change',
      'focusout',
      'keydown',
      'pointerover',
    ] as const)
      listen(name, (event) => this.interaction(event))
    listen('keydown', (event) => {
      if (
        !event.isTrusted ||
        event.code !== 'Escape' ||
        !this.view ||
        this.view.phase === 'saving'
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      void request({
        type: 'GUIDE_CONTROL',
        runId: this.view.runId,
        sequence: this.view.sequence,
        action: this.view.phase === 'running' ? 'stop' : 'dismiss',
      }).catch(() => {})
    })
    this.install()
    setInterval(() => {
      if (
        this.view?.phase === 'running' &&
        document.defaultView === document.defaultView!.top
      )
        void request({
          type: 'GUIDE_REFRESH',
          runId: this.view.runId,
          sequence: this.view.sequence,
        }).catch(() => {})
    }, 1_200)
  }
  install() {
    for (const install of this.listeners) install()
  }
  private interaction(event: Event) {
    const current = this.current
    const node = event.composedPath()[0]
    if (
      !event.isTrusted ||
      !current ||
      current.done ||
      !(node instanceof Node) ||
      isCaptureUi(node) ||
      !current.element.isConnected ||
      !(
        event.composedPath().includes(current.element) ||
        current.element.contains(node)
      )
    )
      return
    const action = current.step.action
    if (action === 'fill' && event.type === 'input') {
      current.touched = true
      return
    }
    let matches =
      (action === 'click' && event.type === 'click') ||
      (action === 'dblclick' && event.type === 'dblclick') ||
      (action === 'hover' && event.type === 'pointerover') ||
      (action === 'upload' && event.type === 'change')
    if (
      (action === 'check' || action === 'uncheck') &&
      event.type === 'click'
    ) {
      const checked = current.element.matches('input')
        ? (current.element as HTMLInputElement).checked
        : current.element.getAttribute('aria-checked') === 'true'
      matches = checked === (action === 'check')
    }
    if (
      action === 'fill' &&
      current.touched &&
      (event.type === 'focusout' ||
        event.type === 'change' ||
        (event.type === 'keydown' && (event as KeyboardEvent).code === 'Enter'))
    )
      matches = true
    if (
      action === 'select' &&
      event.type === 'change' &&
      current.element.localName === 'select'
    ) {
      const option = (current.element as HTMLSelectElement).selectedOptions[0]
      matches =
        !!option &&
        (current.step.value?.kind !== 'literal' ||
          (option.label || option.textContent || '')
            .replace(/\s+/gu, ' ')
            .trim() === current.step.value.literal)
    }
    if (action === 'press' && event.type === 'keydown') {
      const expected =
        current.step.key ??
        (current.step.value?.kind === 'literal'
          ? current.step.value.literal
          : '')
      const safe = [
        'Enter',
        'Tab',
        'Escape',
        'Space',
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'Home',
        'End',
        'PageUp',
        'PageDown',
        'Backspace',
        'Delete',
      ]
      matches =
        safe.includes(expected) && (event as KeyboardEvent).code === expected
    }
    if (!matches) return
    queueMicrotask(() => {
      if (event.defaultPrevented || current !== this.current || current.done)
        return
      current.done = true
      void this.request({
        type: 'GUIDE_MATCH',
        runId: current.runId,
        sequence: current.sequence,
        token: current.token,
        documentId: this.documentId,
      }).catch(() => {})
    })
  }
  handle(
    message: Record<string, unknown>,
    respond: (result: unknown) => void,
  ): boolean {
    if (message.type === 'GUIDE_HIDE') {
      this.current = undefined
      this.view = undefined
      this.ui.hide()
      respond({ ok: true })
      return true
    }
    if (message.type === 'GUIDE_SHOW') {
      const view = guideMeViewSchema.safeParse(message.view)
      if (view.success) {
        this.view = view.data
        if (this.document.defaultView === this.document.defaultView!.top)
          this.ui.show(view.data)
      }
      respond({ ok: view.success })
      return true
    }
    if (message.type === 'GUIDE_FRAME') {
      try {
        if (
          typeof message.selector !== 'string' ||
          message.selector.length > 2_000
        )
          throw new Error()
        const frames = guideCss(this.document, message.selector).filter(
          (element) => element.matches('iframe,frame'),
        )
        if (frames.length !== 1) throw new Error()
        frames[0]!.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'instant',
        })
        respond({
          documentId: this.documentId,
          selector: frameSelector(frames[0]!),
        })
      } catch {
        respond({ documentId: this.documentId })
      }
      return true
    }
    if (message.type === 'GUIDE_LOCATE') {
      const request = guideMeLocateSchema.safeParse(message)
      if (!request.success) {
        respond({ ok: false })
        return true
      }
      const { runId, sequence, step } = request.data
      let token = captureId()
      const previous = this.current
      this.current = undefined
      const result = step.target
        ? resolveGuideTarget(this.document, step.target)
        : { reason: 'missing' as const }
      let rect = null
      if (result.element) {
        result.element.scrollIntoView({
          block: 'center',
          inline: 'nearest',
          behavior: 'instant',
        })
        rect = rectOf(result.element)
        const same =
          previous?.runId === runId &&
          previous.sequence === sequence &&
          previous.element === result.element
        if (same) token = previous.token
        this.current = {
          runId,
          sequence,
          token,
          element: result.element,
          step,
          touched: same ? previous.touched : false,
          done: same ? previous.done : false,
        }
      }
      respond({
        documentId: this.documentId,
        token,
        rect,
        reason: result.reason,
        ...(result.strategy && { strategy: result.strategy }),
      })
      return true
    }
    return false
  }
}

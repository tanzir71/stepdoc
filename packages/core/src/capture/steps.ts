import {
  stepSchema,
  type Step,
  type Value,
  type Rect,
  type Redaction,
} from '@stepdoc/schema'
import { describeGuideStep } from '../describe-step'
import {
  captureTarget,
  captureUrl,
  documentUrl,
  CaptureDom,
  editable,
  rectOf,
  visible,
  CaptureMetadataError,
  safeMetadata,
} from './dom'
import { isCaptureUi } from './owned-ui'

export interface CaptureOptions {
  id: string
  index: number
  click?: { x: number; y: number }
  key?: string
  frame?: string[]
  url?: string | null
}
export function viewportPoint(
  window: Window,
  point: { x: number; y: number },
): { x: number; y: number } {
  let current = window,
    x = point.x,
    y = point.y
  try {
    while (current !== current.top) {
      const frame = current.frameElement as HTMLElement | null
      if (!frame) throw new CaptureMetadataError('frame_unavailable')
      const rect = rectOf(frame),
        sx = rect.width / (frame.offsetWidth || rect.width || 1),
        sy = rect.height / (frame.offsetHeight || rect.height || 1)
      x = rect.x + (x + frame.clientLeft) * sx
      y = rect.y + (y + frame.clientTop) * sy
      current = current.parent
    }
  } catch {
    throw new CaptureMetadataError('frame_unavailable')
  }
  return { x, y }
}
export function captureStep(
  element: Element,
  action: NonNullable<Step['action']>,
  options: CaptureOptions,
): Step {
  const target = captureTarget(element, options.frame)
  let value: Value | undefined
  if (action === 'fill' || action === 'upload') {
    const type = element.getAttribute('type') ?? ''
    const autocomplete = element.getAttribute('autocomplete') ?? ''
    value = {
      kind:
        /^(password|email|tel)$/i.test(type) ||
        /(?:cc-|password|email|tel|payment)/i.test(autocomplete)
          ? 'secret'
          : 'variable',
      variable: `field_${options.index}`,
    }
  }
  if (action === 'select') {
    const select = element as HTMLSelectElement
    if (select.localName !== 'select' || select.selectedOptions.length !== 1)
      throw new CaptureMetadataError('dom_failure')
    value = { kind: 'literal', literal: select.selectedOptions[0]!.label }
  }
  const dpr = element.ownerDocument.defaultView?.devicePixelRatio ?? 1
  const step = stepSchema.parse({
    id: options.id,
    index: options.index,
    type: 'action',
    action,
    target,
    url:
      options.url === null
        ? null
        : options.url !== undefined
          ? captureUrl(options.url)
          : documentUrl(element.ownerDocument),
    ...(value && { value }),
    ...(options.key && { key: options.key }),
    title: 'Captured action',
    ...(options.click && {
      click: {
        x: options.click.x * dpr,
        y: options.click.y * dpr,
        radius: 18 * dpr,
      },
    }),
  })
  const description = describeGuideStep(step)
  return {
    ...step,
    title: description.text,
    lowConfidence: description.lowConfidence || !target.locators?.[0]?.unique,
  }
}
export function navigationStep(
  rawUrl: string,
  id: string,
  index: number,
): Step {
  const url = captureUrl(rawUrl)
  const step = stepSchema.parse({
    id,
    index,
    type: 'navigate',
    action: 'navigate',
    url,
    title: 'Open page',
    expect: { urlMatches: url },
  })
  return { ...step, title: describeGuideStep(step).text }
}
export interface PageObservation {
  url: string | null
  visible: { role: string; name: string }[]
}
export function observePage(
  document: Document,
  scope: Document | ShadowRoot = document,
  suppliedUrl?: string | null,
): PageObservation {
  // guide@1 urlMatches is evaluated against the top-level page by replay.
  // Visible assertions remain scoped to the action's own frame/shadow context.
  let page = document
  try {
    if (suppliedUrl === undefined)
      page = document.defaultView?.top?.document ?? document
  } catch {
    throw new CaptureMetadataError('frame_unavailable')
  }
  const result: PageObservation = {
    url: suppliedUrl !== undefined ? suppliedUrl : documentUrl(page),
    visible: [],
  }
  const visit = (root: Document | ShadowRoot) => {
    const dom = new CaptureDom(root)
    for (const element of dom.originals) {
      const role = dom.role(element)
      if (
        ['dialog', 'alertdialog', 'heading'].includes(role ?? '') &&
        visible(element)
      ) {
        const name = dom.name(element)
        // Sensitive names are intentionally omitted rather than becoming replay selectors.
        if (name && safeMetadata(name) === name)
          result.visible.push({ role: role!, name })
      }
      if (element.shadowRoot) visit(element.shadowRoot)
    }
  }
  try {
    visit(scope)
  } catch (error) {
    if (error instanceof CaptureMetadataError) throw error
    throw new CaptureMetadataError('dom_failure')
  }
  return result
}
export function guessExpectation(
  before: PageObservation,
  after: PageObservation,
): Step['expect'] {
  if (after.url !== null && before.url !== null && after.url !== before.url)
    return { urlMatches: after.url }
  const previous = new Set(before.visible.map((item) => JSON.stringify(item)))
  const added = after.visible.filter(
    (item) => !previous.has(JSON.stringify(item)),
  )
  const next =
    added.find(
      (item) => item.role === 'dialog' || item.role === 'alertdialog',
    ) ?? added[0]
  return next ? { visible: next } : undefined
}

/** Mandatory masks for all fields, including ordinary typed text. Traversal never
 * reads their text/value. Cross-origin frames are fully masked until their own
 * content-script context can supply more precise client masks. */
export function fieldRedactions(
  document: Document,
  includeFrames = true,
): Redaction[] {
  const result: Redaction[] = []
  let count = 0
  const add = (item: Redaction) => {
    if (item.rect.width <= 0 || item.rect.height <= 0) return
    result.push(item)
    if (result.length > 12_000) throw new CaptureMetadataError('dom_limit')
  }
  const effects = new WeakMap<Element, boolean>()
  const paintOverflow = (element: Element) => {
    const pending: Element[] = []
    let node: Element | null = element,
      unsafe = false
    while (node) {
      if (effects.has(node)) {
        unsafe = effects.get(node)!
        break
      }
      pending.push(node)
      const style = document.defaultView!.getComputedStyle(node)
      if (
        (style.filter && style.filter !== 'none') ||
        (style.textShadow && style.textShadow !== 'none')
      ) {
        unsafe = true
        break
      }
      const root = node.getRootNode()
      node =
        node.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
    }
    for (const item of pending) effects.set(item, unsafe)
    return unsafe
  }
  const visit = (
    root: Document | ShadowRoot,
    ox: number,
    oy: number,
    sx = 1,
    sy = 1,
    depth = 0,
  ) => {
    if (depth > 20) throw new CaptureMetadataError('dom_limit')
    for (const element of root.querySelectorAll('*')) {
      if (isCaptureUi(element)) continue
      if (++count > 12_000) throw new CaptureMetadataError('dom_limit')
      const rect = rectOf(element)
      const box = {
        x: ox + rect.x * sx,
        y: oy + rect.y * sy,
        width: rect.width * sx,
        height: rect.height * sy,
      }
      if (
        (editable(element) || element.matches('iframe,frame')) &&
        paintOverflow(element)
      )
        add({
          kind: 'field',
          source: 'policy',
          rule: 'paint-overflow',
          rect: {
            x: 0,
            y: 0,
            width: document.defaultView!.innerWidth,
            height: document.defaultView!.innerHeight,
          },
          status: 'applied',
        })
      if (
        (includeFrames && element.matches('iframe,frame')) ||
        (element.localName.includes('-') && !element.shadowRoot)
      ) {
        // Cover the whole frame: contents and form geometry can change independently
        // of the parent snapshot, including in a cross-origin browsing context.
        // Opaque custom hosts may contain a closed shadow root with typed fields.
        add({
          kind: 'field',
          source: 'policy',
          rule: element.matches('iframe,frame')
            ? 'frame-unavailable'
            : 'opaque-host',
          rect: box,
          status: 'applied',
        })
      } else if (
        editable(element) &&
        !element.matches(
          'input[type="button"],input[type="submit"],input[type="reset"],input[type="checkbox"],input[type="radio"],input[type="hidden"]',
        )
      ) {
        add({
          kind: 'field',
          source: 'auto',
          rule: 'form-value',
          rect: box,
          status: 'applied',
        })
        // Bounding boxes alone miss overflowing editable text. Range reads
        // geometry without reading, copying or detecting its characters.
        if (
          element.matches(
            '[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="searchbox"]',
          )
        ) {
          const range = document.createRange()
          range.selectNodeContents(element)
          for (const rect of range.getClientRects()) {
            if (
              ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
            )
              throw new CaptureMetadataError('invalid_geometry')
            add({
              kind: 'field',
              source: 'auto',
              rule: 'form-value',
              rect: {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
              },
              status: 'applied',
            })
          }
        }
      }
      if (element.shadowRoot)
        visit(element.shadowRoot, ox, oy, sx, sy, depth + 1)
    }
  }
  try {
    visit(document, 0, 0)
  } catch (error) {
    if (error instanceof CaptureMetadataError) throw error
    throw new CaptureMetadataError('dom_failure')
  }
  return result
}
export function fieldMasks(document: Document): Rect[] {
  return fieldRedactions(document).map((item) => item.rect)
}

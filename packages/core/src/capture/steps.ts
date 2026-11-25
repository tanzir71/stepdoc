import { stepSchema, type Step, type Value, type Rect } from '@stepdoc/schema'
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

export interface CaptureOptions {
  id: string
  index: number
  click?: { x: number; y: number }
  key?: string
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
  const target = captureTarget(element)
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
    url: documentUrl(element.ownerDocument),
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
  url: string
  visible: { role: string; name: string }[]
}
export function observePage(
  document: Document,
  scope: Document | ShadowRoot = document,
): PageObservation {
  // guide@1 urlMatches is evaluated against the top-level page by replay.
  // Visible assertions remain scoped to the action's own frame/shadow context.
  let page = document
  try {
    page = document.defaultView?.top?.document ?? document
  } catch {
    throw new CaptureMetadataError('frame_unavailable')
  }
  const result: PageObservation = { url: documentUrl(page), visible: [] }
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
  if (after.url !== before.url) return { urlMatches: after.url }
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
export function fieldMasks(document: Document): Rect[] {
  const result: Rect[] = []
  let count = 0
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
      if (++count > 12_000) throw new CaptureMetadataError('dom_limit')
      const rect = rectOf(element)
      const box = {
        x: ox + rect.x * sx,
        y: oy + rect.y * sy,
        width: rect.width * sx,
        height: rect.height * sy,
      }
      if (
        element.matches('iframe,frame') ||
        (element.localName.includes('-') && !element.shadowRoot)
      ) {
        // Cover the whole frame: contents and form geometry can change independently
        // of the parent snapshot, including in a cross-origin browsing context.
        // Opaque custom hosts may contain a closed shadow root with typed fields.
        if (box.width > 0 && box.height > 0) result.push(box)
      } else if (
        editable(element) &&
        !element.matches(
          'input[type="button"],input[type="submit"],input[type="reset"],input[type="checkbox"],input[type="radio"],input[type="hidden"]',
        )
      ) {
        if (box.width > 0 && box.height > 0) result.push(box)
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

import type { Rect, Redaction } from '@stepdoc/schema'
import {
  createRedactionDetector,
  RedactionDetectionError,
  REDACTION_LIMITS,
  type SensitiveSpan,
} from '../redaction'
import {
  CaptureMetadataError,
  DOM_CAPTURE_LIMITS,
  editable,
  rectOf,
} from './dom'
import { intersectRects } from './geometry'
import { isCaptureUi } from './owned-ui'

const detect = createRedactionDetector()
const excluded = new Set([
  'head',
  'script',
  'style',
  'noscript',
  'template',
  'input',
  'textarea',
  'select',
  'option',
  'iframe',
  'frame',
  'object',
  'embed',
  'canvas',
  'video',
  'audio',
])
const inline = /^(inline|contents|ruby)/
const clips = new Set(['hidden', 'clip', 'scroll', 'auto'])
const viewport = (document: Document): Rect => ({
  x: 0,
  y: 0,
  width: document.defaultView!.innerWidth,
  height: document.defaultView!.innerHeight,
})
const box = (rect: DOMRect): Rect => {
  if (
    ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
    rect.width < 0 ||
    rect.height < 0
  )
    throw new CaptureMetadataError('invalid_geometry')
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}
export function capturePaintOverflow(
  element: Element,
  cache = new WeakMap<Element, boolean>(),
): boolean {
  const pending: Element[] = []
  let node: Element | null = element,
    unsafe = false
  while (node) {
    if (cache.has(node)) {
      unsafe = cache.get(node)!
      break
    }
    pending.push(node)
    const style = node.ownerDocument.defaultView!.getComputedStyle(node)
    if (
      (style.filter && style.filter !== 'none') ||
      (style.textShadow && style.textShadow !== 'none')
    ) {
      unsafe = true
      break
    }
    const root = node.getRootNode()
    node = node.parentElement ?? (root instanceof ShadowRoot ? root.host : null)
  }
  for (const item of pending) cache.set(item, unsafe)
  return unsafe
}

/** Only rectangle/category metadata leaves this function. Original form and
 * editable subtrees are pruned before reading any CharacterData. UTF-16 offsets
 * are preserved across inline nodes, open roots and assigned slots. */
export function visibleTextRedactions(
  document: Document,
  detector: (text: string) => SensitiveSpan[] = detect,
): Redaction[] {
  const pieces: {
    node: Text
    start: number
    end: number
    clip: Rect
    unsafe: boolean
  }[] = []
  const chunks: string[] = [],
    seen = new WeakSet<Node>(),
    effects = new WeakMap<Element, boolean>()
  const result: Redaction[] = []
  let length = 0,
    nodes = 0,
    rectangles = 0
  const append = (text: string) => {
    length += text.length
    if (length > REDACTION_LIMITS.inputLength)
      throw new RedactionDetectionError('input_limit')
    chunks.push(text)
  }
  const separator = () => {
    if (chunks.length && chunks.at(-1) !== '\n') append('\n')
  }
  const rects = (range: Range): Rect[] => {
    const result: Rect[] = []
    for (const rect of range.getClientRects()) {
      if (++rectangles > 24_000) throw new CaptureMetadataError('dom_limit')
      result.push(box(rect))
    }
    return result
  }
  const visit = (
    node: Node,
    parent: Element | null,
    clip: Rect,
    depth: number,
  ) => {
    if (seen.has(node) || isCaptureUi(node)) return
    seen.add(node)
    if (++nodes > DOM_CAPTURE_LIMITS.nodes || depth > DOM_CAPTURE_LIMITS.depth)
      throw new CaptureMetadataError('dom_limit')
    if (node.nodeType === 3) {
      if (!parent || editable(parent)) return
      const style = document.defaultView!.getComputedStyle(parent)
      if (style.visibility === 'hidden' || style.visibility === 'collapse')
        return
      const text = node as Text
      // Bound work before asking the layout engine to measure a huge text node.
      if (text.length + length > REDACTION_LIMITS.inputLength)
        throw new RedactionDetectionError('input_limit')
      const range = document.createRange()
      range.selectNodeContents(text)
      if (
        !rects(range).some((rect) => {
          const visible = intersectRects(rect, clip)
          return visible.width > 0 && visible.height > 0
        })
      )
        return
      const start = length
      append(text.data)
      pieces.push({
        node: text,
        start,
        end: length,
        clip,
        unsafe: capturePaintOverflow(parent, effects),
      })
      return
    }
    if (node.nodeType === 1) {
      const element = node as Element
      if (excluded.has(element.localName) || editable(element)) {
        separator()
        return
      }
      const style = document.defaultView!.getComputedStyle(element)
      if (
        style.display === 'none' ||
        style.contentVisibility === 'hidden' ||
        Number(style.opacity || 1) === 0
      )
        return
      const block = !inline.test(style.display)
      if (block || element.localName === 'br') separator()
      let nextClip = clip
      if (
        style.display !== 'contents' &&
        (clips.has(style.overflowX) || clips.has(style.overflowY))
      ) {
        // The outer AABB is conservative even for transformed clipping boxes.
        const bounds = rectOf(element)
        nextClip = intersectRects(clip, {
          x: clips.has(style.overflowX) ? bounds.x : clip.x,
          y: clips.has(style.overflowY) ? bounds.y : clip.y,
          width: clips.has(style.overflowX) ? bounds.width : clip.width,
          height: clips.has(style.overflowY) ? bounds.height : clip.height,
        })
      }
      if (element.shadowRoot) {
        for (const child of element.shadowRoot.childNodes)
          visit(child, element, nextClip, depth + 1)
      } else {
        const assigned =
          element.localName === 'slot'
            ? (element as HTMLSlotElement).assignedNodes({ flatten: true })
            : []
        for (const child of assigned.length ? assigned : element.childNodes)
          visit(child, element, nextClip, depth + 1)
      }
      if (block) separator()
    }
  }
  try {
    if (document.documentElement)
      visit(document.documentElement, null, viewport(document), 0)
    let spans: SensitiveSpan[]
    try {
      spans = detector(chunks.join(''))
    } catch (error) {
      if (error instanceof RedactionDetectionError) throw error
      throw new RedactionDetectionError('detector_failure')
    }
    if (spans.length > REDACTION_LIMITS.matches)
      throw new RedactionDetectionError('match_limit')
    for (const span of spans) {
      if (
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        span.end > length
      )
        throw new RedactionDetectionError('detector_failure')
      let low = 0,
        high = pieces.length
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if (pieces[middle]!.end <= span.start) low = middle + 1
        else high = middle
      }
      for (
        let index = low;
        index < pieces.length && pieces[index]!.start < span.end;
        index++
      ) {
        const piece = pieces[index]!
        const start = Math.max(span.start, piece.start),
          end = Math.min(span.end, piece.end)
        if (end <= start) continue
        const range = document.createRange()
        range.setStart(piece.node, start - piece.start)
        range.setEnd(piece.node, end - piece.start)
        const boxes = piece.unsafe
          ? [viewport(document)]
          : rects(range).map((rect) =>
              intersectRects(
                {
                  x: rect.x - 2,
                  y: rect.y - 2,
                  width: rect.width + 4,
                  height: rect.height + 4,
                },
                piece.clip,
              ),
            )
        for (const rect of boxes)
          if (rect.width > 0 && rect.height > 0) {
            result.push({
              kind: span.kind,
              source: piece.unsafe ? 'policy' : span.source,
              rule: piece.unsafe ? 'paint-overflow' : span.rule,
              status: 'applied',
              rect,
            })
            if (result.length > 12_000)
              throw new CaptureMetadataError('dom_limit')
          }
      }
    }
    return result
  } catch (error) {
    if (
      error instanceof CaptureMetadataError ||
      error instanceof RedactionDetectionError
    )
      throw error
    throw new CaptureMetadataError('dom_failure')
  }
}

/** Holds Element identities, never selectors, labels or characters. Geometry is
 * refreshed for every screenshot and cleared at the session boundary. */
export class ManualRedactions {
  private elements = new Set<Element>()
  add(element: Element): void {
    if (isCaptureUi(element) || !element.isConnected)
      throw new CaptureMetadataError('dom_failure')
    if (!this.elements.has(element) && this.elements.size >= 500)
      throw new CaptureMetadataError('dom_limit')
    this.elements.add(element)
  }
  clear(): void {
    this.elements.clear()
  }
  get count(): number {
    return this.elements.size
  }
  collect(): Redaction[] {
    const result: Redaction[] = [],
      seen = new WeakSet<Node>()
    let count = 0
    const add = (rect: Rect) => {
      if (rect.width > 0 && rect.height > 0)
        result.push({
          kind: 'custom',
          source: 'manual',
          rule: 'click-to-blur',
          status: 'applied',
          rect,
        })
      if (result.length > 12_000) throw new CaptureMetadataError('dom_limit')
    }
    const visit = (node: Node, depth: number) => {
      if (seen.has(node) || isCaptureUi(node)) return
      seen.add(node)
      if (
        ++count > DOM_CAPTURE_LIMITS.nodes ||
        depth > DOM_CAPTURE_LIMITS.depth
      )
        throw new CaptureMetadataError('dom_limit')
      if (node.nodeType === 1) {
        const element = node as Element
        add(
          capturePaintOverflow(element)
            ? viewport(element.ownerDocument)
            : rectOf(element),
        )
        if (element.shadowRoot)
          for (const child of element.shadowRoot.childNodes)
            visit(child, depth + 1)
      }
      if (node.nodeType === 3) {
        const range = node.ownerDocument!.createRange()
        range.selectNodeContents(node)
        for (const rect of range.getClientRects()) add(box(rect))
      } else for (const child of node.childNodes) visit(child, depth + 1)
    }
    try {
      for (const element of this.elements) {
        if (!element.isConnected) {
          this.elements.delete(element)
          continue
        }
        visit(element, 0)
      }
    } catch (error) {
      if (error instanceof CaptureMetadataError) throw error
      throw new CaptureMetadataError('dom_failure')
    }
    return result
  }
}

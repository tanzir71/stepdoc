import type { FrameChild, FrameSnapshot } from '@stepdoc/schema/capture'
import { FRAME_LIMITS, CAPTURE_TRANSPORT } from '@stepdoc/schema/capture'
import { CaptureMetadataError, captureUrl, rectOf, safeMetadata } from './dom'
import { fieldRedactions } from './steps'
import { visibleTextRedactions, ManualRedactions } from './redactions'
import { isCaptureUi, captureUiMutation } from './owned-ui'

/** getRandomValues also works on ordinary HTTP pages, where randomUUID is not
 * exposed. IDs remain cryptographically random in the isolated content world. */
export function captureId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6]! & 15) | 64
  bytes[8] = (bytes[8]! & 63) | 128
  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Unique, data-free structural paths also work through open shadow roots in
 * Playwright CSS locators. Never use a frame's src/name (which may contain data). */
export function frameSelector(element: Element): string {
  const parts: string[] = []
  let node: Element | null = element
  while (node) {
    const parent: Element | null = node.parentElement
    const siblings: Element[] = parent
      ? [...parent.children]
      : [...(node.getRootNode() as Document | ShadowRoot).children]
    const root = node.getRootNode() as Document | ShadowRoot
    const id = node.getAttribute('id')
    const uniqueId =
      id &&
      id.length < 200 &&
      safeMetadata(id) === id &&
      root.querySelectorAll(`#${CSS.escape(id)}`).length === 1
    parts.unshift(
      uniqueId
        ? `#${CSS.escape(id)}`
        : `${node.localName}:nth-child(${siblings.indexOf(node) + 1})`,
    )
    if (uniqueId) {
      node = root instanceof ShadowRoot ? root.host : null
      if (node) parts[0] = ` ${parts[0]}`
      continue
    }
    if (parent) node = parent
    else {
      const root = node.getRootNode()
      node = root instanceof ShadowRoot ? root.host : null
    }
    if (parts.length > 100 || parts.join(' > ').length > FRAME_LIMITS.selector)
      throw new CaptureMetadataError('dom_limit')
    // A descendant combinator crosses the shadow boundary; > stays in a root.
    if (node && !parent) parts[0] = ` ${parts[0]}`
  }
  return parts.join(' > ').replaceAll(' >  ', ' ')
}
export function localDocumentUrl(document: Document): string | null {
  if (!/^https?:/.test(document.location.href)) return null
  return captureUrl(document.location.href)
}
const composedParent = (node: Element): Element | null =>
  node.parentElement ??
  (node.getRootNode() instanceof ShadowRoot
    ? (node.getRootNode() as ShadowRoot).host
    : null)
function axisAligned(element: Element): boolean {
  for (let node: Element | null = element; node; node = composedParent(node)) {
    const style = node.ownerDocument.defaultView!.getComputedStyle(node)
    if (
      style.scale !== 'none' &&
      style.scale
        .split(/\s+/)
        .some(
          (part) => !Number.isFinite(parseFloat(part)) || parseFloat(part) <= 0,
        )
    )
      return false
    if (
      style.perspective !== 'none' ||
      (style.rotate !== 'none' && style.rotate !== '0deg')
    )
      return false
    if (style.transform !== 'none') {
      const matrix = new DOMMatrixReadOnly(style.transform)
      if (
        !matrix.is2D ||
        matrix.b !== 0 ||
        matrix.c !== 0 ||
        matrix.a <= 0 ||
        matrix.d <= 0
      )
        return false
    }
  }
  return true
}

/** Isolated-world collector. Keeps only geometry, UUIDs and a mutation counter;
 * MutationObserver records are discarded without reading old/typed values. */
export class FrameTracker {
  readonly manual = new ManualRedactions()
  private revision = 0
  private roots = new WeakSet<Document | ShadowRoot>()
  private tokens = new WeakMap<Element, string>()
  private windows = new Map<string, Window>()
  private observers: MutationObserver[] = []
  constructor(
    private readonly document: Document,
    readonly documentId: string,
  ) {
    this.observe(document)
  }
  private observe(root: Document | ShadowRoot) {
    if (this.roots.has(root)) return
    this.roots.add(root)
    const observer = new MutationObserver((records) => {
      if (records.some((record) => !captureUiMutation(record))) this.revision++
    })
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
    this.observers.push(observer)
  }
  snapshot(nonce: string): FrameSnapshot {
    this.windows.clear()
    const children: FrameChild[] = []
    let count = 0
    const visit = (root: Document | ShadowRoot, depth = 0) => {
      if (depth > FRAME_LIMITS.depth)
        throw new CaptureMetadataError('dom_limit')
      this.observe(root)
      for (const element of root.querySelectorAll('*')) {
        if (isCaptureUi(element)) continue
        if (++count > 12_000) throw new CaptureMetadataError('dom_limit')
        if (element.matches('iframe,frame')) {
          const frame = element as HTMLIFrameElement
          const token = this.tokens.get(frame) ?? captureId()
          this.tokens.set(frame, token)
          if (frame.contentWindow) this.windows.set(token, frame.contentWindow)
          const outer = rectOf(frame)
          const sx = outer.width / (frame.offsetWidth || 1),
            sy = outer.height / (frame.offsetHeight || 1)
          children.push({
            token,
            selector: frameSelector(frame),
            outer,
            content: {
              x: outer.x + frame.clientLeft * sx,
              y: outer.y + frame.clientTop * sy,
              width: frame.clientWidth * sx,
              height: frame.clientHeight * sy,
            },
            precise: axisAligned(frame),
          })
          if (children.length > FRAME_LIMITS.frames)
            throw new CaptureMetadataError('dom_limit')
        }
        if (element.shadowRoot) visit(element.shadowRoot, depth + 1)
      }
    }
    visit(this.document)
    // An active animation can move fields between the two snapshots. Cover the
    // viewport conservatively while any layout/paint animation is running.
    const geometryMotion = this.document
      .getAnimations()
      .some(
        (animation) =>
          animation.playState === 'running' &&
          !(
            animation.effect instanceof KeyframeEffect &&
            animation.effect.target instanceof Node &&
            isCaptureUi(animation.effect.target)
          ),
      )
    let parentSelector: string | null = null
    try {
      const frame = this.document.defaultView!.frameElement
      if (frame) parentSelector = frameSelector(frame)
    } catch {
      /* Cross-origin parent identity comes from the broker. */
    }
    for (const observer of this.observers)
      if (observer.takeRecords().some((record) => !captureUiMutation(record)))
        this.revision++
    const view = this.document.defaultView!
    return {
      schema: CAPTURE_TRANSPORT,
      nonce,
      documentId: this.documentId,
      url: localDocumentUrl(this.document),
      parentSelector,
      viewport: { width: view.innerWidth, height: view.innerHeight },
      devicePixelRatio: view.devicePixelRatio,
      revision: this.revision,
      children,
      masks: [
        ...fieldRedactions(this.document, false),
        ...visibleTextRedactions(this.document),
        ...this.manual.collect(),
      ],
      geometryMotion,
    }
  }
  probe(nonce: string, tokens: string[], type: string): void {
    for (const token of tokens)
      this.windows.get(token)?.postMessage({ type, nonce, token }, '*')
  }
}

import { computeAccessibleName, getRole } from 'dom-accessibility-api'
import type { Locator, Rect, Target } from '@stepdoc/schema'
import { rankLocators, type LocatorCandidate } from '../locators'
import { buildSelector } from '../selector'
import { createRedactionDetector, redactSensitiveText } from '../redaction'

export const DOM_CAPTURE_LIMITS = Object.freeze({
  nodes: 12_000,
  text: 250_000,
  depth: 100,
  metadata: 500,
})
export class CaptureMetadataError extends Error {
  constructor(
    public readonly code:
      | 'dom_limit'
      | 'metadata_limit'
      | 'frame_unavailable'
      | 'invalid_url'
      | 'invalid_geometry'
      | 'dom_failure',
  ) {
    super(`Capture metadata unavailable: ${code}`)
    this.name = 'CaptureMetadataError'
  }
}
const detect = createRedactionDetector()
export function safeMetadata(text: string): string {
  if (text.length > DOM_CAPTURE_LIMITS.metadata)
    throw new CaptureMetadataError('metadata_limit')
  return redactSensitiveText(text, detect(text)).replace(/\s+/gu, ' ').trim()
}
export function captureUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error()
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    throw new CaptureMetadataError('invalid_url')
  }
}
export function documentUrl(document: Document): string {
  if (/^about:(blank|srcdoc)$/.test(document.location.href)) {
    try {
      const parent = document.defaultView?.parent
      if (parent && parent !== document.defaultView)
        return documentUrl(parent.document)
    } catch {
      throw new CaptureMetadataError('frame_unavailable')
    }
  }
  return captureUrl(document.location.href)
}
export function rectOf(element: Element): Rect {
  const rect = element.getBoundingClientRect()
  const result = {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  }
  if (
    !Object.values(result).every(Number.isFinite) ||
    rect.width < 0 ||
    rect.height < 0
  )
    throw new CaptureMetadataError('invalid_geometry')
  return result
}
export function editable(element: Element): boolean {
  for (
    let node: Element | null = element;
    node;
    node = node.parentElement ?? shadowHost(node)
  ) {
    if (node.matches('input,textarea,[role="textbox"],[role="searchbox"]'))
      return true
    const value = node.getAttribute('contenteditable')
    if (value !== null) return value.toLowerCase() !== 'false'
  }
  return false
}
function shadowHost(node: Element): Element | null {
  const root = node.getRootNode()
  return root.nodeType === 11 && 'host' in root
    ? (root as ShadowRoot).host
    : null
}
function safeSelector(element: Element): string {
  const selector = buildSelector(element)
  if (safeMetadata(selector) !== selector)
    throw new CaptureMetadataError('metadata_limit')
  return selector
}
export function visible(element: Element): boolean {
  for (
    let node: Element | null = element;
    node;
    node = node.parentElement ?? shadowHost(node)
  ) {
    const style = node.ownerDocument.defaultView?.getComputedStyle(node)
    if (
      node.hasAttribute('hidden') ||
      node.getAttribute('aria-hidden') === 'true' ||
      style?.display === 'none' ||
      ['hidden', 'collapse'].includes(style?.visibility ?? '')
    )
      return false
  }
  return true
}
const attributes = [
  'id',
  'role',
  'aria-label',
  'aria-labelledby',
  'aria-owns',
  'aria-hidden',
  'aria-checked',
  'aria-expanded',
  'aria-disabled',
  'aria-selected',
  'aria-level',
  'type',
  'for',
  'multiple',
  'size',
  'alt',
  'title',
  'placeholder',
  'name',
  'hidden',
]
const skipped = new Set(['script', 'style', 'noscript', 'template'])

/** A detached, inert, same-document mirror: no cloneNode, value attributes,
 * control values, editable descendants, active URLs or custom constructors.
 * All library traversal stays inside this fragment, including ID references. */
export class CaptureDom {
  readonly originals: Element[] = []
  readonly mirrors = new Map<Element, Element>()
  private readonly reverse = new Map<Element, Element>()
  private readonly names = new Map<Element, string>()
  private nodes = 0
  private text = 0
  constructor(readonly root: Document | ShadowRoot) {
    const fragment =
      root.ownerDocument?.createDocumentFragment() ??
      (root as Document).createDocumentFragment()
    const source =
      root.nodeType === 9 ? (root as Document).documentElement : root
    if (source.nodeType === 1) fragment.append(this.copy(source, 0))
    else
      for (const node of source.childNodes) fragment.append(this.copy(node, 0))
    // Chromium does not associate detached controls with <label for> even in
    // the same fragment. Supply only their already-sanitized label mirrors.
    for (const original of this.originals)
      if ('labels' in original) {
        const mirror = this.mirrors.get(original)!
        Object.defineProperty(mirror, 'labels', {
          get: () =>
            Array.from((original as HTMLInputElement).labels ?? [])
              .map((label) => this.mirrors.get(label))
              .filter((label): label is Element => !!label),
        })
      }
  }
  private copy(node: Node, depth: number): Node {
    if (
      ++this.nodes > DOM_CAPTURE_LIMITS.nodes ||
      depth > DOM_CAPTURE_LIMITS.depth
    )
      throw new CaptureMetadataError('dom_limit')
    const doc = node.ownerDocument!
    if (node.nodeType === 3) {
      const text = node.nodeValue ?? ''
      this.text += text.length
      if (this.text > DOM_CAPTURE_LIMITS.text)
        throw new CaptureMetadataError('dom_limit')
      return doc.createTextNode(text)
    }
    if (node.nodeType !== 1) return doc.createTextNode('')
    const element = node as Element
    if (skipped.has(element.localName)) return doc.createTextNode('')
    const copy = doc.createElementNS(
      element.namespaceURI,
      element.localName.includes('-') ? 'div' : element.localName,
    )
    this.originals.push(element)
    this.mirrors.set(element, copy)
    this.reverse.set(copy, element)
    for (const name of attributes) {
      const value = element.getAttribute(name)
      if (value !== null) copy.setAttribute(name, value)
    }
    if (element.hasAttribute('href')) copy.setAttribute('href', '/')
    if (element.matches('input,textarea,select'))
      Object.defineProperty(copy, 'value', { get: () => '' })
    if (element.localName === 'option')
      (copy as HTMLOptionElement).selected = (
        element as HTMLOptionElement
      ).selected
    if (!editable(element)) {
      const children =
        element.localName === 'slot'
          ? (element as HTMLSlotElement).assignedNodes({ flatten: true })
          : []
      for (const child of children.length ? children : element.childNodes)
        copy.append(this.copy(child, depth + 1))
    }
    return copy
  }
  role(element: Element): string | undefined {
    const mirror = this.mirrors.get(element)
    return mirror ? (getRole(mirror) ?? undefined) : undefined
  }
  name(element: Element): string {
    const cached = this.names.get(element)
    if (cached !== undefined) return cached
    const mirror = this.mirrors.get(element)
    if (!mirror) return ''
    const name = computeAccessibleName(mirror, {
      computedStyleSupportsPseudoElements: false,
      getComputedStyle: (node) => {
        const original = this.reverse.get(node)
        if (!original) throw new CaptureMetadataError('dom_failure')
        return original.ownerDocument.defaultView!.getComputedStyle(original)
      },
    })
      .replace(/\s+/gu, ' ')
      .trim()
    if (name.length > DOM_CAPTURE_LIMITS.metadata)
      throw new CaptureMetadataError('metadata_limit')
    this.names.set(element, name)
    return name
  }
  private textOf(element: Element): string {
    return (this.mirrors.get(element)?.textContent ?? '')
      .replace(/\s+/gu, ' ')
      .trim()
  }
  private matches(element: Element, locator: Locator): boolean {
    const compare = (value: string | null) =>
      locator.exact ? value === locator.value : !!value?.includes(locator.value)
    switch (locator.strategy) {
      case 'role':
        return (
          this.role(element) === locator.value &&
          (locator.name === undefined || this.name(element) === locator.name) &&
          visible(element)
        )
      case 'testId':
        return compare(element.getAttribute('data-testid'))
      case 'label':
        return (
          (element.hasAttribute('aria-label') ||
            element.hasAttribute('aria-labelledby') ||
            ('labels' in element &&
              !!(element as HTMLInputElement).labels?.length)) &&
          compare(this.name(element))
        )
      case 'placeholder':
        return compare(element.getAttribute('placeholder'))
      case 'altText':
        return compare(element.getAttribute('alt'))
      case 'title':
        return compare(element.getAttribute('title'))
      case 'text':
        return (
          !editable(element) &&
          compare(this.textOf(element)) &&
          !Array.from(element.children).some((child) =>
            compare(this.textOf(child)),
          )
        )
      default:
        return false
    }
  }
  target(element: Element, frame?: string[]): Target {
    const role = this.role(element),
      rawName = this.name(element),
      name = safeMetadata(rawName)
    const candidates: LocatorCandidate[] = []
    if (role && rawName === name)
      candidates.push({ strategy: 'role', value: role, ...(name && { name }) })
    const add = (strategy: Locator['strategy'], value: string | null) => {
      if (value && safeMetadata(value) === value)
        candidates.push({ strategy, value })
    }
    add('testId', element.getAttribute('data-testid'))
    if (
      rawName === name &&
      (element.hasAttribute('aria-label') ||
        element.hasAttribute('aria-labelledby') ||
        ('labels' in element && !!(element as HTMLInputElement).labels?.length))
    )
      add('label', rawName)
    add('placeholder', element.getAttribute('placeholder'))
    add('altText', element.getAttribute('alt'))
    add('title', element.getAttribute('title'))
    if (
      !editable(element) &&
      this.textOf(element).length <= DOM_CAPTURE_LIMITS.metadata
    )
      add('text', this.textOf(element))
    const selector = buildSelector(element)
    add('css', selector)
    const locators = rankLocators(candidates, (locator) =>
      locator.strategy === 'css'
        ? this.root.querySelectorAll(locator.value).length
        : this.originals.filter((item) => this.matches(item, locator)).length,
    )
    return {
      tag: element.localName,
      ...(role && { role }),
      ...(name && { name }),
      locators,
      rect: rectOf(element),
      shadowPath: shadowPath(element),
      frame: frame ?? frameChain(element.ownerDocument.defaultView!),
    }
  }
}
export function shadowPath(element: Element): string[] {
  const result: string[] = []
  for (let host = shadowHost(element); host; host = shadowHost(host))
    result.unshift(safeSelector(host))
  return result
}
export function frameChain(window: Window): string[] {
  const result: string[] = []
  let current = window
  try {
    while (current !== current.top) {
      const frame = current.frameElement
      if (!frame) throw new CaptureMetadataError('frame_unavailable')
      result.unshift([...shadowPath(frame), safeSelector(frame)].join(' '))
      current = current.parent
      if (result.length > 20) throw new CaptureMetadataError('dom_limit')
    }
  } catch {
    throw new CaptureMetadataError('frame_unavailable')
  }
  return result
}
export function captureTarget(element: Element, frame?: string[]): Target {
  try {
    return new CaptureDom(
      element.getRootNode() as Document | ShadowRoot,
    ).target(element, frame)
  } catch (error) {
    if (error instanceof CaptureMetadataError) throw error
    throw new CaptureMetadataError('dom_failure')
  }
}

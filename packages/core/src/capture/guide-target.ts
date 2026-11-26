import type { Locator, Target } from '@stepdoc/schema'
import { rankLocators } from '../locators'
import {
  CaptureDom,
  CaptureMetadataError,
  DOM_CAPTURE_LIMITS,
  visible,
  rectOf,
} from './dom'
import { isCaptureUi } from './owned-ui'

type Scope = Document | ShadowRoot
export interface TargetResolution {
  element?: Element
  strategy?: Locator['strategy']
  reason: 'matched' | 'missing' | 'ambiguous' | 'unavailable'
}
/** Query Playwright-style CSS descendants through open roots. Combinators are
 * parsed outside quoted attributes/functions; no page text or values are read. */
function split(input: string, separators: string) {
  const parts: string[] = []
  let start = 0,
    depth = 0,
    quote = '',
    escaped = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      if (/[0-9a-f]/i.test(input[i + 1] ?? '')) {
        let digits = 0
        while (digits < 6 && /[0-9a-f]/i.test(input[i + 1] ?? '')) {
          i++
          digits++
        }
        if (/\s/u.test(input[i + 1] ?? '')) i++
      } else escaped = true
      continue
    }
    if (quote) {
      if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '[' || c === '(') depth++
    if (c === ']' || c === ')') depth--
    const whitespace = /[ \t\r\n\f]/u.test(c)
    if (
      !depth &&
      (separators.includes(c) || (separators.includes(' ') && whitespace))
    ) {
      if (input.slice(start, i).trim()) parts.push(input.slice(start, i).trim())
      if (!whitespace) parts.push(c)
      start = i + 1
    }
  }
  if (input.slice(start).trim()) parts.push(input.slice(start).trim())
  if (depth || quote || escaped || parts.length > 100)
    throw new Error('Invalid selector')
  return parts
}
function parent(element: Element): Element | null {
  return (
    element.assignedSlot ??
    element.parentElement ??
    (element.getRootNode() instanceof ShadowRoot
      ? (element.getRootNode() as ShadowRoot).host
      : null)
  )
}
export function guideRoots(root: Scope): Scope[] {
  const roots: Scope[] = [],
    seen = new Set<Element>()
  const visit = (scope: Scope, depth: number) => {
    if (depth > 20) throw new CaptureMetadataError('dom_limit')
    roots.push(scope)
    for (const element of scope.querySelectorAll('*')) {
      if (isCaptureUi(element)) continue
      seen.add(element)
      if (seen.size > DOM_CAPTURE_LIMITS.nodes)
        throw new CaptureMetadataError('dom_limit')
      if (element.shadowRoot) visit(element.shadowRoot, depth + 1)
    }
  }
  visit(root, 0)
  return roots
}
export function guideCss(root: Scope, selector: string): Element[] {
  if (!selector.trim() || selector.length > 2_000) return []
  const roots = guideRoots(root)
  const result = new Set<Element>()
  const escapedMatches = new Map<string, Set<Element>>()
  const matchesCompound = (element: Element, selector: string) => {
    if (element.matches(selector)) return true
    if (!selector.includes('\\')) return false
    // Some selector engines differ between matches() and querySelectorAll() for
    // CSS hex escapes. Keep the browser's parser and cache each scoped query.
    let matches = escapedMatches.get(selector)
    if (!matches) {
      matches = new Set(
        roots.flatMap((scope) => [...scope.querySelectorAll(selector)]),
      )
      escapedMatches.set(selector, matches)
    }
    return matches.has(element)
  }
  for (const scope of roots) {
    if (selector.includes(':scope') && scope !== root) continue
    try {
      for (const item of scope.querySelectorAll(selector)) result.add(item)
    } catch {
      /* Try composed chains below. */
    }
  }
  for (const group of split(selector, ',').filter((part) => part !== ',')) {
    if (group.includes(':scope')) continue
    const parts = split(group, ' >+~')
    const match = (element: Element | null, at: number, depth = 0): boolean => {
      if (!element || depth > 100 || !matchesCompound(element, parts[at]!))
        return false
      if (!at) return true
      const relation = parts[at - 1]
      if (relation === '>') return match(parent(element), at - 2, depth + 1)
      if (relation === '+')
        return match(element.previousElementSibling, at - 2, depth + 1)
      if (relation === '~') {
        for (
          let node = element.previousElementSibling;
          node;
          node = node.previousElementSibling
        )
          if (match(node, at - 2, depth + 1)) return true
        return false
      }
      for (
        let node = parent(element), n = 0;
        node && n < 100;
        node = parent(node), n++
      )
        if (match(node, at - 1, depth + 1)) return true
      return false
    }
    try {
      for (const scope of roots)
        for (const element of scope.querySelectorAll('*'))
          if (!isCaptureUi(element) && match(element, parts.length - 1))
            result.add(element)
    } catch {
      /* Unsupported native pseudo-classes are not guessed. */
    }
  }
  return [...result].filter(
    (element) => !isCaptureUi(element) && visible(element),
  )
}
export function resolveGuideTarget(
  document: Document,
  target: Target,
): TargetResolution {
  try {
    let root: Scope = document
    for (const selector of target.shadowPath ?? []) {
      const hosts = guideCss(root, selector)
      if (hosts.length !== 1 || !hosts[0]!.shadowRoot)
        return { reason: hosts.length > 1 ? 'ambiguous' : 'missing' }
      root = hosts[0]!.shadowRoot!
    }
    const roots = guideRoots(root)
    const mirrors = roots.map((scope) => new CaptureDom(scope))
    const candidates: Locator[] = [
      ...(target.role
        ? [
            {
              strategy: 'role' as const,
              value: target.role,
              ...(target.name !== undefined && { name: target.name }),
              exact: true,
            },
          ]
        : []),
      ...rankLocators(target.locators ?? []),
    ]
    if (candidates.length > 100) return { reason: 'unavailable' }
    let ambiguous = false
    for (const locator of candidates) {
      let matches: Element[] = []
      if (locator.strategy === 'css') {
        try {
          matches = guideCss(root, locator.value)
        } catch {
          continue
        }
      } else
        matches = [
          ...new Set(mirrors.flatMap((mirror) => mirror.query(locator))),
        ]
      matches = matches.filter((element) => {
        const rect = rectOf(element)
        return (
          element.isConnected &&
          visible(element) &&
          rect.width > 0 &&
          rect.height > 0
        )
      })
      if (matches.length === 1)
        return {
          element: matches[0],
          strategy: locator.strategy,
          reason: 'matched',
        }
      if (matches.length > 1) ambiguous = true
    }
    return { reason: ambiguous ? 'ambiguous' : 'missing' }
  } catch {
    return { reason: 'unavailable' }
  }
}

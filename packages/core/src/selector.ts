type SelectorRoot = Document | DocumentFragment | Element

/** CSSOM identifier escaping, including leading digits and control characters. */
export function cssEscape(value: string): string {
  if (typeof globalThis.CSS?.escape === 'function')
    return globalThis.CSS.escape(value)
  let result = ''
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    const character = value.charAt(index)
    if (code === 0) result += '\uFFFD'
    else if (
      (code >= 1 && code <= 31) ||
      code === 127 ||
      (index === 0 && code >= 48 && code <= 57) ||
      (index === 1 && code >= 48 && code <= 57 && value.charAt(0) === '-')
    )
      result += `\\${code.toString(16)} `
    else if (index === 0 && character === '-' && value.length === 1)
      result += '\\-'
    else if (
      code >= 128 ||
      character === '-' ||
      character === '_' ||
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    )
      result += character
    else result += `\\${character}`
  }
  return result
}

function matches(root: SelectorRoot, selector: string): Element[] {
  try {
    const result = [...root.querySelectorAll(selector)]
    if (root.nodeType === 1 && (root as Element).matches(selector))
      result.unshift(root as Element)
    return result
  } catch {
    return []
  }
}

function unique(
  root: SelectorRoot,
  selector: string,
  element: Element,
): boolean {
  const found = matches(root, selector)
  return found.length === 1 && found[0] === element
}

/** v1 CSS fallback. Identity checks and sibling positions are scoped to its DOM root. */
export function buildSelector(element: Element): string {
  const root = element.getRootNode() as SelectorRoot
  if (element.id) {
    const selector = `#${cssEscape(element.id)}`
    if (unique(root, selector, element)) return selector
  }
  const testId = element.getAttribute('data-testid')
  if (testId) {
    const selector = `[data-testid="${cssEscape(testId)}"]`
    if (unique(root, selector, element)) return selector
  }
  const parts: string[] = []
  let node: Element | null = element
  while (node && node.localName !== 'html' && parts.length < 5) {
    if (node !== element && node.id) {
      const anchor = `#${cssEscape(node.id)}`
      if (unique(root, anchor, node)) {
        parts.unshift(anchor)
        break
      }
    }
    let part = node.localName
    const name = node.getAttribute('name')
    if (name) part += `[name="${cssEscape(name)}"]`
    const siblings = [...(node.parentNode?.childNodes ?? [])].filter(
      (sibling): sibling is Element =>
        sibling.nodeType === 1 &&
        (sibling as Element).localName === node!.localName,
    )
    if (
      siblings.length > 1 &&
      (!name ||
        siblings.filter((sibling) => sibling.getAttribute('name') === name)
          .length > 1)
    ) {
      part += `:nth-of-type(${siblings.indexOf(node) + 1})`
    }
    parts.unshift(part)
    node = node.parentElement
  }
  return parts.join(' > ') || element.localName
}

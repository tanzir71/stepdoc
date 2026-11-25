import type { StepInput } from '@stepdoc/schema'

export interface Description {
  text: string
  lowConfidence: boolean
}

/** The metadata needed by the v1 text rules; it deliberately has no value field. */
export interface DescriptionMetadata {
  event: 'click' | 'input' | 'select' | 'submit' | 'navigation'
  tag: string
  url: string
  label?: string
  ariaLabel?: string
  innerText?: string
  placeholder?: string
  alt?: string
  title?: string
  name?: string
  role?: string
  inputType?: string
  optionLabel?: string
}

export type GuideDescriptionInput = Partial<
  Pick<
    StepInput,
    'type' | 'title' | 'action' | 'target' | 'value' | 'key' | 'url'
  >
>

export function sanitizeLabel(value?: string): string | undefined {
  if (!value) return undefined
  const clean = value.replace(/\s+/g, ' ').trim()
  if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return undefined
  const characters = [...clean]
  return characters.length > 40
    ? `${characters.slice(0, 39).join('').trimEnd()}…`
    : clean
}

function namedLabel(meta: DescriptionMetadata): string | undefined {
  // Text inside an editable element can be a typed value, even without .value.
  return [
    meta.label,
    meta.ariaLabel,
    meta.event === 'input' ||
    ['input', 'textarea'].includes(meta.tag.toLowerCase())
      ? undefined
      : meta.innerText,
    meta.placeholder,
    meta.alt,
    meta.title,
    meta.name,
  ]
    .map(sanitizeLabel)
    .find((label) => label !== undefined)
}

export function resolveLabel(meta: DescriptionMetadata): string | undefined {
  return namedLabel(meta) ?? sanitizeLabel(meta.role)
}

function describeNavigation(value?: string | null): Description {
  try {
    const url = new URL(value ?? '')
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Unsupported page URL')
    const path = url.pathname === '/' ? '' : url.pathname
    const characters = [...path]
    const shortened =
      characters.length > 48 ? `${characters.slice(0, 47).join('')}…` : path
    return { text: `Go to ${url.host}${shortened}`, lowConfidence: false }
  } catch {
    return { text: 'Go to the page', lowConfidence: true }
  }
}

/** v1 capture rules, shared by the existing extension and guide@1 consumers. */
export function describeStep(meta: DescriptionMetadata): Description {
  if (meta.event === 'navigation') return describeNavigation(meta.url)
  if (meta.event === 'submit')
    return { text: 'Press Enter to submit', lowConfidence: false }
  const name = namedLabel(meta)
  const label = name ?? sanitizeLabel(meta.role)
  if (meta.event === 'input')
    return {
      text: `Fill in the "${label ?? 'text'}" field`,
      lowConfidence: !name,
    }
  if (meta.event === 'select') {
    const option = sanitizeLabel(meta.optionLabel)
    return {
      text: `Select "${option ?? 'an option'}" from the "${label ?? 'dropdown'}" dropdown`,
      lowConfidence: !name || !option,
    }
  }
  if (['checkbox', 'radio'].includes(meta.inputType ?? '')) {
    return {
      text: `${meta.inputType === 'checkbox' ? 'Check' : 'Select'} "${label ?? 'option'}"`,
      lowConfidence: !name,
    }
  }
  return {
    text: label ? `Click "${label}"` : 'Click here',
    lowConfidence: !name,
  }
}

/** Generate an instruction from guide@1 metadata. Fill/upload values are never read. */
export function describeGuideStep(step: GuideDescriptionInput): Description {
  if (step.type === 'manual' || step.type === 'section') {
    const title = step.title?.trim()
    return {
      text:
        title ||
        (step.type === 'section' ? 'New section' : 'Describe this step'),
      lowConfidence: !title,
    }
  }
  if (step.action === 'navigate' || step.type === 'navigate')
    return describeNavigation(step.url)
  const label = sanitizeLabel(step.target?.name)
  switch (step.action) {
    case 'fill':
      return {
        text: `Fill in the "${label ?? 'text'}" field`,
        lowConfidence: !label,
      }
    case 'upload':
      return {
        text: `Choose a file for "${label ?? 'upload'}"`,
        lowConfidence: !label,
      }
    case 'select': {
      const value = step.value
      const option =
        value?.kind === 'literal' ? sanitizeLabel(value.literal) : undefined
      return {
        text: `Select "${option ?? 'an option'}" from the "${label ?? 'dropdown'}" dropdown`,
        lowConfidence:
          !label ||
          (!option && value?.kind !== 'variable' && value?.kind !== 'secret'),
      }
    }
    case 'press': {
      const key = step.key === ' ' ? 'Space' : sanitizeLabel(step.key)
      const literal = key ? undefined : step.value
      const name =
        key ??
        (literal?.kind === 'literal'
          ? sanitizeLabel(literal.literal)
          : undefined)
      return {
        text: name ? `Press ${name}` : 'Press a key',
        lowConfidence: !name,
      }
    }
    case 'check':
      return {
        text: `${step.target?.role === 'radio' ? 'Select' : 'Check'} "${label ?? 'option'}"`,
        lowConfidence: !label,
      }
    case 'uncheck':
      return { text: `Uncheck "${label ?? 'option'}"`, lowConfidence: !label }
    case 'click':
      return {
        text: label ? `Click "${label}"` : 'Click here',
        lowConfidence: !label,
      }
    case 'dblclick':
      return {
        text: label ? `Double-click "${label}"` : 'Double-click here',
        lowConfidence: !label,
      }
    case 'hover':
      return {
        text: label ? `Hover over "${label}"` : 'Hover over the target',
        lowConfidence: !label,
      }
    case 'assert':
      return {
        text: label ? `Verify "${label}"` : 'Verify the expected result',
        lowConfidence: !label,
      }
    case 'wait':
      return {
        text: label ? `Wait for "${label}"` : 'Wait for the next step',
        lowConfidence: !label,
      }
    default:
      return {
        text: step.title?.trim() || 'Describe this step',
        lowConfidence: true,
      }
  }
}

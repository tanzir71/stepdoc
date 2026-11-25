import {
  guideSchema,
  type Guide,
  type GuideInput,
  type Step,
} from '@stepdoc/schema'

export class GuideExportError extends Error {
  constructor(
    public readonly code:
      | 'invalid_guide'
      | 'invalid_options'
      | 'invalid_url'
      | 'invalid_image',
  ) {
    super(`Guide export failed: ${code}`)
    this.name = 'GuideExportError'
  }
}

export interface ExportOptions {
  /** Public guide URL, without credentials, query or fragment. Defaults to relative links. */
  canonicalUrl?: string
  /** Already flattened images, keyed by step ID. Defaults to img/step-N.webp. */
  images?: Readonly<Record<string, string>>
}

export interface ExportContext {
  guide: Guide
  canonicalUrl?: string
}

export function cleanPageUrl(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    url.username = url.password = url.search = url.hash = ''
    return url.href
  } catch {
    return null
  }
}

/** urlMatches is a path prefix, a literal HTTP URL, or a regular expression. */
export function cleanUrlMatch(value: string): string {
  if (value.startsWith('//')) throw new GuideExportError('invalid_url')
  if (value.startsWith('/') || /^https?:\/\//i.test(value)) {
    const cleaned = value.startsWith('/')
      ? value.split(/[?#]/, 1)[0]!
      : cleanPageUrl(value)
    if (!cleaned) throw new GuideExportError('invalid_url')
    return cleaned
  }
  // Strip literal query/fragment tails in regexes, preserving regex quantifiers.
  const cleaned = value
    .replace(/(:\/\/)[^/]*@/g, '$1')
    .split(/\\\?|\[\?\]|\?(?=[\w%.-]+=)|#/, 1)[0]!
  if (cleaned.includes('@')) throw new GuideExportError('invalid_url')
  try {
    new RegExp(cleaned)
  } catch {
    throw new GuideExportError('invalid_guide')
  }
  if (!cleaned) throw new GuideExportError('invalid_guide')
  return cleaned
}

function imageReference(value: string): string {
  // Embedded raster data or portable relative assets only. Never signed/original URLs.
  if (typeof value !== 'string') throw new GuideExportError('invalid_image')
  if (/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/]+={0,2}$/i.test(value))
    return value
  if (
    !value ||
    /[\\\s?#:<>"'\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith('/') ||
    value.split('/').some((part) => !part || part === '..' || part === '.') ||
    !/\.(webp|png|jpe?g)$/i.test(value) ||
    /%/i.test(value)
  )
    throw new GuideExportError('invalid_image')
  return value
}

export function prepareExport(
  input: GuideInput,
  options: ExportOptions = {},
): ExportContext {
  try {
    if (
      !options ||
      typeof options !== 'object' ||
      (options.canonicalUrl !== undefined &&
        typeof options.canonicalUrl !== 'string') ||
      (options.images !== undefined &&
        (!options.images ||
          typeof options.images !== 'object' ||
          Array.isArray(options.images)))
    )
      throw new GuideExportError('invalid_options')
    const guide = guideSchema.parse(input)
    const canonicalUrl =
      options.canonicalUrl === undefined
        ? undefined
        : cleanPageUrl(options.canonicalUrl)
    if (canonicalUrl === null) throw new GuideExportError('invalid_url')
    if (guide.app) {
      const origin = cleanPageUrl(guide.app.origin)
      if (!origin) throw new GuideExportError('invalid_url')
      guide.app.origin = origin
    }
    const ids = new Set<string>(),
      indices = new Set<number>()
    const variables = new Map(
      guide.variables.map((variable) => [variable.name, variable]),
    )
    if (variables.size !== guide.variables.length)
      throw new GuideExportError('invalid_guide')
    guide.steps.sort((a, b) => a.index - b.index)
    for (const [offset, step] of guide.steps.entries()) {
      if (ids.has(step.id) || indices.has(step.index))
        throw new GuideExportError('invalid_guide')
      ids.add(step.id)
      indices.add(step.index)
      step.index = offset + 1
      if (step.value?.kind === 'variable' || step.value?.kind === 'secret') {
        if (variables.get(step.value.variable)?.kind !== step.value.kind)
          throw new GuideExportError('invalid_guide')
      }
      if (step.url) step.url = cleanPageUrl(step.url, guide.app?.origin)
      if (step.expect?.urlMatches !== undefined)
        step.expect.urlMatches = cleanUrlMatch(step.expect.urlMatches)
      if (step.screenshot) {
        if (step.screenshot.width <= 0 || step.screenshot.height <= 0)
          throw new GuideExportError('invalid_image')
        step.screenshot.rendered = imageReference(
          options.images && Object.hasOwn(options.images, step.id)
            ? options.images[step.id]!
            : `img/step-${step.index}.webp`,
        )
        delete step.screenshot.original
      }
    }
    return { guide, ...(canonicalUrl && { canonicalUrl }) }
  } catch (error) {
    if (error instanceof GuideExportError) throw error
    // Zod/native errors can include input. Do not attach a cause or validation payload.
    throw new GuideExportError('invalid_guide')
  }
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        char
      ]!,
  )
}
export function escapeMarkdown(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\\`*_{}\[\]<>()#+.!|~-]/g, '\\$&')
}
export function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
export function js(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}
export function envName(name: string): string {
  return `STEPDOC_${name.toUpperCase()}`
}
export function stepUrl(context: ExportContext, step: Step): string {
  return `${context.canonicalUrl ?? ''}#step-${step.index}`
}
export function imageAlt(step: Step): string {
  return (
    step.screenshot?.alt ||
    (step.target?.name
      ? `The ${step.target.name}${step.target.role ? ` ${step.target.role}` : ''}`
      : `Step ${step.index}: ${step.title}`)
  )
}
export function targetText(step: Step): string {
  const target = step.target
  if (!target) return 'No captured target'
  const label = [target.role, target.name && `“${target.name}”`]
    .filter(Boolean)
    .join(' ')
  const fallback = target.locators
    ?.map(
      (locator) =>
        `${locator.strategy}: ${locator.value}${locator.name ? ` (${locator.name})` : ''}`,
    )
    .join('; ')
  return [
    label || fallback || 'No captured locator',
    target.frame?.length && `frames: ${target.frame.join(' → ')}`,
    target.shadowPath?.length &&
      `open shadow hosts: ${target.shadowPath.join(' → ')}`,
  ]
    .filter(Boolean)
    .join('; ')
}
export function valueText(step: Step): string | undefined {
  if (step.action === 'press' && step.key !== undefined)
    return `Key: ${step.key}`
  if (step.value?.kind === 'literal')
    return `${step.action === 'press' ? 'Key' : 'Option'}: ${step.value.literal}`
  if (step.value?.kind === 'variable' || step.value?.kind === 'secret')
    return `${step.value.variable} (${step.value.kind}; ${envName(step.value.variable)})`
  return undefined
}
export function expectationText(step: Step): string[] {
  const expected = step.expect
  if (!expected) return []
  const result: string[] = []
  if (expected.urlMatches !== undefined)
    result.push(`URL matches ${expected.urlMatches}`)
  for (const kind of ['visible', 'hidden'] as const) {
    const target = expected[kind]
    if (target)
      result.push(
        `${[target.role, target.name].filter(Boolean).join(' ') || 'Target'} is ${kind}`,
      )
  }
  if (expected.text)
    result.push(
      `${expected.text.role ?? 'Page'} contains ${expected.text.contains ?? '(unspecified text)'}`,
    )
  return result
}

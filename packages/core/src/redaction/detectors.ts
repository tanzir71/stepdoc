import { RE2JS } from 're2js'
import {
  isSupportedCountry,
  searchPhoneNumbersInText,
  type CountryCode,
} from 'libphonenumber-js/min'
import type { Redaction } from '@stepdoc/schema'
import {
  ibanLength,
  isIban,
  isIpv4,
  isIpv6,
  isMacAddress,
  isPaymentCard,
  shannonEntropy,
} from './checks'

export const BUILTIN_DETECTORS = [
  'email',
  'phone',
  'card',
  'iban',
  'token',
  'ip',
] as const
export type BuiltinDetector = (typeof BUILTIN_DETECTORS)[number]

/** UTF-16 offsets for Range.setStart/setEnd. No matched text is retained here. */
export interface SensitiveSpan {
  start: number
  end: number
  kind: Redaction['kind']
  rule: string
  source: 'auto' | 'policy'
}

export interface CustomRedactionRule {
  id: string
  pattern: string
  flags?: string
  kind?: Redaction['kind']
  source?: 'auto' | 'policy'
}

export interface RedactionDetectorOptions {
  enabled?: readonly BuiltinDetector[]
  customRules?: readonly CustomRedactionRule[]
  defaultPhoneCountry?: CountryCode
  tokenEntropyThreshold?: number
}

export class RedactionDetectionError extends Error {
  constructor(
    public readonly code:
      | 'invalid_options'
      | 'invalid_rule'
      | 'input_limit'
      | 'match_limit'
      | 'detector_failure',
  ) {
    super(`Redaction detection failed: ${code}`)
    this.name = 'RedactionDetectionError'
  }
}

export const REDACTION_LIMITS = Object.freeze({
  inputLength: 250_000,
  matches: 10_000,
  customRules: 32,
  patternLength: 512,
  ruleProgramSize: 2048,
  totalProgramSize: 10_000,
})
const kinds: readonly Redaction['kind'][] = [
  'password',
  'email',
  'phone',
  'card',
  'iban',
  'token',
  'ip',
  'name',
  'field',
  'custom',
]

const patterns = {
  email: RE2JS.compile(
    /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+/u
      .source,
  ),
  card: RE2JS.compile(/(?:[0-9][\s\xA0-]?){12,18}[0-9]/u.source),
  iban: RE2JS.compile(/[A-Za-z]{2}[0-9]{2}/.source),
  ipv4: RE2JS.compile(/(?:[0-9]{1,3}\.){3}[0-9]{1,3}/.source),
  ipv6: RE2JS.compile(/[0-9A-Fa-f:.]+(?:%[A-Za-z0-9_.-]+)?/.source),
  mac: RE2JS.compile(
    /(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}|(?:[0-9A-Fa-f]{2}-){5}[0-9A-Fa-f]{2}|(?:[0-9A-Fa-f]{4}\.){2}[0-9A-Fa-f]{4}/
      .source,
  ),
  prefix: RE2JS.compile(
    /(?:sk-(?:proj-|ant-(?:api[0-9]{2}-)?)?|(?:sk|rk)_(?:live|test)_|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hf_|npm_|AKIA|ASIA|AIza)[A-Za-z0-9_+/=-]{16,}/
      .source,
  ),
  jwt: RE2JS.compile(
    /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/.source,
  ),
  entropy: RE2JS.compile(/[A-Za-z0-9_+/=-]{32,}/.source),
}

function word(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}_]/u.test(character)
}
function boundary(text: string, start: number, end: number): boolean {
  return !word(text[start - 1]) && !word(text[end])
}

function compileRules(rules: readonly CustomRedactionRule[]) {
  if (rules.length > REDACTION_LIMITS.customRules)
    throw new RedactionDetectionError('invalid_options')
  const ids = new Set<string>()
  let totalSize = 0
  return rules.map((rule) => {
    if (
      typeof rule.id !== 'string' ||
      !/^[a-z][a-z0-9_-]{0,63}$/.test(rule.id) ||
      ids.has(rule.id) ||
      typeof rule.pattern !== 'string' ||
      !rule.pattern ||
      rule.pattern.length > REDACTION_LIMITS.patternLength ||
      (rule.flags !== undefined && typeof rule.flags !== 'string') ||
      !/^[gimsu]*$/.test(rule.flags ?? '') ||
      new Set(rule.flags ?? '').size !== (rule.flags ?? '').length ||
      (rule.kind !== undefined && !kinds.includes(rule.kind)) ||
      (rule.source !== undefined && !['auto', 'policy'].includes(rule.source))
    )
      throw new RedactionDetectionError('invalid_rule')
    ids.add(rule.id)
    let flags = 0
    if (rule.flags?.includes('i')) flags |= RE2JS.CASE_INSENSITIVE
    if (rule.flags?.includes('m')) flags |= RE2JS.MULTILINE
    if (rule.flags?.includes('s')) flags |= RE2JS.DOTALL
    try {
      const pattern = RE2JS.compile(rule.pattern, flags)
      totalSize += pattern.programSize()
      if (
        pattern.programSize() > REDACTION_LIMITS.ruleProgramSize ||
        totalSize > REDACTION_LIMITS.totalProgramSize ||
        pattern.test('')
      )
        throw new Error()
      return {
        pattern,
        rule: `custom-${rule.id}`,
        kind: rule.kind ?? 'custom',
        source: rule.source ?? 'policy',
      } as const
    } catch {
      // RE2 errors can contain the pattern. Never forward their message/cause.
      throw new RedactionDetectionError('invalid_rule')
    }
  })
}

/** Compile once on the client, then scan visible text only; never pass form values. */
export function createRedactionDetector(
  options: RedactionDetectorOptions = {},
) {
  const enabled = new Set(options.enabled ?? BUILTIN_DETECTORS)
  const threshold = options.tokenEntropyThreshold ?? 3.5
  const country = options.defaultPhoneCountry ?? 'US'
  if (
    [...enabled].some((kind) => !BUILTIN_DETECTORS.includes(kind)) ||
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 8 ||
    !isSupportedCountry(country)
  )
    throw new RedactionDetectionError('invalid_options')
  const custom = compileRules(options.customRules ?? [])

  const detect = (text: string): SensitiveSpan[] => {
    if (text.length > REDACTION_LIMITS.inputLength)
      throw new RedactionDetectionError('input_limit')
    const spans: SensitiveSpan[] = []
    const seen = new Set<string>()
    function add(
      start: number,
      end: number,
      kind: SensitiveSpan['kind'],
      rule: string,
      source: SensitiveSpan['source'] = 'auto',
    ) {
      if (end <= start) throw new RedactionDetectionError('invalid_rule')
      const key = `${start}:${end}:${kind}:${rule}:${source}`
      if (seen.has(key)) return
      if (spans.length >= REDACTION_LIMITS.matches)
        throw new RedactionDetectionError('match_limit')
      seen.add(key)
      spans.push({ start, end, kind, rule, source })
    }
    function scan(pattern: RE2JS, visit: (start: number, end: number) => void) {
      const matcher = pattern.matcher(text)
      while (matcher.find()) visit(matcher.start(), matcher.end())
    }

    if (enabled.has('email'))
      scan(patterns.email, (begin, end) => {
        let start = begin
        while (text[start] === '.') start++
        const local = text.slice(start, end).split('@')[0]!
        if (
          !local.endsWith('.') &&
          !local.includes('..') &&
          boundary(text, start, end)
        )
          add(start, end, 'email', 'email')
      })
    if (enabled.has('card')) {
      const matcher = patterns.card.matcher(text)
      let next = 0
      while (matcher.find(next)) {
        const start = matcher.start()
        const end = matcher.end()
        next = end
        if (/[0-9]/.test(text[start - 1] ?? '')) continue
        const digitEnds: number[] = []
        for (let index = start; index < end; index++)
          if (/[0-9]/.test(text[index]!)) digitEnds.push(index + 1)
        // A following card can otherwise extend a greedy numeric candidate past
        // the first card. Resume at its verified end so neither card is missed.
        for (const candidateEnd of digitEnds.slice(12).reverse()) {
          if (
            !/[0-9]/.test(text[candidateEnd] ?? '') &&
            isPaymentCard(text.slice(start, candidateEnd))
          ) {
            add(start, candidateEnd, 'card', 'card')
            next = candidateEnd
            break
          }
        }
      }
    }
    if (enabled.has('iban'))
      scan(patterns.iban, (start) => {
        if (word(text[start - 1])) return
        const length = ibanLength(text.slice(start, start + 2))
        if (!length) return
        let end = start
        let count = 0
        while (end < text.length && count < length) {
          const character = text[end]!
          if (/[A-Za-z0-9]/.test(character)) count++
          else if (!/\s/.test(character)) break
          end++
        }
        if (
          count === length &&
          !word(text[end]) &&
          isIban(text.slice(start, end))
        )
          add(start, end, 'iban', 'iban')
      })
    if (enabled.has('ip')) {
      scan(patterns.ipv4, (start, end) => {
        const continued =
          (text[start - 1] === '.' && /[0-9]/.test(text[start - 2] ?? '')) ||
          (text[end] === '.' && /[0-9]/.test(text[end + 1] ?? ''))
        if (
          !continued &&
          boundary(text, start, end) &&
          isIpv4(text.slice(start, end))
        )
          add(start, end, 'ip', 'ipv4')
      })
      scan(patterns.ipv6, (start, finish) => {
        let end = finish
        while (text[end - 1] === '.') end--
        if (boundary(text, start, end) && isIpv6(text.slice(start, end)))
          add(start, end, 'ip', 'ipv6')
      })
      scan(patterns.mac, (start, end) => {
        if (
          ![':', '-'].includes(text[start - 1] ?? '') &&
          ![':', '-'].includes(text[end] ?? '') &&
          boundary(text, start, end) &&
          isMacAddress(text.slice(start, end))
        )
          add(start, end, 'ip', 'mac')
      })
    }
    if (enabled.has('phone')) {
      // A comma can mean a dial extension to the parser. Separate adjacent full
      // phone numbers first, preserving UTF-16 positions, then include short extensions.
      for (const match of searchPhoneNumbersInText(
        text.replace(/[,;]/g, '|'),
        country,
      )) {
        let end = match.endsAt
        const extension = /^[,;]+[ \t]*[0-9]{1,6}(?![0-9])/.exec(
          text.slice(end),
        )
        if (
          extension &&
          !/^[ .-]*[0-9]/.test(text.slice(end + extension[0].length))
        )
          end += extension[0].length
        const value = text.slice(match.startsAt, end)
        if (!isPaymentCard(value) && !isIpv4(value) && !isMacAddress(value))
          add(match.startsAt, end, 'phone', 'phone')
      }
    }
    if (enabled.has('token')) {
      scan(patterns.prefix, (start, end) => {
        if (boundary(text, start, end)) add(start, end, 'token', 'token-prefix')
      })
      scan(patterns.jwt, (start, end) => {
        if (boundary(text, start, end)) add(start, end, 'token', 'token-jwt')
      })
      scan(patterns.entropy, (start, end) => {
        const value = text.slice(start, end)
        if (
          boundary(text, start, end) &&
          /[A-Za-z]/.test(value) &&
          (/[0-9]/.test(value) ||
            (/[a-z]/.test(value) && /[A-Z]/.test(value))) &&
          shannonEntropy(value) >= threshold
        )
          add(start, end, 'token', 'token-entropy')
      })
    }
    for (const rule of custom)
      scan(rule.pattern, (start, end) =>
        add(start, end, rule.kind, rule.rule, rule.source),
      )
    return spans.sort(
      (a, b) =>
        a.start - b.start || b.end - a.end || a.rule.localeCompare(b.rule),
    )
  }
  return (text: string): SensitiveSpan[] => {
    try {
      return detect(text)
    } catch (error) {
      if (error instanceof RedactionDetectionError) throw error
      throw new RedactionDetectionError('detector_failure')
    }
  }
}

/** Mask the union of overlapping detector ranges without emitting matched values. */
export function redactSensitiveText(
  text: string,
  spans: readonly Pick<SensitiveSpan, 'start' | 'end'>[],
): string {
  const ordered = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: Array<{ start: number; end: number }> = []
  for (const span of ordered) {
    if (
      !Number.isInteger(span.start) ||
      !Number.isInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > text.length
    )
      throw new RedactionDetectionError('invalid_options')
    const previous = merged.at(-1)
    if (previous && span.start <= previous.end)
      previous.end = Math.max(previous.end, span.end)
    else merged.push({ start: span.start, end: span.end })
  }
  let result = ''
  let position = 0
  for (const span of merged) {
    result += `${text.slice(position, span.start)}[REDACTED]`
    position = span.end
  }
  return result + text.slice(position)
}

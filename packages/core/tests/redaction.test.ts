import { describe, expect, it } from 'vitest'
import { redactionSchema } from '@stepdoc/schema'
import {
  createRedactionDetector,
  REDACTION_LIMITS,
  RedactionDetectionError,
  redactSensitiveText,
  type CustomRedactionRule,
  type RedactionDetectorOptions,
} from '../src/redaction'

describe('visible-text pattern detectors', () => {
  const detect = createRedactionDetector()
  it.each([
    'alice@example.com',
    'alice+ops@sub.example.co.uk',
    '用户@例子.公司',
  ])('finds email %s without returning its value', (value) => {
    const text = `Contact (${value}).`
    const result = createRedactionDetector({ enabled: ['email'] })(text)
    expect(result).toEqual([
      {
        start: text.indexOf(value),
        end: text.indexOf(value) + value.length,
        kind: 'email',
        rule: 'email',
        source: 'auto',
      },
    ])
    expect(JSON.stringify(result)).not.toContain(value)
  })
  it.each([
    'a..b@example.com',
    'alice@-example.com',
    'not-an-address',
    'user@localhost',
  ])('ignores invalid email %s', (value) =>
    expect(createRedactionDetector({ enabled: ['email'] })(value)).toEqual([]),
  )

  it.each(['4111 1111 1111 1111', '5555-5555-5555-4444', '378282246310005'])(
    'finds a Luhn-valid card %s',
    (value) => {
      expect(
        createRedactionDetector({ enabled: ['card'] })(`Card: ${value}.`),
      ).toEqual([
        {
          start: 6,
          end: 6 + value.length,
          kind: 'card',
          rule: 'card',
          source: 'auto',
        },
      ])
    },
  )
  it.each(['4111111111111112', '0000000000000000', '41111111111111111111'])(
    'ignores invalid cards %s',
    (value) =>
      expect(createRedactionDetector({ enabled: ['card'] })(value)).toEqual([]),
  )
  it('does not lose either of two space-separated cards to a greedy numeric match', () => {
    const text = '4111 1111 1111 1111 5555 5555 5555 4444'
    const spans = createRedactionDetector({ enabled: ['card'] })(text)
    expect(spans).toHaveLength(2)
    expect(redactSensitiveText(text, spans)).toBe('[REDACTED] [REDACTED]')
  })

  it.each([
    'GB82 WEST 1234 5698 7654 32',
    'DE89370400440532013000',
    'FR14 2004 1010 0505 0001 3M02 606',
  ])('finds the complete IBAN before trailing prose: %s', (value) => {
    expect(
      createRedactionDetector({ enabled: ['iban'] })(
        `Send to ${value} before Friday.`,
      ),
    ).toEqual([
      {
        start: 8,
        end: 8 + value.length,
        kind: 'iban',
        rule: 'iban',
        source: 'auto',
      },
    ])
  })
  it('does not accept a checksum-corrupt or truncated IBAN', () => {
    expect(
      createRedactionDetector({ enabled: ['iban'] })(
        'DE89370400440532013001 GB82WEST1234569876543',
      ),
    ).toEqual([])
  })

  it.each([
    '+1 (415) 555-2671',
    '+44 20 7946 0958',
    '+49 30 12345678',
    '+880 1712 345678',
    '415-555-2671',
  ])('finds international or default-US phone %s', (value) => {
    const text = `Call ${value} now.`
    expect(createRedactionDetector({ enabled: ['phone'] })(text)).toEqual([
      {
        start: 5,
        end: 5 + value.length,
        kind: 'phone',
        rule: 'phone',
        source: 'auto',
      },
    ])
  })
  it('supports a different national dialing country and adjacent phone numbers', () => {
    expect(
      createRedactionDetector({
        enabled: ['phone'],
        defaultPhoneCountry: 'GB',
      })('Call 020 7946 0958.'),
    ).toHaveLength(1)
    expect(
      createRedactionDetector({ enabled: ['phone'] })(
        '415-555-2671, 212-555-0123',
      ),
    ).toHaveLength(2)
    expect(
      createRedactionDetector({ enabled: ['phone'] })('415-555-2671,123'),
    ).toEqual([
      { start: 0, end: 16, kind: 'phone', rule: 'phone', source: 'auto' },
    ])
  })
  it('ignores dates, card numbers and impossible phone numbers', () => {
    expect(
      createRedactionDetector({ enabled: ['phone'] })(
        '2026-11-25 4111 1111 1111 1111 +999 000 0000',
      ),
    ).toEqual([])
  })

  it.each([
    ['192.168.1.24', 'ipv4'],
    ['2001:db8::1', 'ipv6'],
    ['::ffff:192.0.2.1', 'ipv6'],
    ['fe80::1%eth0', 'ipv6'],
    ['00:11:22:33:44:55', 'mac'],
    ['aa-bb-cc-dd-ee-ff', 'mac'],
    ['AABB.CCDD.EEFF', 'mac'],
  ])('finds IP/MAC %s', (value, rule) => {
    const text = `Address [${value}].`
    expect(createRedactionDetector({ enabled: ['ip'] })(text)).toContainEqual({
      start: 9,
      end: 9 + value.length,
      kind: 'ip',
      rule,
      source: 'auto',
    })
  })
  it.each([
    '999.1.1.1',
    '2001::db8::1',
    '12345::1',
    '1.2.3.4.5',
    '00:11:22:33:44:55:66',
  ])('does not match pieces of invalid address %s', (value) =>
    expect(createRedactionDetector({ enabled: ['ip'] })(value)).toEqual([]),
  )

  it('finds prefixed secrets even when their entropy is low', () => {
    for (const prefix of [
      'sk-',
      'sk-proj-',
      'sk-ant-api03-',
      'ghp_',
      'github_pat_',
      'glpat-',
      'xoxb-',
      'hf_',
      'npm_',
      'sk_live_',
      'AKIA',
      'ASIA',
      'AIza',
    ]) {
      const value = `${prefix}${'a'.repeat(32)}`
      expect(
        createRedactionDetector({ enabled: ['token'] })(value),
      ).toContainEqual({
        start: 0,
        end: value.length,
        kind: 'token',
        rule: 'token-prefix',
        source: 'auto',
      })
    }
  })
  it('uses entropy for unprefixed opaque strings and supports a threshold', () => {
    const value = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL'
    expect(
      createRedactionDetector({ enabled: ['token'] })(value),
    ).toContainEqual({
      start: 0,
      end: value.length,
      kind: 'token',
      rule: 'token-entropy',
      source: 'auto',
    })
    expect(
      createRedactionDetector({ enabled: ['token'], tokenEntropyThreshold: 8 })(
        value,
      ),
    ).toEqual([])
    expect(
      createRedactionDetector({ enabled: ['token'] })('a'.repeat(100)),
    ).toEqual([])
  })
  it('covers a complete JWT rather than exposing its other segments', () => {
    const value =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaWN0aW9uYWwifQ.abcdefghijklmnopqrstuvwxyz012345'
    expect(
      createRedactionDetector({ enabled: ['token'] })(value),
    ).toContainEqual({
      start: 0,
      end: value.length,
      kind: 'token',
      rule: 'token-jwt',
      source: 'auto',
    })
  })

  it('returns UTF-16 offsets after astral characters and schema-compatible metadata', () => {
    const text = '😀 Contact alice@example.com'
    const spans = detect(text)
    expect(spans[0]?.start).toBe(11)
    expect(redactSensitiveText(text, spans)).toBe('😀 Contact [REDACTED]')
    for (const { kind, rule, source } of spans) {
      expect(
        redactionSchema.safeParse({
          kind,
          rule,
          source,
          rect: { x: 0, y: 0, width: 1, height: 1 },
        }).success,
      ).toBe(true)
    }
  })
  it('can disable all builtins, is deterministic and retains no prior matches', () => {
    expect(
      createRedactionDetector({ enabled: [] })('alice@example.com'),
    ).toEqual([])
    expect(detect('alice@example.com')).toEqual(detect('alice@example.com'))
    expect(detect('No sensitive content.')).toEqual([])
    expect(typeof document).toBe('undefined')
  })
})

describe('custom rules and bounded failures', () => {
  it('finds every custom match with policy source and no raw matched text', () => {
    const detect = createRedactionDetector({
      enabled: [],
      customRules: [
        { id: 'employee', pattern: 'EMP-[0-9]{4}', flags: 'gi', kind: 'name' },
      ],
    })
    const spans = detect('😀 EMP-1234 emp-5678')
    expect(spans).toEqual([
      {
        start: 3,
        end: 11,
        kind: 'name',
        rule: 'custom-employee',
        source: 'policy',
      },
      {
        start: 12,
        end: 20,
        kind: 'name',
        rule: 'custom-employee',
        source: 'policy',
      },
    ])
    expect(JSON.stringify(spans)).not.toMatch(/1234|5678|EMP/)
  })
  it('supports multiline/dot-all flags and an explicitly automatic custom rule', () => {
    const detect = createRedactionDetector({
      enabled: [],
      customRules: [
        { id: 'record', pattern: '^A.+Z$', flags: 'msu', source: 'auto' },
      ],
    })
    expect(detect('A\nZ')).toEqual([
      {
        start: 0,
        end: 3,
        kind: 'custom',
        rule: 'custom-record',
        source: 'auto',
      },
    ])
  })
  it.each(['[', '(a)\\1', '(?<=a)b', '', 'a*', '^$'])(
    'rejects an invalid or zero-width rule without leaking its source',
    (pattern) => {
      expect(() =>
        createRedactionDetector({ customRules: [{ id: 'rule', pattern }] }),
      ).toThrow(RedactionDetectionError)
    },
  )
  it('does not leak a pattern in validation errors or their cause', () => {
    const secret = 'private-secret-in-invalid-pattern['
    try {
      createRedactionDetector({
        customRules: [{ id: 'rule', pattern: secret }],
      })
      throw new Error('Expected validation failure')
    } catch (error) {
      expect(error).toBeInstanceOf(RedactionDetectionError)
      expect(String(error) + JSON.stringify(error)).not.toContain(secret)
      expect(error).not.toHaveProperty('cause')
    }
  })
  it('fails a context-dependent zero-width match instead of silently skipping it', () => {
    const detect = createRedactionDetector({
      enabled: [],
      customRules: [{ id: 'boundary', pattern: '\\b' }],
    })
    expect(() => detect('word')).toThrow(RedactionDetectionError)
  })
  it('keeps nested quantifiers responsive without native backtracking', () => {
    const detect = createRedactionDetector({
      enabled: [],
      customRules: [{ id: 'nested', pattern: '(a+)+$' }],
    })
    expect(detect(`${'a'.repeat(100_000)}!`)).toEqual([])
  }, 2000)
  it('clones rule settings and rejects duplicate IDs, oversized patterns and unsupported flags', () => {
    const rule: CustomRedactionRule = { id: 'rule', pattern: 'EMP-[0-9]+' }
    const detect = createRedactionDetector({ enabled: [], customRules: [rule] })
    rule.pattern = 'changed'
    expect(detect('EMP-1234')).toHaveLength(1)
    for (const customRules of [
      [
        { id: 'rule', pattern: 'a' },
        { id: 'rule', pattern: 'b' },
      ],
      [{ id: 'unsafe id', pattern: 'a' }],
      [{ id: 'rule', pattern: 'a'.repeat(513) }],
      [{ id: 'rule', pattern: 'a', flags: 'y' }],
      [{ id: 'rule', pattern: 'a', flags: 'ii' }],
      Array.from({ length: 33 }, (_, index) => ({
        id: `rule-${index}`,
        pattern: 'a',
      })),
    ])
      expect(() => createRedactionDetector({ customRules })).toThrow(
        RedactionDetectionError,
      )
  })
  it('bounds individual and combined compiled program sizes', () => {
    expect(() =>
      createRedactionDetector({
        customRules: [{ id: 'wide', pattern: 'a{1000}|b{1000}|c{1000}' }],
      }),
    ).toThrow(RedactionDetectionError)
    expect(() =>
      createRedactionDetector({
        customRules: Array.from({ length: 12 }, (_, index) => ({
          id: `rule-${index}`,
          pattern: 'a{900}',
        })),
      }),
    ).toThrow(RedactionDetectionError)
  })
  it.each([
    { tokenEntropyThreshold: -1 },
    { tokenEntropyThreshold: NaN },
    { tokenEntropyThreshold: 9 },
    { defaultPhoneCountry: 'ZZ' },
    { enabled: ['unknown'] },
  ])('rejects invalid options', (options) => {
    expect(() =>
      createRedactionDetector(options as RedactionDetectorOptions),
    ).toThrow(RedactionDetectionError)
  })
  it('fails on input or match limits without returning partial detections', () => {
    const detect = createRedactionDetector({
      enabled: [],
      customRules: [{ id: 'letter', pattern: 'a' }],
    })
    expect(() => detect('a'.repeat(REDACTION_LIMITS.inputLength + 1))).toThrow(
      RedactionDetectionError,
    )
    expect(() => detect('a'.repeat(REDACTION_LIMITS.matches + 1))).toThrow(
      RedactionDetectionError,
    )
  })
})

describe('text redaction', () => {
  it('masks overlapping ranges once, without mutating the source spans', () => {
    const spans = Object.freeze([
      Object.freeze({ start: 3, end: 7 }),
      Object.freeze({ start: 1, end: 5 }),
    ])
    expect(redactSensitiveText('0123456789', spans)).toBe('0[REDACTED]789')
    expect(spans[0]).toEqual({ start: 3, end: 7 })
    expect(redactSensitiveText('safe', [])).toBe('safe')
  })
  it('retains overlapping custom and builtin detections while masking their union', () => {
    const text = 'Call alice@example.com now'
    const spans = createRedactionDetector({
      customRules: [{ id: 'domain', pattern: 'example\\.com' }],
    })(text)
    expect(spans.map((span) => span.rule)).toEqual(['email', 'custom-domain'])
    expect(redactSensitiveText(text, spans)).toBe('Call [REDACTED] now')
  })
  it.each([
    { start: -1, end: 2 },
    { start: 0, end: 0 },
    { start: 1, end: 0 },
    { start: 0.5, end: 2 },
    { start: 0, end: 100 },
    { start: NaN, end: 2 },
  ])('rejects invalid mask ranges', (span) =>
    expect(() => redactSensitiveText('safe', [span])).toThrow(
      RedactionDetectionError,
    ),
  )
})

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import minimal from './fixtures/minimal.json'
import complete from './fixtures/complete.json'
import {
  GUIDE_SCHEMA_ID,
  GUIDE_SCHEMA_URL,
  guideJsonSchema,
  guideSchema,
  type Guide,
  type GuideInput,
  type StepInput,
} from '../src'
import { validateJsonGuide } from './validation'

function expectBoth(input: unknown, valid: boolean) {
  expect(
    validateJsonGuide(input),
    JSON.stringify(validateJsonGuide.errors),
  ).toBe(valid)
  expect(guideSchema.safeParse(input).success).toBe(valid)
}

describe('guide@1 source-of-truth validation', () => {
  it('exports the wire identifier and the actual source JSON Schema', () => {
    expect(guideJsonSchema.$id).toBe(GUIDE_SCHEMA_URL)
    expect(guideJsonSchema.properties.schema.const).toBe(GUIDE_SCHEMA_ID)
  })

  it.each([
    ['minimal', minimal],
    ['complete', complete],
  ])('accepts the %s fixture in Ajv and Zod', (_, fixture) => {
    const original = structuredClone(fixture)
    expectBoth(fixture, true)
    const parsed: Guide = guideSchema.parse(fixture)
    expect(validateJsonGuide(JSON.parse(JSON.stringify(parsed)))).toBe(true)
    expect(fixture).toEqual(original)
  })

  it('supplies the documented defaults without making them required on input', () => {
    const input: GuideInput = {
      ...minimal,
      schema: GUIDE_SCHEMA_ID,
      steps: [{ ...minimal.steps[0]!, type: 'manual' }],
    }
    const parsed = guideSchema.parse(input)
    expect(parsed).toMatchObject({
      description: '',
      locale: 'en',
      tags: [],
      preconditions: [],
      variables: [],
      status: 'draft',
    })
    expect(parsed.steps[0]).toMatchObject({
      description: '',
      redactions: [],
      lowConfidence: false,
    })
    const full = guideSchema.parse(complete)
    expect(full.steps[0]?.target?.locators?.[1]?.exact).toBe(true)
    expect(full.steps[0]?.edits?.annotations?.[1]?.color).toBe('accent')
  })

  it.each([
    ['title', 200],
    ['description', 5000],
  ] as const)('counts code points for the %s length limit', (key, limit) => {
    expectBoth({ ...minimal, [key]: '😀'.repeat(limit) }, true)
    expectBoth({ ...minimal, [key]: '😀'.repeat(limit + 1) }, false)
  })

  it('uses JSON Schema integer semantics on every integer field', () => {
    expectBoth(
      {
        ...minimal,
        version: 1e16,
        verification: { failedStep: 1e16 },
        steps: [
          {
            ...minimal.steps[0],
            index: 1e16,
            screenshot: { rendered: 'image.webp', width: 1e16, height: 1e16 },
          },
        ],
      },
      true,
    )
  })

  it('accepts the 500-step upper bound', () => {
    expectBoth(
      {
        ...minimal,
        steps: Array.from({ length: 500 }, (_, index) => ({
          ...minimal.steps[0],
          id: `step-${index + 1}`,
          index: index + 1,
        })),
      },
      true,
    )
  })

  it.each([
    'schema',
    'id',
    'title',
    'steps',
    'version',
    'createdAt',
    'updatedAt',
  ])('requires guide.%s', (key) => {
    const input: Record<string, unknown> = { ...minimal }
    delete input[key]
    expectBoth(input, false)
  })

  it.each([
    ['schema', 'stepdoc/guide@2'],
    ['id', 'UPPERCASE'],
    ['id', 'ab'],
    ['id', 'a'.repeat(82)],
    ['title', ''],
    ['title', 't'.repeat(201)],
    ['description', 'd'.repeat(5001)],
    ['version', 0],
    ['version', 1.1],
    ['createdAt', '2026-02-30T00:00:00Z'],
    ['updatedAt', '2026-11-25'],
    ['uuid', 'not-a-uuid'],
    ['app', { origin: '/relative' }],
    ['app', { origin: 'https://example.com/with space' }],
    ['steps', []],
    ['steps', Array.from({ length: 501 }, () => minimal.steps[0])],
    ['status', 'deleted'],
    ['capturedAt', 'yesterday'],
    ['publish', { targets: ['unknown'] }],
  ])('rejects invalid %s', (key, value) =>
    expectBoth({ ...minimal, [key]: value }, false),
  )

  it.each([
    ['index', 0],
    ['index', 1.5],
    ['title', ''],
    ['type', 'unknown'],
    ['action', 'type'],
    ['confidence', -0.1],
    ['confidence', 1.1],
    ['target', { rect: { x: 0, y: 0, width: -1, height: 1 } }],
    ['target', { locators: [{ strategy: 'unknown', value: 'Save' }] }],
    ['target', { locators: [{ strategy: 'role' }] }],
    [
      'target',
      { locators: [{ strategy: 'role', value: 'button', unique: 'yes' }] },
    ],
    ['screenshot', { rendered: 'image.webp', width: 1.5, height: 2 }],
    ['screenshot', { width: 1, height: 2 }],
    [
      'redactions',
      [
        {
          kind: 'email',
          source: 'unknown',
          rect: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    ],
  ])('rejects invalid step.%s', (key, value) => {
    expectBoth(
      { ...minimal, steps: [{ ...minimal.steps[0], [key]: value }] },
      false,
    )
  })

  it.each(['id', 'index', 'type', 'title'])('requires step.%s', (key) => {
    const step: Record<string, unknown> = { ...minimal.steps[0] }
    delete step[key]
    expectBoth({ ...minimal, steps: [step] }, false)
  })

  it.each([
    { extra: 'unexpected' },
    { app: { origin: 'https://example.com', extra: 'unexpected' } },
    { variables: [{ name: 'email', kind: 'secret', extra: 'unexpected' }] },
    { steps: [{ ...minimal.steps[0], target: { value: 'typed' } }] },
    { steps: [{ ...minimal.steps[0], click: { x: 1, y: 1, value: 'typed' } }] },
    { steps: [{ ...minimal.steps[0], edits: { value: 'typed' } }] },
    {
      steps: [
        {
          ...minimal.steps[0],
          edits: { annotations: [{ type: 'pin', x: 1, y: 1, value: 'typed' }] },
        },
      ],
    },
    {
      steps: [{ ...minimal.steps[0], expect: { visible: { value: 'typed' } } }],
    },
    { verification: { value: 'typed' } },
    { publish: { token: 'unexpected' } },
  ])('rejects unknown properties instead of forwarding them', (patch) =>
    expectBoth({ ...minimal, ...patch }, false),
  )

  it.each([
    ['2026-11-25t10:00:00z', true],
    ['2026-11-25 10:00:00+06:00', true],
    ['2024-02-29T10:00:00Z', true],
    ['2026-02-29T10:00:00Z', false],
    ['2026-11-25T10:00:00', false],
    ['2016-12-31T23:59:60Z', true],
    ['2026-11-25T10:00:00+30:00', false],
  ])('agrees on RFC date-time %s', (createdAt, valid) =>
    expectBoth({ ...minimal, createdAt }, valid),
  )

  it.each([
    'urn:example:guide',
    'mailto:editor@example.com',
    'https://example.com/path?q=1#step',
  ])('accepts JSON Schema URI format %s', (origin) => {
    expectBoth({ ...minimal, app: { origin } }, true)
  })

  it.each([
    '00000000-0000-0000-0000-000000000000',
    'urn:uuid:123e4567-e89b-42d3-a456-426614174000',
  ])('agrees on UUID format %s', (uuid) => {
    expectBoth({ ...minimal, uuid }, true)
  })
})

describe('privacy invariants in both validators', () => {
  it.each([
    undefined,
    { kind: 'none' },
    { kind: 'literal', literal: 'typed text' },
    { kind: 'secret', variable: 'email', literal: 'typed text' },
    { kind: 'secret' },
    { kind: 'variable', variable: 'not a variable name' },
  ])('rejects an unsafe fill payload', (value) => {
    expectBoth(
      {
        ...minimal,
        steps: [{ ...minimal.steps[0], type: 'action', action: 'fill', value }],
      },
      false,
    )
  })

  it.each(['variable', 'secret'] as const)(
    'accepts a %s reference for fill',
    (kind) => {
      expectBoth(
        {
          ...minimal,
          variables: [{ name: 'field', kind }],
          steps: [
            {
              ...minimal.steps[0],
              action: 'fill',
              value: { kind, variable: 'field' },
            },
          ],
        },
        true,
      )
    },
  )

  it('rejects secret examples and permits nonsecret examples', () => {
    expectBoth(
      {
        ...minimal,
        variables: [
          { name: 'email', kind: 'secret', example: 'secret@example.com' },
        ],
      },
      false,
    )
    expectBoth(
      {
        ...minimal,
        variables: [{ name: 'seats', kind: 'variable', example: '5' }],
      },
      true,
    )
  })

  it.each(['click', 'upload', 'navigate', undefined])(
    'rejects literals for %s',
    (action) => {
      expectBoth(
        {
          ...minimal,
          steps: [
            {
              ...minimal.steps[0],
              action,
              value: { kind: 'literal', literal: 'typed text' },
            },
          ],
        },
        false,
      )
    },
  )

  it.each(['select', 'press'] as const)(
    'permits non-typed literals for %s',
    (action) => {
      const step: StepInput = {
        ...minimal.steps[0]!,
        type: 'action',
        action,
        value: { kind: 'literal', literal: 'Team' },
      }
      expectBoth({ ...minimal, steps: [step] }, true)
    },
  )

  it.each([
    { kind: 'none', literal: 'typed' },
    { kind: 'none', variable: 'field' },
    { kind: 'literal' },
  ])('rejects inconsistent tagged values', (value) => {
    expectBoth(
      { ...minimal, steps: [{ ...minimal.steps[0], action: 'select', value }] },
      false,
    )
  })

  it('never includes secret data in a validation error', () => {
    const secret = 'never-log-this-typed-input'
    const parsed = guideSchema.safeParse({
      ...minimal,
      steps: [
        {
          ...minimal.steps[0],
          action: 'fill',
          value: { kind: 'literal', literal: secret },
        },
      ],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error).toBeInstanceOf(z.ZodError)
      expect(JSON.stringify(parsed.error)).not.toContain(secret)
    }
  })
})

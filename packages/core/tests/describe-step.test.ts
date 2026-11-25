import { describe, expect, it } from 'vitest'
import {
  describeGuideStep,
  describeStep,
  resolveLabel,
  sanitizeLabel,
  type DescriptionMetadata,
  type GuideDescriptionInput,
} from '../src'

const base: DescriptionMetadata = {
  event: 'click',
  tag: 'button',
  url: 'https://example.com',
}

describe('step text rules', () => {
  it('honours label precedence and skips empty or emoji-only candidates', () => {
    expect(
      resolveLabel({
        ...base,
        label: '   ',
        ariaLabel: '🔥',
        innerText: ' Save  now ',
        placeholder: 'Later',
      }),
    ).toBe('Save now')
    expect(
      resolveLabel({
        ...base,
        label: 'First',
        ariaLabel: 'Second',
        innerText: 'Third',
      }),
    ).toBe('First')
    expect(resolveLabel({ ...base, role: 'button' })).toBe('button')
  })

  it('flags role-only and missing labels for review', () => {
    expect(describeStep({ ...base, role: 'button' })).toEqual({
      text: 'Click "button"',
      lowConfidence: true,
    })
    expect(describeStep(base)).toEqual({
      text: 'Click here',
      lowConfidence: true,
    })
  })

  it('truncates by Unicode code point without splitting surrogate pairs', () => {
    const result = sanitizeLabel('𝟘'.repeat(41))!
    expect([...result]).toHaveLength(40)
    expect(result).toBe(`${'𝟘'.repeat(39)}…`)
    expect(sanitizeLabel('  Hello\n\t world  ')).toBe('Hello world')
    expect(sanitizeLabel('🔥 🏆')).toBeUndefined()
  })

  it('does not read typed values or editable innerText while describing a fill', () => {
    const metadata: DescriptionMetadata = {
      ...base,
      event: 'input',
      tag: 'textarea',
      label: 'Notes',
    }
    for (const key of ['value', 'innerText'])
      Object.defineProperty(metadata, key, {
        get() {
          throw new Error('Typed value was read')
        },
      })
    expect(describeStep(metadata)).toEqual({
      text: 'Fill in the "Notes" field',
      lowConfidence: false,
    })
  })

  it('does not use text inside an input or textarea as a click label', () => {
    for (const tag of ['input', 'textarea']) {
      const metadata: DescriptionMetadata = {
        ...base,
        tag,
        placeholder: 'Notes',
      }
      Object.defineProperty(metadata, 'innerText', {
        get() {
          throw new Error('Typed value was read')
        },
      })
      expect(describeStep(metadata).text).toBe('Click "Notes"')
    }
  })

  it('retains v1 select, radio, checkbox and submit wording', () => {
    expect(
      describeStep({
        ...base,
        event: 'select',
        label: 'Country',
        optionLabel: 'Japan',
      }),
    ).toEqual({
      text: 'Select "Japan" from the "Country" dropdown',
      lowConfidence: false,
    })
    expect(
      describeStep({ ...base, label: 'Terms', inputType: 'checkbox' }).text,
    ).toBe('Check "Terms"')
    expect(
      describeStep({ ...base, label: 'Basic', inputType: 'radio' }).text,
    ).toBe('Select "Basic"')
    expect(describeStep({ ...base, event: 'submit' }).text).toBe(
      'Press Enter to submit',
    )
    expect(
      describeStep({ ...base, event: 'select', label: 'Country' })
        .lowConfidence,
    ).toBe(true)
  })

  it('omits URL credentials, query strings and fragments from navigation text', () => {
    expect(
      describeStep({
        ...base,
        event: 'navigation',
        url: 'https://user:private@example.com:8443/docs?token=private#private',
      }),
    ).toEqual({ text: 'Go to example.com:8443/docs', lowConfidence: false })
    expect(
      describeGuideStep({ action: 'navigate', url: 'https://example.com/' })
        .text,
    ).toBe('Go to example.com')
    expect(
      describeGuideStep({
        action: 'navigate',
        url: `https://example.com/${'a'.repeat(60)}`,
      }).text,
    ).toBe(`Go to example.com/${'a'.repeat(46)}…`)
  })

  it.each([
    'not-a-url?private',
    'javascript:private',
    'data:text/plain,private',
    undefined,
  ])('handles unsupported navigation without echoing %s', (url) => {
    expect(describeGuideStep({ action: 'navigate', url })).toEqual({
      text: 'Go to the page',
      lowConfidence: true,
    })
    expect(
      describeStep({ ...base, event: 'navigation', url: url ?? '' }),
    ).toEqual({ text: 'Go to the page', lowConfidence: true })
  })
})

describe('guide@1 step instructions', () => {
  it.each([
    ['click', 'Click "Save"'],
    ['dblclick', 'Double-click "Save"'],
    ['fill', 'Fill in the "Save" field'],
    ['check', 'Check "Save"'],
    ['uncheck', 'Uncheck "Save"'],
    ['hover', 'Hover over "Save"'],
    ['upload', 'Choose a file for "Save"'],
    ['assert', 'Verify "Save"'],
    ['wait', 'Wait for "Save"'],
  ] as const)('describes %s from its accessible name', (action, text) => {
    expect(
      describeGuideStep({ action, target: { role: 'button', name: 'Save' } }),
    ).toEqual({ text, lowConfidence: false })
  })

  it.each([
    'click',
    'dblclick',
    'fill',
    'check',
    'uncheck',
    'hover',
    'upload',
    'assert',
    'wait',
  ] as const)('flags missing target names for %s', (action) => {
    expect(
      describeGuideStep({ action, target: { role: 'button' } }).lowConfidence,
    ).toBe(true)
  })

  it.each(['fill', 'upload', 'click'] as const)(
    'never reads the value payload for %s',
    (action) => {
      const input: GuideDescriptionInput = {
        action,
        target: { name: 'Billing email' },
      }
      Object.defineProperty(input, 'value', {
        get() {
          throw new Error('Typed value was read')
        },
      })
      expect(describeGuideStep(input).text).toContain('Billing email')
    },
  )

  it('uses select option literals and keeps variable/secret references out of the text', () => {
    expect(
      describeGuideStep({
        action: 'select',
        target: { name: 'Plan' },
        value: { kind: 'literal', literal: 'Team' },
      }),
    ).toEqual({
      text: 'Select "Team" from the "Plan" dropdown',
      lowConfidence: false,
    })
    for (const kind of ['variable', 'secret'] as const) {
      expect(
        describeGuideStep({
          action: 'select',
          target: { name: 'Plan' },
          value: { kind, variable: 'private_reference' },
        }),
      ).toEqual({
        text: 'Select "an option" from the "Plan" dropdown',
        lowConfidence: false,
      })
    }
    expect(
      describeGuideStep({ action: 'select', target: { name: 'Plan' } })
        .lowConfidence,
    ).toBe(true)
  })

  it('uses key names, and does not guess a missing press key', () => {
    expect(
      describeGuideStep({ action: 'press', key: 'Control+Enter' }).text,
    ).toBe('Press Control+Enter')
    expect(describeGuideStep({ action: 'press', key: ' ' }).text).toBe(
      'Press Space',
    )
    expect(
      describeGuideStep({
        action: 'press',
        value: { kind: 'literal', literal: 'Escape' },
      }).text,
    ).toBe('Press Escape')
    expect(describeGuideStep({ action: 'press' })).toEqual({
      text: 'Press a key',
      lowConfidence: true,
    })
    const step: GuideDescriptionInput = { action: 'press', key: 'Enter' }
    Object.defineProperty(step, 'value', {
      get() {
        throw new Error('Unnecessary value access')
      },
    })
    expect(describeGuideStep(step).text).toBe('Press Enter')
  })

  it('uses radio wording and preserves authored section/manual titles', () => {
    expect(
      describeGuideStep({
        action: 'check',
        target: { role: 'radio', name: 'Team' },
      }).text,
    ).toBe('Select "Team"')
    const title =
      'A long hand-written instruction that must not be truncated to a capture label'
    expect(describeGuideStep({ type: 'manual', title })).toEqual({
      text: title,
      lowConfidence: false,
    })
    expect(describeGuideStep({ type: 'section', title: 'Billing' })).toEqual({
      text: 'Billing',
      lowConfidence: false,
    })
    expect(describeGuideStep({ type: 'section' })).toEqual({
      text: 'New section',
      lowConfidence: true,
    })
    expect(describeGuideStep({ title: 'Legacy action' })).toEqual({
      text: 'Legacy action',
      lowConfidence: true,
    })
  })
})

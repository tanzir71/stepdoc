import { describe, expect, it } from 'vitest'
import { makeStep, legacyInputType } from './legacy-capture'
describe('capture', () => {
  it('preserves secret classification in the retained v1 metadata projection', () => {
    const secret = { value: { kind: 'secret' as const, variable: 'field_1' } }
    expect(legacyInputType(secret, 'email')).toBe('email')
    expect(legacyInputType(secret, 'password')).toBe('password')
    expect(legacyInputType(secret, 'text')).toBe('password')
    expect(
      legacyInputType(
        { value: { kind: 'variable', variable: 'field_1' } },
        'text',
      ),
    ).toBe('text')
    expect(legacyInputType({ target: { role: 'checkbox' } })).toBe('checkbox')
    expect(legacyInputType({}, 'file')).toBe('file')
  })
  it('scales click', () =>
    expect(
      makeStep({
        event: 'click',
        tag: 'button',
        label: 'Save',
        url: 'https://x.test',
        click: { x: 4, y: 5 },
        devicePixelRatio: 2,
      }).click,
    ).toEqual({ x: 8, y: 10, radius: 24 }))
  it('does not retain typed values', () =>
    expect(
      JSON.stringify(
        makeStep({
          event: 'input',
          tag: 'input',
          label: 'Email',
          url: 'https://x.test',
        }),
      ),
    ).not.toContain('@'))
})

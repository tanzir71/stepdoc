import { describe, expect, it, vi } from 'vitest'
import { jsonBody } from '../src/json-body'

describe('bounded JSON body allocation', () => {
  it.each([
    null,
    true,
    false,
    -0,
    1.25,
    1e30,
    'ASCII / and space',
    'quote" slash\\\n\b\t\f\r\u0000\u001f',
    'é€中😀\ud800\udfff\u2028',
    {
      'é\n': [1, undefined, null, '😀'],
      absent: undefined,
      nested: { value: '"' },
    },
  ])('counts escaped UTF-8 exactly for %j', (value) => {
    const expected = JSON.stringify(value)
    const length = new TextEncoder().encode(expected).length
    expect(jsonBody(value, length)).toBe(expected)
    expect(() => jsonBody(value, length - 1)).toThrow('invalid_guide')
    expect(() => jsonBody(value, length - 1, 'upload_too_large')).toThrow(
      'upload_too_large',
    )
  })
  it('rejects a repeated large string before building its oversized JSON body', () => {
    const text = 'x'.repeat(1024 * 1024)
    expect(() => jsonBody(Array(100).fill(text), 1024)).toThrow('invalid_guide')
  })
  it('rejects non-JSON/cyclic values without invoking serialization hooks', () => {
    const toJSON = vi.fn(() => 'PRIVATE')
    expect(() => jsonBody({ toJSON }, 1000)).toThrow('invalid_guide')
    expect(toJSON).not.toHaveBeenCalled()
    const hiddenHook = Object.defineProperty({}, 'toJSON', { value: toJSON })
    const arrayHook = Object.assign([], { toJSON })
    for (const item of [new Date(), hiddenHook, arrayHook])
      expect(() => jsonBody(item, 1000)).toThrow('invalid_guide')
    expect(toJSON).not.toHaveBeenCalled()
    const circular: { next?: unknown } = {}
    circular.next = circular
    for (const value of [circular, undefined, Symbol(), Infinity, NaN, 1n])
      expect(() => jsonBody(value, 1000)).toThrow('invalid_guide')
  })
})

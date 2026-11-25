import { describe, expect, it, vi } from 'vitest'
import { locatorSchema } from '@stepdoc/schema'
import { isFragileLocator, rankLocators, type LocatorCandidate, type LocatorMatchCount } from '../src'

describe('locator ranking', () => {
  it('prefers role+name, test ID and accessible labels before CSS/XPath', () => {
    const strategies = [
      'role',
      'testId',
      'label',
      'placeholder',
      'text',
      'altText',
      'title',
      'css',
      'xpath',
    ] as const
    const candidates = strategies.map(
      (strategy): LocatorCandidate => ({
        strategy,
        value: 'Save',
        ...(strategy === 'role' && { name: 'Save' }),
        unique: true,
      }),
    )
    expect(
      rankLocators([...candidates].reverse()).map(
        (locator) => locator.strategy,
      ),
    ).toEqual(strategies)
  })

  it('prefers unique matches to unverified and ambiguous matches', () => {
    expect(
      rankLocators([
        { strategy: 'role', value: 'button', name: 'Save', unique: false },
        { strategy: 'label', value: 'Save' },
        { strategy: 'css', value: '#save', unique: true },
      ]).map((locator) => locator.strategy),
    ).toEqual(['css', 'label', 'role'])
  })

  it('prefers an exact match over a partial accessible name', () => {
    const locators = rankLocators([
      {
        strategy: 'role',
        value: 'button',
        name: 'Save',
        exact: false,
        unique: true,
      },
      { strategy: 'testId', value: 'save', unique: true },
    ])
    expect(locators[0]?.strategy).toBe('testId')
  })

  it('treats unnamed roles as less robust than CSS and more robust than XPath', () => {
    expect(
      rankLocators([
        { strategy: 'role', value: 'button', unique: true },
        { strategy: 'xpath', value: '//button', unique: true },
        { strategy: 'css', value: '#save', unique: true },
      ]).map((locator) => locator.strategy),
    ).toEqual(['css', 'role', 'xpath'])
  })

  it('keeps stable order within a ranking tier', () => {
    expect(
      rankLocators([
        { strategy: 'label', value: 'First' },
        { strategy: 'label', value: 'Second' },
      ]).map((locator) => locator.value),
    ).toEqual(['First', 'Second'])
  })

  it('deduplicates equivalent defaults without inventing uniqueness', () => {
    const candidates: LocatorCandidate[] = [
      { strategy: 'testId', value: 'save' },
      { strategy: 'testId', value: 'save', exact: true },
    ]
    const result = rankLocators(candidates)
    expect(result).toEqual([{ strategy: 'testId', value: 'save', exact: true }])
    expect(candidates[0]).not.toHaveProperty('exact')
    expect(result[0]).not.toHaveProperty('unique')
  })

  it('preserves different role names and exact-match modes', () => {
    expect(
      rankLocators([
        { strategy: 'role', value: 'button', name: 'Save' },
        { strategy: 'role', value: 'button', name: 'Cancel' },
        { strategy: 'role', value: 'button', name: 'Save', exact: false },
      ]),
    ).toHaveLength(3)
  })

  it('combines duplicate observations conservatively', () => {
    expect(
      rankLocators([
        { strategy: 'testId', value: 'save', unique: true },
        { strategy: 'testId', value: 'save', unique: false },
      ])[0]?.unique,
    ).toBe(false)
  })

  it('uses actual counts, removes zero matches and observes each deduplicated locator once', () => {
    const count = vi.fn<LocatorMatchCount>((locator) =>
      locator.value === 'missing' ? 0 : locator.value === 'save' ? 1 : 2,
    )
    const result = rankLocators(
      [
        { strategy: 'testId', value: 'missing', unique: true },
        { strategy: 'testId', value: 'save', unique: false },
        { strategy: 'testId', value: 'save' },
        { strategy: 'role', value: 'button', name: 'Save', unique: true },
      ],
      count,
    )
    expect(count).toHaveBeenCalledTimes(3)
    expect(result).toEqual([
      { strategy: 'testId', value: 'save', exact: true, unique: true },
      {
        strategy: 'role',
        value: 'button',
        name: 'Save',
        exact: true,
        unique: false,
      },
    ])
    expect(
      result.every((locator) => locatorSchema.safeParse(locator).success),
    ).toBe(true)
  })

  it('discards malformed selectors without dropping the working fallbacks', () => {
    expect(
      rankLocators(
        [
          { strategy: 'css', value: '[' },
          { strategy: 'css', value: '#save' },
        ],
        (locator) => {
          if (locator.value === '[') throw new SyntaxError('Invalid selector')
          return 1
        },
      ),
    ).toEqual([{ strategy: 'css', value: '#save', exact: true, unique: true }])
  })

  it.each([-1, 0.5, NaN, Infinity])(
    'rejects impossible match count %s',
    (count) => {
      expect(() =>
        rankLocators([{ strategy: 'css', value: '#save' }], () => count),
      ).toThrow(RangeError)
    },
  )

  it('does not swallow unrelated resolver failures', () => {
    const failure = new Error('Resolver failed')
    expect(() =>
      rankLocators([{ strategy: 'css', value: '#save' }], () => {
        throw failure
      }),
    ).toThrow(failure)
  })

  it('does not mutate its inputs and gives the counter a frozen copy', () => {
    const candidate = Object.freeze({
      strategy: 'css' as const,
      value: '#save',
    })
    const result = rankLocators(Object.freeze([candidate]), (locator) => {
      expect(Object.isFrozen(locator)).toBe(true)
      return 1
    })
    expect(result[0]).not.toBe(candidate)
    expect(candidate).toEqual({ strategy: 'css', value: '#save' })
  })

  it('omits blank candidate values', () => {
    expect(
      rankLocators([
        { strategy: 'text', value: '   ' },
        { strategy: 'css', value: '' },
      ]),
    ).toEqual([])
  })

  it('reports structural, partial and unverified locators as fragile', () => {
    expect(
      isFragileLocator({
        strategy: 'role',
        value: 'button',
        name: 'Save',
        unique: true,
      }),
    ).toBe(false)
    expect(
      isFragileLocator({ strategy: 'testId', value: 'save', unique: true }),
    ).toBe(false)
    expect(
      isFragileLocator({ strategy: 'css', value: '#save', unique: true }),
    ).toBe(true)
    expect(
      isFragileLocator({ strategy: 'xpath', value: '//button', unique: true }),
    ).toBe(true)
    expect(
      isFragileLocator({ strategy: 'role', value: 'button', unique: true }),
    ).toBe(true)
    expect(
      isFragileLocator({
        strategy: 'text',
        value: 'Save',
        exact: false,
        unique: true,
      }),
    ).toBe(true)
    expect(isFragileLocator({ strategy: 'label', value: 'Save' })).toBe(true)
    expect(
      isFragileLocator({ strategy: 'label', value: 'Save', unique: false }),
    ).toBe(true)
  })
})

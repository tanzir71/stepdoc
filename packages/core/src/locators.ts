import type { Locator } from '@stepdoc/schema'

export type LocatorCandidate = Omit<Locator, 'exact'> & { exact?: boolean }
export type LocatorMatchCount = (locator: Readonly<Locator>) => number

const priority: Readonly<Record<Locator['strategy'], number>> = {
  role: 0,
  testId: 1,
  label: 2,
  placeholder: 3,
  text: 4,
  altText: 5,
  title: 6,
  css: 7,
  xpath: 9,
}

function semanticPriority(locator: Locator): number {
  return locator.strategy === 'role' && !locator.name?.trim()
    ? 8
    : priority[locator.strategy]
}

function partialMatch(locator: Locator): boolean {
  return (
    !locator.exact &&
    locator.strategy !== 'css' &&
    locator.strategy !== 'xpath' &&
    locator.strategy !== 'testId'
  )
}

function uniquenessPriority(locator: Locator): number {
  return locator.unique === true ? 0 : locator.unique === false ? 2 : 1
}

export function isFragileLocator(locator: LocatorCandidate): boolean {
  return (
    locator.unique !== true ||
    locator.strategy === 'css' ||
    locator.strategy === 'xpath' ||
    (locator.strategy === 'role' && !locator.name?.trim()) ||
    partialMatch({ ...locator, exact: locator.exact ?? true })
  )
}

/**
 * Rank a copy of the captured locators. A local resolver can supply actual match
 * counts (scoped to the target's frame/shadow root). Zero matches are discarded;
 * exactly one match is unique. Without a resolver, captured flags are preserved.
 */
export function rankLocators(
  candidates: readonly LocatorCandidate[],
  countMatches?: LocatorMatchCount,
): Locator[] {
  const deduplicated = new Map<string, Locator>()
  for (const candidate of candidates) {
    if (!candidate.value.trim()) continue
    const locator: Locator = {
      strategy: candidate.strategy,
      value: candidate.value,
      exact: candidate.exact ?? true,
      ...(candidate.name !== undefined && { name: candidate.name }),
      ...(candidate.unique !== undefined && { unique: candidate.unique }),
    }
    const key = JSON.stringify([
      locator.strategy,
      locator.value,
      locator.name ?? null,
      locator.exact,
    ])
    const previous = deduplicated.get(key)
    if (previous) {
      // Conflicting observations must not turn an ambiguous target into a unique one.
      const unique =
        previous.unique === false || locator.unique === false
          ? false
          : previous.unique === true || locator.unique === true
            ? true
            : undefined
      if (unique !== undefined) previous.unique = unique
    } else deduplicated.set(key, locator)
  }
  const observed: Locator[] = []
  for (const locator of deduplicated.values()) {
    if (countMatches) {
      let count: number
      try {
        count = countMatches(Object.freeze({ ...locator }))
      } catch (error) {
        // One malformed selector must not prevent usable fallbacks from being ranked.
        if (
          typeof error === 'object' &&
          error !== null &&
          'name' in error &&
          error.name === 'SyntaxError'
        )
          continue
        throw error
      }
      if (!Number.isInteger(count) || count < 0)
        throw new RangeError(
          'Locator match counts must be nonnegative integers',
        )
      if (count === 0) continue
      locator.unique = count === 1
    }
    observed.push(locator)
  }
  return observed.sort(
    (a, b) =>
      uniquenessPriority(a) - uniquenessPriority(b) ||
      Number(partialMatch(a)) - Number(partialMatch(b)) ||
      semanticPriority(a) - semanticPriority(b),
  )
}

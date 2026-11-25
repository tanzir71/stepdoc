import type { GuideInput, Locator, Step, Target } from '@stepdoc/schema'
import { rankLocators } from '../locators'
import { envName, js, prepareExport, type ExportOptions } from './common'

function role(value: string): string {
  return `${js(value)} as Parameters<Page['getByRole']>[0]`
}

function locatorCode(locator: Locator, root: string): string {
  switch (locator.strategy) {
    case 'role':
      return `${root}.getByRole(${role(locator.value)}, { ${locator.name !== undefined ? `name: ${js(locator.name)}, ` : ''}exact: ${locator.exact} })`
    case 'testId':
      return `${root}.getByTestId(${js(locator.value)})`
    case 'css':
      return `${root}.locator(${js(locator.value)})`
    case 'xpath':
      return `${root}.locator(${js(`xpath=${locator.value}`)})`
    default: {
      const method = {
        label: 'getByLabel',
        placeholder: 'getByPlaceholder',
        text: 'getByText',
        altText: 'getByAltText',
        title: 'getByTitle',
      }[locator.strategy]
      return `${root}.${method}(${js(locator.value)}, { exact: ${locator.exact} })`
    }
  }
}

function rootCode(target?: Target): string {
  let root = 'page'
  for (const frame of target?.frame ?? []) root += `.frameLocator(${js(frame)})`
  for (const host of target?.shadowPath ?? []) root += `.locator(${js(host)})`
  return root
}

function targetCode(target: Target | undefined, root: string): string | null {
  if (!target) return null
  const inferred: Locator[] =
    target.role && target.name
      ? [
          {
            strategy: 'role',
            value: target.role,
            name: target.name,
            exact: true,
          },
        ]
      : []
  const candidates = rankLocators([...inferred, ...(target.locators ?? [])])
    // Export contract: semantic role/name first, then test ID, then other fallbacks.
    .sort((a, b) => priority(a) - priority(b))
  if (!candidates.length && target.name)
    candidates.push({ strategy: 'text', value: target.name, exact: true })
  return candidates.length
    ? `await resolveTarget([${candidates.map((candidate) => `() => ${locatorCode(candidate, root)}`).join(', ')}])`
    : null
}
function priority(locator: Locator): number {
  return locator.strategy === 'role' && locator.name
    ? 0
    : locator.strategy === 'testId'
      ? 1
      : 2
}

function valueCode(step: Step): string | null {
  if (step.value?.kind === 'literal') return js(step.value.literal)
  if (step.value?.kind === 'variable' || step.value?.kind === 'secret')
    return `readVariable(${js(envName(step.value.variable))})`
  return null
}

function notReplayable(step: Step, reason: string): string {
  return `throw new Error(${js(`Step ${step.index} is not replayable: ${reason}`)});`
}

function expectations(
  step: Step,
  root: string,
  target: string | null,
): string[] {
  const result: string[] = []
  const expected = step.expect
  if (expected?.urlMatches !== undefined)
    result.push(
      `await expect(page).toHaveURL((url) => matchesUrl(url, ${js(expected.urlMatches!)}));`,
    )
  for (const state of ['visible', 'hidden'] as const) {
    const expectedTarget = expected?.[state]
    if (!expectedTarget) continue
    const selected = expectedTarget.role
      ? `${root}.getByRole(${role(expectedTarget.role)}, { ${expectedTarget.name !== undefined ? `name: ${js(expectedTarget.name)}, ` : ''}exact: true })`
      : expectedTarget.name
        ? `${root}.getByText(${js(expectedTarget.name)}, { exact: true })`
        : target
    result.push(
      selected
        ? `await expect(${selected}).${state === 'visible' ? 'toBeVisible' : 'toBeHidden'}();`
        : notReplayable(step, 'expected target is missing'),
    )
  }
  if (expected?.text) {
    const text = expected.text
    if (text.contains === undefined)
      result.push(notReplayable(step, 'expected text is missing'))
    else
      result.push(
        text.role
          ? `await expect(${root}.getByRole(${role(text.role)}).filter({ hasText: ${js(text.contains)} })).toBeVisible();`
          : `await expect(${root}.getByText(${js(text.contains)}, { exact: false })).toBeVisible();`,
      )
  }
  return result
}

function stepCode(step: Step): string[] {
  const root = rootCode(step.target)
  const target = targetCode(step.target, root)
  const result: string[] = []
  const expected = expectations(step, root, target)
  if (step.type === 'section') return expected
  if (step.type === 'manual') return [notReplayable(step, 'manual instruction')]
  const action =
    step.action ??
    (step.type === 'navigate'
      ? 'navigate'
      : step.type === 'assert'
        ? 'assert'
        : undefined)
  if (action === 'navigate')
    result.push(
      step.url
        ? `await page.goto(${js(step.url)});`
        : notReplayable(step, 'navigation URL is missing'),
    )
  else if (action === 'assert') {
    if (!expected.length)
      result.push(notReplayable(step, 'assertion is missing'))
  } else if (action === 'wait' && expected.length) {
    /* Assertions provide the wait. */
  } else if (action === 'press' && !step.target) {
    const key =
      step.key ??
      (step.value?.kind === 'literal' ? step.value.literal : undefined)
    result.push(
      key
        ? `await page.keyboard.press(${js(key)});`
        : notReplayable(step, 'key is missing'),
    )
  } else if (!target)
    result.push(notReplayable(step, 'target locator is missing'))
  else {
    result.push(`const target = ${target};`)
    if (
      ['click', 'dblclick', 'check', 'uncheck', 'hover'].includes(action ?? '')
    )
      result.push(`await target.${action}();`)
    else if (action === 'wait')
      result.push("await target.waitFor({ state: 'visible' });")
    else if (action === 'fill' || action === 'select' || action === 'upload') {
      const value = valueCode(step)
      if (!value)
        result.push(notReplayable(step, 'runtime variable is missing'))
      else if (action === 'select')
        result.push(`await target.selectOption({ label: ${value} });`)
      else
        result.push(
          `await target.${action === 'fill' ? 'fill' : 'setInputFiles'}(${value});`,
        )
    } else if (action === 'press') {
      const key =
        step.key ??
        (step.value?.kind === 'literal' ? step.value.literal : undefined)
      result.push(
        key
          ? `await target.press(${js(key)});`
          : notReplayable(step, 'key is missing'),
      )
    } else result.push(notReplayable(step, 'action is missing'))
  }
  return [...result, ...expected]
}

/** A standalone test; no guide payload, secret values, examples or service credentials embedded. */
export function exportPlaywright(
  input: GuideInput,
  options?: ExportOptions,
): string {
  const { guide } = prepareExport(input, options)
  const first = guide.steps.find((step) => step.type !== 'section')
  const initialUrl = first?.url || guide.app?.origin
  const steps = guide.steps
    .map(
      (
        step,
      ) => `  await test.step(${js(`${step.index}. ${step.title}`)}, async () => {
    try {
${stepCode(step)
  .map((line) => `      ${line}`)
  .join('\n')}
    } catch {
      // Native call logs can contain runtime input. Never attach the original error.
      throw new Error(${js(`Step ${step.index} failed or is not replayable`)});
    }
  });`,
    )
    .join('\n')
  return `import { test, expect, type Locator, type Page } from '@playwright/test';

// Runtime variables: ${guide.variables.map((variable) => envName(variable.name)).join(', ') || 'none'}.
// Run with a local authenticated browser context when preconditions require one.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
// Close pages before fixture teardown so failure context snapshots cannot retain input.
test.afterEach(async ({ context }) => {
  await Promise.all(context.pages().map((page) => page.close()));
});

function readVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error('Required replay variable is missing');
  return value;
}

function matchesUrl(input: URL, expected: string): boolean {
  const url = new URL(input.href);
  url.username = url.password = url.search = url.hash = '';
  if (expected.startsWith('/')) return url.pathname.startsWith(expected);
  if (/^https?:\\/\\//i.test(expected)) return url.href === expected;
  return new RegExp(expected).test(url.href);
}

async function resolveTarget(candidates: Array<() => Locator>): Promise<Locator> {
  let target: Locator | undefined;
  await expect(async () => {
    for (const create of candidates) {
      try {
        const candidate = create();
        if (await candidate.count() === 1 && await candidate.isVisible()) {
          target = candidate;
          return;
        }
      } catch { /* Invalid/stale selectors must not suppress usable fallbacks. */ }
    }
    throw new Error('No unique visible target');
  }).toPass({ timeout: 5000 });
  if (!target) throw new Error('No unique visible target');
  return target;
}

test(${js(guide.title)}, async ({ page }) => {
${!first ? `  throw new Error('Guide is not replayable: no actionable steps');` : ''}
${initialUrl && first && first.type !== 'manual' && first.type !== 'navigate' && first.action !== 'navigate' ? `  try { await page.goto(${js(initialUrl)}); } catch { throw new Error('Replay initialization failed'); }` : ''}
${steps}
});
`
}

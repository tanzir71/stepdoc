import type { Step } from '@stepdoc/schema'
import type { CaptureCleanupSuggestion } from '@stepdoc/schema/capture'
import { describeGuideStep, sanitizeLabel } from './describe-step'

const vagueTitle =
  /^(?:click here|click (?:on )?(?:the )?(?:element|button|link)|interact with (?:the )?element|describe this step)[.!]?$/i
const hasExpectation = (step: Step) => {
  const expected = step.expect
  return !!(
    expected?.urlMatches?.trim() ||
    expected?.visible?.name ||
    expected?.visible?.role ||
    expected?.hidden?.name ||
    expected?.hidden?.role ||
    expected?.text?.contains
  )
}
function sameClick(left: Step, right: Step) {
  if (
    left.type !== 'action' ||
    right.type !== 'action' ||
    left.action !== 'click' ||
    right.action !== 'click' ||
    !left.url ||
    left.url !== right.url ||
    hasExpectation(left) ||
    hasExpectation(right) ||
    !left.target ||
    !right.target ||
    !sanitizeLabel(left.target.name) ||
    left.target.name !== right.target?.name ||
    left.target.role !== right.target.role ||
    ['checkbox', 'radio', 'switch'].includes(left.target.role ?? '')
  )
    return false
  const identity = (step: Step) => {
    const target = step.target!
    return {
      frame: target.frame ?? [],
      shadowPath: target.shadowPath ?? [],
      locators: (target.locators ?? [])
        .filter((locator) => locator.unique === true)
        .map(({ strategy, value, name, exact }) => ({
          strategy,
          value,
          name,
          exact,
        })),
    }
  }
  const first = identity(left),
    second = identity(right)
  return (
    first.locators.length > 0 &&
    JSON.stringify(first) === JSON.stringify(second)
  )
}
function checkTitle(step: Step) {
  const expected = step.expect!
  const visible = sanitizeLabel(expected.visible?.name)
  const hidden = sanitizeLabel(expected.hidden?.name)
  if (visible) return `Verify "${visible}" is visible`
  if (hidden) return `Verify "${hidden}" is hidden`
  if (expected.urlMatches) return 'Verify the destination page'
  if (expected.text?.contains) return 'Verify the expected text'
  return 'Verify the expected result'
}

/** Offline, opt-in proposals from recorded metadata. Never inspect values or pixels. */
export function suggestCaptureCleanup(
  steps: readonly Step[],
): CaptureCleanupSuggestion[] {
  const suggestions: CaptureCleanupSuggestion[] = []
  let checkSlots = Math.max(0, 500 - steps.length)
  for (let at = 0; at < steps.length; at++) {
    const step = steps[at]!
    if (!step.id || step.id.length > 200) continue
    const next = steps[at + 1]
    if (next && next.id && next.id.length <= 200 && sameClick(step, next)) {
      const label = sanitizeLabel(step.target?.name)!
      suggestions.push({
        id: `merge-${at + 1}`,
        kind: 'merge',
        stepIds: [step.id, next.id],
        title: `Merge repeated clicks on "${label}"`,
        summary: `Steps ${at + 1}–${at + 2}: combine both instructions into one manual step, retaining the first screenshot.`,
      })
      at++
      continue
    }
    if (
      step.type === 'manual' ||
      step.type === 'section' ||
      step.type === 'assert'
    )
      continue
    if (vagueTitle.test(step.title.trim())) {
      const description = describeGuideStep(step)
      if (!description.lowConfidence && description.text !== step.title) {
        suggestions.push({
          id: `rename-${at + 1}`,
          kind: 'rename',
          stepIds: [step.id],
          title: description.text,
          summary: `Step ${at + 1}: rename "${step.title.slice(0, 100)}" to "${description.text}". The recorded action stays the same.`,
        })
      }
    }
    if (
      checkSlots > 0 &&
      hasExpectation(step) &&
      !(
        next?.type === 'assert' &&
        JSON.stringify(next.expect) === JSON.stringify(step.expect)
      )
    ) {
      const title = checkTitle(step)
      suggestions.push({
        id: `check-${at + 1}`,
        kind: 'check',
        stepIds: [step.id],
        title,
        summary: `After step ${at + 1}: add "${title}" using its recorded expected result. Keep the original action and reuse its masked screenshot.`,
      })
      checkSlots--
    }
  }
  return suggestions.slice(0, 500)
}

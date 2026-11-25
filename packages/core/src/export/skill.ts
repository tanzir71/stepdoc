import type { GuideInput } from '@stepdoc/schema'
import {
  escapeMarkdown as md,
  expectationText,
  prepareExport,
  targetText,
  valueText,
  js,
  type ExportOptions,
} from './common'
import { metadata, variablesMarkdown } from './markdown'

export function exportSkill(
  input: GuideInput,
  options?: ExportOptions,
): string {
  const { guide } = prepareExport(input, options)
  const lines = [
    '---',
    `name: ${guide.id}`,
    `description: ${js(guide.description || guide.title)}`,
    '---',
    '',
    `# ${md(guide.title)}`,
    '',
    '## Purpose',
    '',
    md(guide.description || guide.title),
    '',
    md(metadata(guide)),
    '',
    '## Preconditions',
    '',
    ...(guide.preconditions.length
      ? guide.preconditions.map((item) => `- ${md(item)}`)
      : ['- None specified.']),
    '',
    '## Variables',
    '',
    ...variablesMarkdown(guide),
    '',
    '## Steps',
    '',
  ]
  for (const step of guide.steps) {
    lines.push(`${step.index}. ${md(step.title).replace(/\n/g, ' ')}`)
    if (step.description)
      lines.push(`   ${md(step.description).replace(/\n/g, '\n   ')}`)
    lines.push(
      `   - Action: ${step.action ?? step.type}`,
      `   - Target: ${md(targetText(step)).replace(/\n/g, ' ')}`,
    )
    if (step.url) lines.push(`   - Page: <${step.url}>`)
    if (valueText(step))
      lines.push(`   - Value: ${md(valueText(step)!).replace(/\n/g, ' ')}`)
    lines.push(
      ...(expectationText(step).length
        ? expectationText(step).map((text) => `   - Expected: ${md(text)}`)
        : ['   - Expected: No captured assertion.']),
    )
    if (step.notes)
      lines.push(`   - Note: ${md(step.notes).replace(/\n/g, '\n     ')}`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

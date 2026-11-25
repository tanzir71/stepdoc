import type { Guide, GuideInput } from '@stepdoc/schema'
import {
  envName,
  escapeMarkdown as md,
  expectationText,
  imageAlt,
  prepareExport,
  targetText,
  valueText,
  type ExportOptions,
} from './common'

export function metadata(guide: Guide): string {
  return `App: ${guide.app?.name ?? 'Not specified'} · Captured: ${guide.capturedAt ?? guide.createdAt} · Verified: ${guide.verification?.status ?? 'never-run'}${guide.verification?.at ? ` (${guide.verification.at})` : ''} · Schema: ${guide.schema} · Version: ${guide.version}`
}

export function variablesMarkdown(guide: Guide): string[] {
  if (!guide.variables.length) return ['No variables required.']
  const cell = (value: string) => md(value).replace(/\n/g, ' ')
  return [
    '| Name | Kind | Type | Environment | Description |',
    '| --- | --- | --- | --- | --- |',
    ...guide.variables.map(
      (variable) =>
        `| ${cell(variable.name)} | ${variable.kind} | ${variable.type} | ${envName(variable.name)} | ${cell([variable.description, variable.options?.length && `Options: ${variable.options.join(', ')}`].filter(Boolean).join(' '))} |`,
    ),
    '',
    'Supply values at replay time. Stored examples are never used as replay defaults.',
  ]
}

export function exportMarkdown(
  input: GuideInput,
  options?: ExportOptions,
): string {
  const { guide } = prepareExport(input, options)
  const lines = [
    `# ${md(guide.title)}`,
    '',
    md(guide.description),
    '',
    md(metadata(guide)),
    '',
    '## Preconditions',
    '',
    ...(guide.preconditions.length
      ? guide.preconditions.map((item) => `- ${md(item)}`)
      : ['None specified.']),
    '',
    '## Variables',
    '',
    ...variablesMarkdown(guide),
    '',
    '## Steps',
    '',
  ]
  for (const step of guide.steps) {
    lines.push(`### ${step.index}. ${md(step.title)}`, '')
    if (step.description) lines.push(md(step.description), '')
    if (step.url) lines.push(`Page: <${step.url}>`, '')
    if (step.target) lines.push(`Target: ${md(targetText(step))}`, '')
    if (step.action) lines.push(`Action: ${step.action}`, '')
    if (valueText(step)) lines.push(`Value: ${md(valueText(step)!)}`, '')
    for (const expectation of expectationText(step))
      lines.push(`Expected: ${md(expectation)}`, '')
    if (step.screenshot)
      lines.push(`![${md(imageAlt(step))}](<${step.screenshot.rendered}>)`, '')
    if (step.notes) lines.push(`Note: ${md(step.notes)}`, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

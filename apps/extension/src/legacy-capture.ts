import { describeStep } from '@stepdoc/core/describe-step'
import type { ElementMeta } from '@stepdoc/schema/legacy-v1'
import type { Step } from '@stepdoc/schema'

export function legacyInputType(
  step: Pick<Step, 'value' | 'target'>,
  originalType?: string,
): string | undefined {
  if (step.value?.kind === 'secret')
    return originalType === 'email' || originalType === 'password'
      ? originalType
      : 'password'
  if (step.target?.role === 'checkbox' || step.target?.role === 'radio')
    return step.target.role
  return originalType
}

export function makeStep(meta: ElementMeta) {
  const description = describeStep(meta)
  return {
    type: meta.event === 'navigation' ? 'navigate' : 'action',
    text: description.text,
    elementMeta: { ...meta, lowConfidence: description.lowConfidence },
    lowConfidence: description.lowConfidence,
    click: meta.click
      ? {
          x: meta.click.x * (meta.devicePixelRatio ?? 1),
          y: meta.click.y * (meta.devicePixelRatio ?? 1),
          radius: 24,
        }
      : null,
    edits: { blur: [], crop: null, annotations: [] },
  }
}

import type { Step } from '@stepdoc/schema'
import type { LocalCapture } from '@stepdoc/schema/capture'
import type { ElementMeta } from '@stepdoc/schema/legacy-v1'
import type { FrameScene } from './frame-broker'
import { transformPoint } from '@stepdoc/core/capture/geometry'
import { legacyInputType } from './legacy-capture'

export function contextualStep(event: LocalCapture, scene: FrameScene): Step {
  const context = scene.contexts.get(event.documentId)
  if (!context) throw new Error('Frame context unavailable')
  const step: Step = {
    ...event.step,
    url: event.step.url ?? context.url,
    ...(event.step.target && {
      target: { ...event.step.target, frame: context.frame },
    }),
    ...(!context.precise && { lowConfidence: true }),
    click: null,
  }
  if (
    context.precise &&
    event.step.click?.x !== undefined &&
    event.step.click.y !== undefined
  ) {
    const point = transformPoint(context.transform, {
      x: event.step.click.x / event.devicePixelRatio,
      y: event.step.click.y / event.devicePixelRatio,
    })
    const clip = context.clip
    if (
      point.x >= clip.x &&
      point.x <= clip.x + clip.width &&
      point.y >= clip.y &&
      point.y <= clip.y + clip.height
    )
      step.click = {
        x: point.x * context.devicePixelRatio,
        y: point.y * context.devicePixelRatio,
        radius: 18 * context.devicePixelRatio,
      }
    else step.lowConfidence = true
  }
  return step
}
export function legacyMeta(
  step: Step,
  event: LocalCapture,
  scene: FrameScene,
): ElementMeta {
  const dpr = scene.top.devicePixelRatio
  return {
    event:
      step.action === 'navigate'
        ? 'navigation'
        : step.action === 'fill' || step.action === 'upload'
          ? 'input'
          : step.action === 'select'
            ? 'select'
            : step.action === 'press'
              ? 'submit'
              : 'click',
    tag: step.target?.tag ?? 'body',
    role: step.target?.role,
    label: step.target?.name,
    selector: step.target?.locators?.find(
      (locator) => locator.strategy === 'css',
    )?.value,
    rect: step.target?.rect,
    url: step.url ?? scene.top.url!,
    click:
      step.click?.x !== undefined && step.click.y !== undefined
        ? { x: step.click.x / dpr, y: step.click.y / dpr }
        : undefined,
    devicePixelRatio: dpr,
    viewport: scene.top.viewport,
    optionLabel:
      step.value?.kind === 'literal' && step.action === 'select'
        ? step.value.literal
        : undefined,
    inputType: legacyInputType(step, event.inputType),
  }
}

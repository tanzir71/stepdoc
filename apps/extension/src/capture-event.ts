import {
  captureStep,
  navigationStep,
  documentUrl,
  viewportPoint,
} from '@stepdoc/core/capture'
import type { Step } from '@stepdoc/schema'
import type { ElementMeta } from '@stepdoc/schema/legacy-v1'
import { legacyInputType } from './legacy-capture'

export interface CapturedEvent {
  documentId: string
  step: Step
  meta: ElementMeta
  topUrl: string
  devicePixelRatio: number
  viewport: { width: number; height: number }
}
let documentId: string | undefined
export function captureDocumentId(): string {
  return (documentId ??= crypto.randomUUID())
}
export function eventFromStep(step: Step): CapturedEvent {
  return {
    documentId: captureDocumentId(),
    step,
    topUrl: documentUrl(window.top!.document),
    devicePixelRatio: window.devicePixelRatio,
    viewport: {
      width: window.top!.innerWidth,
      height: window.top!.innerHeight,
    },
    meta: {
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
      url: step.url ?? documentUrl(document),
      click:
        step.click?.x !== undefined && step.click.y !== undefined
          ? {
              x: step.click.x / window.devicePixelRatio,
              y: step.click.y / window.devicePixelRatio,
            }
          : undefined,
      devicePixelRatio: window.devicePixelRatio,
      viewport: {
        width: window.top!.innerWidth,
        height: window.top!.innerHeight,
      },
      optionLabel:
        step.value?.kind === 'literal' && step.action === 'select'
          ? step.value.literal
          : undefined,
      inputType: legacyInputType(step),
    },
  }
}
export function captureEvent(
  element: Element,
  action: NonNullable<Step['action']>,
  click?: { x: number; y: number },
  key?: string,
): CapturedEvent {
  const event = eventFromStep(
    captureStep(element, action, {
      id: crypto.randomUUID(),
      index: 1,
      ...(click && { click: viewportPoint(window, click) }),
      ...(key && { key }),
    }),
  )
  event.meta.inputType = legacyInputType(
    event.step,
    element.localName === 'input'
      ? (element.getAttribute('type') ?? 'text')
      : undefined,
  )
  return event
}
export function captureNavigation(): CapturedEvent {
  return eventFromStep(
    navigationStep(documentUrl(document), crypto.randomUUID(), 1),
  )
}

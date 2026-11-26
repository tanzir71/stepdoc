import {
  captureStep,
  navigationStep,
  documentUrl,
  localDocumentUrl,
  captureId,
} from '@stepdoc/core/capture'
import type { Step } from '@stepdoc/schema'
import type { LocalCapture } from '@stepdoc/schema/capture'
import { localCaptureSchema, CAPTURE_TRANSPORT } from '@stepdoc/schema/capture'

export type CapturedEvent = LocalCapture
let documentId: string | undefined
export function captureDocumentId(): string {
  return (documentId ??= captureId())
}
export function eventFromStep(step: Step): CapturedEvent {
  // A child never reads top.document or parent geometry. The authenticated
  // browser-frame broker supplies that context in the background.
  return {
    schema: CAPTURE_TRANSPORT,
    documentId: captureDocumentId(),
    step,
    topUrl: window === window.top ? localDocumentUrl(document) : null,
    devicePixelRatio: window.devicePixelRatio,
    viewport: { width: innerWidth, height: innerHeight },
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
      id: captureId(),
      index: 1,
      frame: [],
      url: localDocumentUrl(document),
      ...(click && { click }),
      ...(key && { key }),
    }),
  )
  if (element.localName === 'input')
    event.inputType = localCaptureSchema.shape.inputType.parse(
      (element as HTMLInputElement).type,
    )
  return event
}
export function captureNavigation(): CapturedEvent {
  return eventFromStep(navigationStep(documentUrl(document), captureId(), 1))
}

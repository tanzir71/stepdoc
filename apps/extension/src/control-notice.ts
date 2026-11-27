import { browser } from 'wxt/browser'
import {
  captureNoticeSchema,
  type CaptureNotice,
} from '@stepdoc/schema/capture'

interface Sender {
  id?: string
  tab?: unknown
  url?: string
}
export function receiveCaptureNotice(message: unknown, sender: Sender) {
  if (
    sender.id !== browser.runtime.id ||
    sender.tab ||
    !sender.url?.startsWith(browser.runtime.getURL('/'))
  )
    return undefined
  const parsed = captureNoticeSchema.safeParse(message)
  return parsed.success ? parsed.data : undefined
}

/** Never publish storage change bodies or retain a receiver's response. */
export function notifyCaptureControls(
  result?: CaptureNotice['guideResult'],
) {
  const parsed = captureNoticeSchema.safeParse({
    type: 'CAPTURE_CHANGED',
    ...(result && {
      guideResult: { guideId: result.guideId, saved: result.saved },
    }),
  })
  if (!parsed.success) return
  // A closed panel needs no notification; its next mount reads current state.
  void browser.runtime.sendMessage(parsed.data).catch(() => {})
}

import {
  captureTargetSchema,
  type CaptureTarget,
} from '@stepdoc/schema/capture-target'

export type TargetChoice = {
  target: CaptureTarget | null
  explicit: boolean
  invalid: boolean
}
export function readTargetChoice(raw: string): TargetChoice {
  const url = new URL(raw),
    source = url.searchParams.get('source'),
    origin = url.searchParams.get('origin'),
    browserSession = url.searchParams.get('browser-session')
  if (source === null && origin === null && browserSession === null)
    return { target: null, explicit: false, invalid: false }
  if (source === 'none' && origin === null && browserSession === null)
    return { target: null, explicit: true, invalid: false }
  const parsed = captureTargetSchema.safeParse({
    tabId:
      source && /^\d+$/.test(source) && String(Number(source)) === source
        ? Number(source)
        : NaN,
    origin,
    browserSession,
  })
  return {
    target: parsed.success ? parsed.data : null,
    explicit: true,
    invalid: !parsed.success,
  }
}
export function writeTargetChoice(url: URL, choice: TargetChoice) {
  url.searchParams.delete('source')
  url.searchParams.delete('origin')
  url.searchParams.delete('browser-session')
  if (choice.target) {
    url.searchParams.set('source', String(choice.target.tabId))
    url.searchParams.set('origin', choice.target.origin)
    url.searchParams.set('browser-session', choice.target.browserSession)
  } else if (choice.explicit)
    url.searchParams.set('source', choice.invalid ? 'invalid' : 'none')
  return url
}
export const targetKey = (target: CaptureTarget | null) =>
  target
    ? JSON.stringify({
        tabId: target.tabId,
        origin: target.origin,
        browserSession: target.browserSession,
      })
    : ''

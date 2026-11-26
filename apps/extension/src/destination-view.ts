import type {
  CaptureDestinationErrorCode,
  ServerDestination,
} from '@stepdoc/schema/capture-destination'

export const destinationMessages: Record<CaptureDestinationErrorCode, string> =
  {
    no_connection: 'Pair a server before choosing it as a destination.',
    connection_changed:
      'The server connection changed. Choose the destination again or keep this capture local.',
    revoked:
      'This device no longer has server access. Keep the capture local, then pair again with a new code.',
    unavailable:
      'The server could not be reached. Your review is retained; retry or keep it local.',
    too_large:
      'This capture exceeds the server upload limit. Keep it local and export a portable bundle.',
    invalid_capture:
      'The capture could not be prepared safely. Your review is retained.',
    redaction_open:
      'Unresolved redactions prevent upload. Keep the capture local to review them in the editor.',
    editor_unavailable:
      'The guide is saved. Retry opening the editor or keep a local copy.',
    storage_unavailable:
      'Capture storage is unavailable. Your review is retained; retry saving.',
    busy: 'Finish the current operation before changing the destination.',
    stale:
      'The capture changed in another window. Review the current state and retry.',
    forbidden: 'This action is available only in the extension controls.',
    cancelled: 'Saving stopped. The current capture state is shown.',
  }
export function serverLabel(choice: Pick<ServerDestination, 'server'>): string {
  try {
    const url = new URL(choice.server)
    return url.host + url.pathname.replace(/api\/v1\/$/, '').replace(/\/$/, '')
  } catch {
    return 'Paired server'
  }
}
export function serverRoot(choice: ServerDestination): URL {
  const url = new URL(choice.server)
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.pathname.endsWith('/api/v1/')
  )
    throw new Error('Invalid destination')
  return new URL('../../', url)
}

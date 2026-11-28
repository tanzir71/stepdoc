import {
  IndexedDbAdapter,
  type GuideQuery,
  type GuideSummary,
  type StorageAdapter,
} from '@stepdoc/storage'
import { HttpAdapter } from '@stepdoc/storage/http'
import { hostedConfig } from './hosted-config'
let pending: Promise<StorageAdapter> | undefined
let sessionEpoch = 0
/** Ignore authorization failures from requests issued before a cookie rotation. */
export function renewStorageSession() {
  sessionEpoch++
}
export const sessionFetch: typeof fetch = async (...args) => {
  const epoch = sessionEpoch
  const response = await fetch(...args)
  if (response.status === 401 && epoch === sessionEpoch)
    window.dispatchEvent(new Event('stepdoc:unauthorized'))
  return response
}
export function getStorage() {
  if (!pending) {
    const config = hostedConfig()
    pending = (
      config
        ? HttpAdapter.open(config.api, {
            auth: { kind: 'session' },
            fetch: sessionFetch,
          })
        : IndexedDbAdapter.open()
    ).catch((error) => {
      pending = undefined
      throw error
    })
  }
  return pending
}
export function resetStorage() {
  const previous = pending
  pending = undefined
  void previous?.then((adapter) => adapter.close()).catch(() => {})
}
export function changed() {
  window.dispatchEvent(new Event('stepdoc:data'))
}
export async function allGuides(
  query: GuideQuery = {},
): Promise<GuideSummary[]> {
  const adapter = await getStorage()
  const result: GuideSummary[] = []
  let cursor: string | undefined
  do {
    const page = await adapter.listGuides({ ...query, cursor })
    result.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return result
}

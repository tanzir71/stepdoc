import {
  IndexedDbAdapter,
  type GuideQuery,
  type GuideSummary,
} from '@stepdoc/storage'
let pending: Promise<IndexedDbAdapter> | undefined
export function getStorage() {
  if (!pending)
    pending = IndexedDbAdapter.open().catch((error) => {
      pending = undefined
      throw error
    })
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

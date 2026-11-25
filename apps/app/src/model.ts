import { guideSchema, type GuideInput } from '@stepdoc/schema'
import type { GuideFilter, GuideQuery } from '@stepdoc/storage'
export type LibraryStatus = 'all' | GuideFilter
export interface LibraryRoute {
  query: GuideQuery
  status: LibraryStatus
  view: 'grid' | 'list'
  sort: 'edited' | 'title'
  collections: boolean
  showAll: boolean
}
export function parseLibrary(search: string): LibraryRoute {
  const params = new URLSearchParams(search)
  const raw = params.get('status')
  const status: LibraryStatus =
    raw &&
    [
      'draft',
      'published',
      'archived',
      'needs-review',
      'replay-passed',
    ].includes(raw)
      ? (raw as GuideFilter)
      : 'all'
  return {
    query: {
      ...(params.get('q') && { q: params.get('q')!.slice(0, 1000) }),
      ...(status !== 'all' && { status }),
      ...(params.has('collection') && { collection: params.get('collection') }),
    },
    status,
    view: params.get('view') === 'list' ? 'list' : 'grid',
    sort: params.get('sort') === 'title' ? 'title' : 'edited',
    collections: params.get('collections') === '1',
    showAll: params.get('limit') === 'all',
  }
}
export function libraryUrl(
  search: string,
  changes: Readonly<Record<string, string | null>>,
): string {
  const params = new URLSearchParams(search)
  for (const [key, value] of Object.entries(changes)) {
    if (
      !value ||
      (key === 'status' && value === 'all') ||
      (key === 'view' && value === 'grid') ||
      (key === 'sort' && value === 'edited')
    )
      params.delete(key)
    else params.set(key, value)
  }
  params.sort()
  return `/${params.size ? `?${params}` : ''}`
}
export function humanize(value: string) {
  return value
    .replace(/[-_]/g, ' ')
    .replace(/^./u, (character) => character.toUpperCase())
}
export function newId(title: string): string {
  return `${
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'guide'
  }-${crypto.randomUUID().slice(0, 8)}`
}
export function manualGuide(title: string, instruction: string): GuideInput {
  const at = new Date().toISOString()
  return {
    schema: 'stepdoc/guide@1',
    id: newId(title),
    uuid: crypto.randomUUID(),
    title: title.trim(),
    steps: [
      {
        id: `step-${crypto.randomUUID()}`,
        index: 1,
        type: 'manual',
        title: instruction.trim(),
      },
    ],
    version: 1,
    createdAt: at,
    updatedAt: at,
  }
}
export function importGuide(text: string): GuideInput | null {
  try {
    return guideSchema.parse(JSON.parse(text))
  } catch {
    return null
  }
}
export function originLabel(value?: string) {
  if (!value) return 'Manual guide'
  try {
    return new URL(value).hostname || 'Local guide'
  } catch {
    return 'Local guide'
  }
}
export function editedLabel(value: string) {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(value)) / 60000),
  )
  if (minutes < 1) return 'edited just now'
  if (minutes < 60) return `edited ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `edited ${hours}h ago`
  const days = Math.floor(hours / 24)
  return days === 1
    ? 'edited yesterday'
    : days < 7
      ? `edited ${days}d ago`
      : `edited ${Math.floor(days / 7)}w ago`
}

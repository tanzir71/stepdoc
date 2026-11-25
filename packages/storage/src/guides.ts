import { guideSchema, type Guide, type GuideInput } from '@stepdoc/schema'
import {
  StorageError,
  type GuideQuery,
  type GuidePage,
  type GuideSummary,
} from './adapter'

export function validateGuide(input: GuideInput, stored = false): Guide {
  try {
    const guide = guideSchema.parse(input)
    if (!Number.isSafeInteger(guide.version)) throw new Error()
    const stepIds = new Set(guide.steps.map((step) => step.id))
    const indices = new Set(guide.steps.map((step) => step.index))
    const variables = new Map(
      guide.variables.map((variable) => [variable.name, variable.kind]),
    )
    if (
      stepIds.size !== guide.steps.length ||
      indices.size !== guide.steps.length ||
      variables.size !== guide.variables.length
    )
      throw new Error()
    for (const step of guide.steps)
      if (
        (step.value?.kind === 'variable' || step.value?.kind === 'secret') &&
        variables.get(step.value.variable) !== step.value.kind
      )
        throw new Error()
    return guide
  } catch {
    throw new StorageError(stored ? 'corrupt_data' : 'invalid_guide')
  }
}

export function validateId(id: string): void {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,80}$/.test(id))
    throw new StorageError('invalid_guide')
}
export function validateVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new StorageError('invalid_guide')
}

export function summary(guide: Guide): GuideSummary {
  return {
    id: guide.id,
    title: guide.title,
    stepCount: guide.steps.length,
    status: guide.status,
    openRedactions: guide.steps.reduce(
      (count, step) =>
        count + step.redactions.filter((item) => item.status === 'open').length,
      0,
    ),
    verification: guide.verification?.status ?? 'never-run',
    ...(guide.app && { appOrigin: guide.app.origin }),
    collectionId: guide.collectionId ?? null,
    thumb:
      guide.steps.find((step) => step.screenshot)?.screenshot?.rendered ?? null,
    updatedAt: guide.updatedAt,
  }
}

interface Cursor {
  id: string
  at: string
  filter: string
}
function filterKey(query: GuideQuery): string {
  // A cursor never contains search text, guide descriptions, targets or input values.
  return JSON.stringify([
    query.q?.trim().toLowerCase() ?? '',
    query.status ?? null,
    query.collection ?? null,
    query.collection === null,
  ])
}
async function fingerprint(query: GuideQuery): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(filterKey(query)),
  )
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
export function validateQuery(query: GuideQuery): void {
  if (
    !query ||
    typeof query !== 'object' ||
    (query.q !== undefined &&
      (typeof query.q !== 'string' || query.q.length > 1000)) ||
    (query.status !== undefined &&
      ![
        'draft',
        'published',
        'archived',
        'needs-review',
        'replay-passed',
      ].includes(query.status)) ||
    (query.collection !== undefined &&
      query.collection !== null &&
      typeof query.collection !== 'string') ||
    (query.cursor !== undefined &&
      (typeof query.cursor !== 'string' || query.cursor.length > 2048))
  )
    throw new StorageError('invalid_query')
}
function decodeCursor(value: string): Cursor {
  try {
    const input: unknown = JSON.parse(atob(value))
    if (
      !input ||
      typeof input !== 'object' ||
      !('id' in input) ||
      !('at' in input) ||
      !('filter' in input) ||
      Object.keys(input).length !== 3 ||
      typeof input.id !== 'string' ||
      typeof input.at !== 'string' ||
      typeof input.filter !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{2,80}$/.test(input.id) ||
      !Number.isFinite(Date.parse(input.at)) ||
      !/^[a-f0-9]{64}$/.test(input.filter)
    )
      throw new Error()
    return { id: input.id, at: input.at, filter: input.filter }
  } catch {
    throw new StorageError('invalid_query')
  }
}
function compare(
  a: { id: string; updatedAt: string },
  b: { id: string; updatedAt: string },
): number {
  return (
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

export async function guidePage(
  guides: Guide[],
  query: GuideQuery,
  pageSize: number,
): Promise<GuidePage> {
  validateQuery(query)
  const filter = await fingerprint(query)
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor)
  if (cursor && cursor.filter !== filter)
    throw new StorageError('invalid_query')
  const q = query.q?.trim().toLowerCase()
  const matching = guides
    .filter((guide) => {
      if (
        query.collection !== undefined &&
        (guide.collectionId ?? null) !== query.collection
      )
        return false
      if (
        query.status === 'needs-review' &&
        !guide.steps.some(
          (step) =>
            step.lowConfidence ||
            step.redactions.some((redaction) => redaction.status === 'open'),
        )
      )
        return false
      if (
        query.status === 'replay-passed' &&
        guide.verification?.status !== 'passed'
      )
        return false
      if (
        query.status &&
        !['needs-review', 'replay-passed'].includes(query.status) &&
        guide.status !== query.status
      )
        return false
      if (
        q &&
        ![
          guide.title,
          guide.description,
          guide.app?.name,
          guide.app?.origin,
          ...guide.tags,
        ].some((value) => value?.toLowerCase().includes(q))
      )
        return false
      return (
        !cursor || compare(guide, { id: cursor.id, updatedAt: cursor.at }) > 0
      )
    })
    .sort(compare)
  const items = matching.slice(0, pageSize)
  const last = items.at(-1)
  return {
    items: items.map(summary),
    nextCursor:
      matching.length > pageSize && last
        ? btoa(JSON.stringify({ id: last.id, at: last.updatedAt, filter }))
        : null,
  }
}

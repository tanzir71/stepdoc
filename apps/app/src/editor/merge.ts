import type { Guide, Step } from '@stepdoc/schema'
import { validDraft } from './model'
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b)
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export function mergeGuides(
  base: Guide,
  local: Guide,
  remote: Guide,
): { guide?: Guide; conflicts: string[] } {
  const conflicts: string[] = []
  const atomic = (
    before: unknown,
    ours: unknown,
    theirs: unknown,
    path: string,
  ): unknown => {
    if (equal(ours, before)) return structuredClone(theirs)
    if (equal(theirs, before) || equal(ours, theirs))
      return structuredClone(ours)
    conflicts.push(path)
    return structuredClone(ours)
  }
  const merge = (
    before: unknown,
    ours: unknown,
    theirs: unknown,
    path: string,
  ): unknown => {
    if (equal(ours, before)) return structuredClone(theirs)
    if (equal(theirs, before) || equal(ours, theirs))
      return structuredClone(ours)
    if (object(before) && object(ours) && object(theirs)) {
      const result: Record<string, unknown> = {}
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(ours),
        ...Object.keys(theirs),
      ])) {
        const value = merge(
          before[key],
          ours[key],
          theirs[key],
          `${path}.${key}`,
        )
        if (value !== undefined) result[key] = value
      }
      return result
    }
    conflicts.push(path)
    return structuredClone(ours)
  }
  const pack = (step: Step | undefined) =>
    step
      ? {
          ...step,
          index: undefined,
          screenshot: undefined,
          edits: undefined,
          click: undefined,
          redactions: undefined,
          image: {
            screenshot: step.screenshot,
            edits: step.edits,
            click: step.click,
            redactions: step.redactions,
          },
        }
      : undefined
  const ids = (guide: Guide) => guide.steps.map((step) => step.id)
  const baseIds = ids(base),
    localIds = ids(local),
    remoteIds = ids(remote)
  let order = remoteIds
  if (equal(remoteIds, baseIds) || equal(remoteIds, localIds)) order = localIds
  else if (!equal(localIds, baseIds)) conflicts.push('steps.order')
  const steps = new Map<string, Step>()
  for (const id of new Set([...baseIds, ...localIds, ...remoteIds])) {
    const before = pack(base.steps.find((step) => step.id === id)),
      ours = pack(local.steps.find((step) => step.id === id)),
      theirs = pack(remote.steps.find((step) => step.id === id))
    let merged: unknown
    if (before && ours && theirs) {
      const image = atomic(
        before.image,
        ours.image,
        theirs.image,
        `steps.${id}.image`,
      )
      const rest = merge(
        { ...before, image: undefined },
        { ...ours, image: undefined },
        { ...theirs, image: undefined },
        `steps.${id}`,
      )
      merged = { ...(rest as object), image }
    } else merged = merge(before, ours, theirs, `steps.${id}`)
    if (merged) {
      const { image, ...rest } = merged as NonNullable<ReturnType<typeof pack>>
      steps.set(id, { ...rest, ...image, index: 1 } as Step)
    }
  }
  const merged = merge(
    {
      ...base,
      steps: undefined,
      version: undefined,
      updatedAt: undefined,
      verification: undefined,
    },
    {
      ...local,
      steps: undefined,
      version: undefined,
      updatedAt: undefined,
      verification: undefined,
    },
    {
      ...remote,
      steps: undefined,
      version: undefined,
      updatedAt: undefined,
      verification: undefined,
    },
    'guide',
  ) as Guide
  merged.steps = [...new Set([...order, ...remoteIds, ...localIds])]
    .filter((id) => steps.has(id))
    .map((id) => steps.get(id)!)
  merged.version = remote.version
  merged.updatedAt = remote.updatedAt
  merged.verification = { status: 'never-run' }
  if (conflicts.length) return { conflicts }
  try {
    return { guide: validDraft(merged), conflicts: [] }
  } catch {
    return { conflicts: ['guide.validation'] }
  }
}

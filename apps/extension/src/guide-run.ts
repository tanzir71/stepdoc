import { type Guide, type Verification } from '@stepdoc/schema'
import { guideMeStepSchema, type GuideMeStep } from '@stepdoc/schema/guide-me'

export interface GuideRun {
  runId: string
  guideId: string
  version: number
  title: string
  tabId: number
  steps: GuideMeStep[]
  index: number
  sequence: number
  outcomes: ('matched' | 'confirmed' | 'skipped' | null)[]
  phase: 'running' | 'saving' | 'complete' | 'conflict' | 'save-error'
  target: {
    reason: 'matched' | 'missing' | 'ambiguous' | 'unavailable'
    rect: { x: number; y: number; width: number; height: number } | null
    frameId?: number
    documentId?: string
    token?: string
    strategy?: string
  }
  report?: Verification
  receipts?: {
    sequence: number
    frameId: number
    documentId: string
    token: string
  }[]
}
export function newGuideRun(guide: Guide, tabId: number): GuideRun {
  const steps = guide.steps.map((step) =>
    guideMeStepSchema.parse({
      id: step.id,
      index: step.index,
      type: step.type,
      action: step.action,
      title: step.title,
      description: step.description,
      url: step.url,
      target: step.target,
      value: step.value,
      key: step.key,
    }),
  )
  if (JSON.stringify(steps).length > 2_000_000)
    throw new Error('Guide too large')
  return {
    runId: crypto.randomUUID(),
    guideId: guide.id,
    version: guide.version,
    title: guide.title,
    tabId,
    steps,
    index: 0,
    sequence: 0,
    outcomes: steps.map(() => null),
    phase: 'running',
    target: { reason: 'missing', rect: null },
  }
}
export function advanceGuide(
  run: GuideRun,
  outcome: 'matched' | 'confirmed' | 'skipped',
): GuideRun {
  const next = structuredClone(run)
  next.outcomes[next.index] = outcome
  next.index++
  next.sequence++
  next.target = { reason: 'missing', rect: null }
  next.receipts = []
  if (next.index >= next.steps.length) next.phase = 'saving'
  return next
}
export function guideReport(
  run: GuideRun,
  at = new Date().toISOString(),
): Verification {
  const failed = run.outcomes.findIndex(
    (outcome) => !outcome || outcome === 'skipped',
  )
  return {
    status: failed < 0 ? 'passed' : 'failed',
    at,
    runner: 'guide-me',
    ...(failed >= 0 && { failedStep: failed + 1 }),
  }
}

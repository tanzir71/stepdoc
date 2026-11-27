import type { LegacyStorage } from './background'
import type { ReviewState } from './review'
import type { GuideRun } from './guide-run'
import type {
  CaptureDestination,
  ServerDestination,
} from '@stepdoc/schema/capture-destination'
import {
  captureControlStepSchema,
  capturePillViewSchema,
  captureSourceStateSchema,
  MAX_CAPTURE_CONTROL_BYTES,
  type CaptureControlStep,
} from '@stepdoc/schema/capture'

export type GuideRunView = Pick<
  GuideRun,
  | 'runId'
  | 'guideId'
  | 'title'
  | 'index'
  | 'sequence'
  | 'phase'
  | 'outcomes'
  | 'report'
> & {
  steps: Array<{ id: string; title: string }>
  target: Pick<GuideRun['target'], 'reason'>
}
export interface CaptureControls {
  recording?: boolean
  captureSessionId?: string
  captureError?: string | null
  captureBlurMode?: boolean
  captureManualCount?: number
  captureReview?: ReviewState
  captureDestination?: LegacyStorage['captureDestination']
  capturedSteps?: CaptureControlStep[]
  pendingSession?: boolean
  guideMe?: GuideRunView
}
function pick<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const result = {} as Pick<T, K>
  for (const key of keys) if (value[key] !== undefined) result[key] = value[key]
  return result
}
const serverView = (value: ServerDestination) =>
  pick(value, ['kind', 'server', 'deviceId', 'generation'])
const destinationView = (value: CaptureDestination) =>
  value.kind === 'browser' ? { kind: 'browser' as const } : serverView(value)
/** Full retained pixels never enter a controls response. */
export function captureControls(state: LegacyStorage): CaptureControls {
  const review = state.captureReview
  const result: CaptureControls = {
    ...pick(state, [
      'recording',
      'captureSessionId',
      'captureError',
      'captureBlurMode',
      'captureManualCount',
    ]),
    pendingSession: !!state.pendingSession,
    ...(state.captureDestination && {
      captureDestination: destinationView(state.captureDestination),
    }),
    ...(review && {
      captureReview: pick(review, [
        'phase',
        'title',
        'revision',
        'startedAt',
        'savedId',
        'saveError',
      ]),
    }),
    capturedSteps: state.guideMe
      ? []
      : (state.capturedSteps ?? []).map((step) =>
          captureControlStepSchema.parse({
            ...pick(step, ['id', 'index', 'type', 'action', 'title', 'notes']),
            targetRole: step.target?.role,
            valueKind: step.value?.kind,
            ...((step.value?.kind === 'variable' ||
              step.value?.kind === 'secret') && {
              variable: step.value.variable,
            }),
            maskCount: step.redactions?.length ?? 0,
            lowConfidence: step.lowConfidence ?? false,
          }),
        ),
  }
  if (review && result.captureReview) {
    if (review.preferences)
      result.captureReview.preferences = pick(review.preferences, [
        'smartBlur',
        'agentContext',
        'voiceNarration',
      ])
    if (review.clock)
      result.captureReview.clock = pick(review.clock, [
        'elapsedMs',
        'runningSince',
      ])
    if (review.destination)
      result.captureReview.destination = destinationView(review.destination)
    if (review.remoteAttempt)
      result.captureReview.remoteAttempt = serverView(review.remoteAttempt)
    if (review.remoteSaved)
      result.captureReview.remoteSaved = {
        id: review.remoteSaved.id,
        destination: serverView(review.remoteSaved.destination),
      }
  }
  if (state.guideMe) {
    const run = state.guideMe
    result.guideMe = {
      ...pick(run, [
        'runId',
        'guideId',
        'title',
        'index',
        'sequence',
        'phase',
        'outcomes',
      ]),
      steps: run.steps.map((step) => pick(step, ['id', 'title'])),
      target: { reason: run.target.reason },
      ...(run.report && {
        report: pick(run.report, ['status', 'at', 'runner', 'failedStep']),
      }),
    }
  }
  if (
    new TextEncoder().encode(JSON.stringify(result)).byteLength >
    MAX_CAPTURE_CONTROL_BYTES
  )
    throw new Error('Capture controls unavailable')
  return result
}

/** Source worlds receive only the selected capture's recorder state. */
export function captureSourceState(state: LegacyStorage, tabId?: number) {
  const selected = tabId !== undefined && tabId === state.captureTabId
  const phase = state.captureReview?.phase
  const count = state.capturedSteps?.length ?? 0
  const pill = selected
    ? capturePillViewSchema.safeParse({
        sessionId: state.captureSessionId,
        phase: phase ?? (state.recording ? 'recording' : 'idle'),
        count,
        clock: state.captureReview?.clock,
      })
    : undefined
  const result = captureSourceStateSchema.safeParse({
    recording: selected && !!state.recording,
    paused: selected && ['pausing', 'paused', 'stopping'].includes(phase ?? ''),
    producerStopped: selected && ['pausing', 'stopping'].includes(phase ?? ''),
    captureSessionId: selected ? state.captureSessionId : undefined,
    captureBlurMode: selected && !!state.captureBlurMode,
    captureManualCount: selected ? (state.captureManualCount ?? 0) : 0,
    stepCount: selected ? count : 0,
    capturePill: pill?.success ? pill.data : null,
  })
  return result.success
    ? result.data
    : {
        recording: false,
        paused: false,
        producerStopped: false,
      captureSessionId: undefined,
        captureBlurMode: false,
        captureManualCount: 0,
        stepCount: 0,
        capturePill: null,
      }
}

/** Identical metadata-only projection for broadcast and source readiness. */
export function captureSourceMessage(state: LegacyStorage, tabId: number) {
  const source = captureSourceState(state, tabId)
  return {
    type: 'STATE',
    recording: source.recording,
    paused: source.paused,
    producerStopped: source.producerStopped,
    stepCount: source.stepCount,
    sessionId: source.captureSessionId,
    blurMode: source.captureBlurMode,
    manualCount: source.captureManualCount,
    capturePill: source.capturePill,
  }
}

import { z } from 'zod'
import { guideSchema, rectSchema, redactionSchema, stepSchema } from './guide'

// Ephemeral extension transport, not guide data or the public Storage API.
export const CAPTURE_TRANSPORT = 'stepdoc/capture@1' as const
// Private notification only. Receivers fetch their existing bounded projection.
export const captureNoticeSchema = z.strictObject({
  type: z.literal('CAPTURE_CHANGED'),
  guideResult: z
    .strictObject({
      guideId: guideSchema.shape.id,
      saved: z.boolean(),
    })
    .optional(),
})
export type CaptureNotice = z.output<typeof captureNoticeSchema>
export const captureClockSchema = z.strictObject({
  elapsedMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  runningSince: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
})
export type CaptureClock = z.output<typeof captureClockSchema>
export const capturePillControlSchema = z.strictObject({
  type: z.literal('CAPTURE_PILL_CONTROL'),
  sessionId: z.string().uuid(),
  action: z.enum(['pause', 'resume', 'stop', 'open-review']),
})
export type CapturePillControl = z.output<typeof capturePillControlSchema>
export const capturePillViewSchema = z.strictObject({
  sessionId: z.string().uuid(),
  phase: z.enum([
    'starting',
    'recording',
    'pausing',
    'paused',
    'stopping',
    'review',
    'saving',
    'idle',
  ]),
  count: z.number().int().min(0).max(500),
  clock: captureClockSchema.optional(),
})
export type CapturePillView = z.output<typeof capturePillViewSchema>
export const captureSourceStateSchema = z.strictObject({
  recording: z.boolean(),
  paused: z.boolean(),
  producerStopped: z.boolean(),
  captureSessionId: z.string().uuid().optional(),
  captureBlurMode: z.boolean(),
  captureManualCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  stepCount: z.number().int().min(0).max(500),
  capturePill: capturePillViewSchema.nullable(),
})
// Display-only projections: no image URLs, target locators or recorded values.
export const captureControlStepSchema = z.strictObject({
  id: z.string().min(1),
  index: z.number().int().min(1).max(500),
  type: stepSchema.shape.type,
  action: stepSchema.shape.action,
  title: z.string().min(1),
  notes: z.string().optional(),
  targetRole: z.string().optional(),
  valueKind: z.enum(['none', 'literal', 'variable', 'secret']).optional(),
  variable: z.string().optional(),
  maskCount: z.number().int().nonnegative(),
  lowConfidence: z.boolean(),
})
export type CaptureControlStep = z.output<typeof captureControlStepSchema>
export const capturePreviewCommandSchema = z.strictObject({
  type: z.literal('CAPTURE_PREVIEW'),
  sessionId: z.string().uuid(),
  stepId: z.string().min(1).max(200),
})
export const CAPTURE_PREVIEW = Object.freeze({
  width: 224,
  height: 144,
  maxBytes: 64 * 1024,
})
// Leave headroom below Chrome's 64 MiB runtime-message ceiling.
export const MAX_CAPTURE_CONTROL_BYTES = 48 * 1024 * 1024
export const capturePreferencesSchema = z.strictObject({
  smartBlur: z.boolean().default(true),
  agentContext: z.boolean().default(true),
  voiceNarration: z.boolean().default(false),
})
// Private extension controls only. Final, client-redacted text uses Step.notes.
export const narrationCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('NARRATION_CLAIM'),
    owner: z.string().uuid(),
    sessionId: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal('NARRATION_RELEASE'),
    owner: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal('NARRATION_APPEND'),
    owner: z.string().uuid(),
    sessionId: z.string().uuid(),
    stepId: z.string().min(1).max(200),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    text: z.string().min(1).max(4000),
  }),
])
// Display-only local suggestions. Apply sends IDs, never client-authored changes.
export const captureCleanupSuggestionSchema = z.strictObject({
  id: z.string().min(1).max(32),
  kind: z.enum(['rename', 'merge', 'check']),
  stepIds: z.array(z.string().min(1).max(200)).min(1).max(2),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(500),
})
export type CaptureCleanupSuggestion = z.output<
  typeof captureCleanupSuggestionSchema
>
export const reviewEditSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('title'),
    title: z.string().trim().min(1).max(200),
  }),
  z.strictObject({
    operation: z.literal('delete'),
    ids: z.array(z.string()).min(1).max(500),
  }),
  z.strictObject({
    operation: z.literal('merge'),
    ids: z.array(z.string()).min(2).max(500),
  }),
  z.strictObject({
    operation: z.literal('move'),
    id: z.string(),
    direction: z.enum(['up', 'down']),
  }),
  z.strictObject({
    operation: z.literal('cleanup'),
    ids: z.array(z.string().min(1).max(32)).min(1).max(500),
  }),
])
export type CapturePreferences = z.output<typeof capturePreferencesSchema>
export type ReviewEdit = z.input<typeof reviewEditSchema>
export const FRAME_LIMITS = Object.freeze({
  frames: 128,
  depth: 20,
  masks: 12_000,
  selector: 2_000,
})
export const captureViewportSchema = z.strictObject({
  width: z.number().positive().max(16_384),
  height: z.number().positive().max(16_384),
})
const documentId = z.string().uuid()
export const frameChildSchema = z.strictObject({
  token: documentId,
  selector: z.string().min(1).max(FRAME_LIMITS.selector).nullable(),
  outer: rectSchema,
  content: rectSchema,
  precise: z.boolean(),
})
export const frameSnapshotSchema = z.strictObject({
  schema: z.literal(CAPTURE_TRANSPORT),
  nonce: documentId,
  documentId,
  url: z.string().max(8_192).nullable(),
  parentSelector: z.string().min(1).max(FRAME_LIMITS.selector).nullable(),
  // Hidden browsing contexts can have zero-sized viewports; they contribute no
  // precise pixels and cannot be a trusted visible interaction source.
  viewport: z.strictObject({
    width: z.number().nonnegative().max(16_384),
    height: z.number().nonnegative().max(16_384),
  }),
  devicePixelRatio: z.number().positive().max(8),
  revision: z.number().int().nonnegative(),
  children: z.array(frameChildSchema).max(FRAME_LIMITS.frames),
  masks: z.array(redactionSchema).max(FRAME_LIMITS.masks),
  geometryMotion: z.boolean(),
})
export const localCaptureSchema = z.strictObject({
  schema: z.literal(CAPTURE_TRANSPORT),
  documentId,
  step: stepSchema,
  topUrl: z.string().max(8_192).nullable(),
  devicePixelRatio: z.number().positive().max(8),
  viewport: captureViewportSchema,
  inputType: z
    .enum([
      'button',
      'checkbox',
      'color',
      'date',
      'datetime-local',
      'email',
      'file',
      'hidden',
      'image',
      'month',
      'number',
      'password',
      'radio',
      'range',
      'reset',
      'search',
      'submit',
      'tel',
      'text',
      'time',
      'url',
      'week',
    ])
    .optional(),
})
export const FRAME_PROBE = 'stepdoc/frame-probe@1' as const
export const frameProbeSchema = z.strictObject({
  type: z.literal(FRAME_PROBE),
  nonce: documentId,
  token: documentId,
})
export const frameLinkSchema = frameProbeSchema.extend({ documentId })
export const redactionChangeSchema = z.strictObject({
  type: z.literal('REDACTION_CHANGED'),
  sessionId: documentId,
  documentId,
  count: z.number().int().min(1).max(500),
})
export type FrameSnapshot = z.output<typeof frameSnapshotSchema>
export type FrameChild = z.output<typeof frameChildSchema>
export type LocalCapture = z.output<typeof localCaptureSchema>
export type FrameLink = z.output<typeof frameLinkSchema>

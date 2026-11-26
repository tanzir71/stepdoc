import { z } from 'zod'
import { rectSchema, redactionSchema, stepSchema } from './guide'

// Ephemeral extension transport, not guide data or the public Storage API.
export const CAPTURE_TRANSPORT = 'stepdoc/capture@1' as const
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
export type FrameSnapshot = z.output<typeof frameSnapshotSchema>
export type FrameChild = z.output<typeof frameChildSchema>
export type LocalCapture = z.output<typeof localCaptureSchema>
export type FrameLink = z.output<typeof frameLinkSchema>

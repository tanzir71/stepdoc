import { z } from 'zod'

const tabId = z.number().int().positive().max(2_147_483_647)
const origin = z
  .string()
  .max(8192)
  .refine((value) => {
    try {
      const url = new URL(value)
      return ['http:', 'https:'].includes(url.protocol) && url.origin === value
    } catch {
      return false
    }
  })
/** Private extension control data. No titles, paths, query strings or field values. */
export const captureBrowserSessionSchema = z.string().uuid()
export const captureTargetSchema = z.strictObject({
  tabId,
  origin,
  browserSession: captureBrowserSessionSchema,
})
export type CaptureTarget = z.output<typeof captureTargetSchema>
export const captureTargetListSchema = z.strictObject({
  targets: z.array(captureTargetSchema.extend({ ready: z.boolean() })),
  suggested: captureTargetSchema.nullable(),
})
export type CaptureTargetList = z.output<typeof captureTargetListSchema>
export const captureTargetErrorSchema = z.enum([
  'unavailable',
  'changed',
  'loading',
  'expired',
  'busy',
  'forbidden',
])
export type CaptureTargetErrorCode = z.output<typeof captureTargetErrorSchema>
export const captureTargetCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('CAPTURE_TARGETS') }),
  z.strictObject({
    type: z.literal('CAPTURE_FOCUS_TARGET'),
    target: captureTargetSchema,
  }),
])
export const captureStartSchema = z.strictObject({
  type: z.literal('START_CAPTURE'),
  target: captureTargetSchema.optional(),
  // Existing controls carry these optimistic review fields, including on start.
  sessionId: z.string().uuid().optional(),
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
})

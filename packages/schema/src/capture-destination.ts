import { z } from 'zod'
import { guideSchema } from './guide'

// Private extension metadata, separate from guide@1 and never a credential DTO.
export const serverDestinationSchema = z.strictObject({
  kind: z.literal('server'),
  server: z.string().min(1).max(4096),
  deviceId: z.string().min(1).max(4096),
  generation: z.string().uuid(),
})
export type ServerDestination = z.output<typeof serverDestinationSchema>
export const captureDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('browser') }),
  serverDestinationSchema,
])
export type CaptureDestination = z.output<typeof captureDestinationSchema>
export const captureReceiptSchema = z.strictObject({
  id: guideSchema.shape.id,
  destination: serverDestinationSchema,
})
export type CaptureReceipt = z.output<typeof captureReceiptSchema>
const optimistic = {
  sessionId: z.string().uuid().optional(),
  revision: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
}
export const captureDestinationCommandSchema = z.strictObject({
  type: z.literal('SET_CAPTURE_DESTINATION'),
  ...optimistic,
  destination: captureDestinationSchema,
})
export const captureSaveCommandSchema = z.strictObject({
  type: z.literal('SAVE_CAPTURE'),
  ...optimistic,
  openEditor: z.boolean().optional(),
  keepLocal: z.boolean().optional(),
})
export const captureRecentCommandSchema = z.strictObject({
  type: z.literal('CAPTURE_SERVER_RECENT'),
  destination: serverDestinationSchema,
})
export const captureDestinationErrorSchema = z.enum([
  'no_connection',
  'connection_changed',
  'revoked',
  'unavailable',
  'too_large',
  'invalid_capture',
  'redaction_open',
  'editor_unavailable',
  'storage_unavailable',
  'busy',
  'stale',
  'forbidden',
  'cancelled',
])
export type CaptureDestinationErrorCode = z.output<
  typeof captureDestinationErrorSchema
>

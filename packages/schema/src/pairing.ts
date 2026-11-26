import { z } from 'zod'
import {
  bearerTokenSchema,
  apiScopeSchema,
  pairingClaimSchema,
} from './storage-api'
import { guideSchema } from './guide'

export const pairingErrorSchema = z.enum([
  'invalid_code',
  'invalid_server',
  'connection_unavailable',
  'revoked',
  'storage_unavailable',
  'conflict',
  'busy',
  'cancelled',
  'forbidden',
])
export type PairingErrorCode = z.output<typeof pairingErrorSchema>
const scopes = z
  .array(apiScopeSchema)
  .length(2)
  .refine(
    (value) => value.includes('capture:write') && value.includes('guides:read'),
  )
export const privateConnectionSchema = z.strictObject({
  server: z.string().min(1).max(4096),
  deviceId: z.string().min(1).max(4096),
  deviceName: z.string().min(1).max(120),
  token: bearerTokenSchema,
  scopes,
  pairedAt: guideSchema.shape.updatedAt,
  checkedAt: guideSchema.shape.updatedAt.nullable(),
  status: z.enum(['paired', 'ready', 'unavailable', 'revoked']),
})
export type PrivateConnection = z.output<typeof privateConnectionSchema>
export const publicConnectionSchema = privateConnectionSchema.omit({
  token: true,
})
export type PublicConnection = z.output<typeof publicConnectionSchema>
export const connectionVaultSchema = z.strictObject({
  version: z.literal(1),
  generation: z.string().uuid(),
  connection: privateConnectionSchema.nullable(),
})
export type ConnectionVaultState = z.output<typeof connectionVaultSchema>
export const pairingStateSchema = z.strictObject({
  epoch: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  generation: z.string().uuid().nullable(),
  connection: publicConnectionSchema.nullable(),
  pending: z
    .strictObject({ id: z.string().uuid(), kind: z.enum(['connect', 'test']) })
    .nullable(),
  error: pairingErrorSchema.nullable(),
})
export type PairingState = z.output<typeof pairingStateSchema>
export const pairingCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('PAIR_STATUS') }),
  z.strictObject({
    type: z.literal('PAIR_CONNECT'),
    attemptId: z.string().uuid(),
    expectedGeneration: z.string().uuid(),
    server: z.string().min(1).max(4096),
    code: pairingClaimSchema.shape.code,
  }),
  z.strictObject({
    type: z.literal('PAIR_TEST'),
    attemptId: z.string().uuid(),
    expectedGeneration: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal('PAIR_CANCEL'),
    attemptId: z.string().uuid(),
  }),
  z.strictObject({
    type: z.literal('PAIR_FORGET'),
    expectedGeneration: z.string().uuid().nullable(),
  }),
])
export type PairingCommand = z.output<typeof pairingCommandSchema>

import { z } from 'zod'
import { guideSchema } from './guide'

// Client projections of the existing Storage API v1, not guide@1 additions.
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const revision = count.min(1)
export const apiHealthSchema = z.object({
  target: z.enum(['php-sqlite', 'cloudflare', 'node-postgres']),
  version: z.string().min(1),
  schema: z.literal('stepdoc/guide@1'),
  capabilities: z.object({
    members: z.boolean().optional(),
    passkeys: z.boolean().optional(),
    emailCodes: z.boolean().optional(),
    publicLinks: z.boolean().optional(),
    githubPages: z.boolean().optional(),
    mcp: z.boolean().optional(),
    maxUploadBytes: count,
    maxJsonBytes: count.min(1).optional(),
    captureBlobUpload: z.boolean().optional(),
  }),
  checks: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(['ok', 'warn', 'fail']),
        message: z.string(),
      }),
    )
    .optional(),
})
export type ApiHealth = z.output<typeof apiHealthSchema>
export const apiGuideSummarySchema = z.object({
  id: guideSchema.shape.id,
  title: guideSchema.shape.title,
  stepCount: count.max(500),
  status: z.enum(['draft', 'published', 'archived']),
  openRedactions: count,
  verification: z.string(),
  appOrigin: z.string().optional(),
  collectionId: z.string().nullable(),
  thumb: z.string().nullable(),
  updatedAt: guideSchema.shape.updatedAt,
})
export const apiGuidePageSchema = z.object({
  items: z.array(apiGuideSummarySchema),
  nextCursor: z.string().nullable(),
})
export const apiVersionsSchema = z.array(
  z.object({
    version: revision,
    at: guideSchema.shape.updatedAt,
    by: z.string(),
    summary: z.string(),
  }),
)
export const apiBlobKeySchema = z.object({ key: z.string().min(1).max(4096) })
export const apiScopeSchema = z.enum([
  'capture:write',
  'guides:read',
  'guides:write',
  'publish:write',
  'replay:write',
  'admin',
])
export const pairingClaimSchema = z.strictObject({
  code: z.string().regex(/^[A-Z0-9]{3}-[A-Z0-9]{3}$/),
  deviceName: z.string().trim().min(1).max(120),
  extensionId: z.string().min(1).max(200),
})
export type PairingClaim = z.input<typeof pairingClaimSchema>
export const bearerTokenSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9._~+/-]+=*$/)
export const issuedTokenSchema = z.object({
  id: z.string().min(1).max(4096),
  token: bearerTokenSchema,
  scopes: z.array(apiScopeSchema),
})
export type IssuedToken = z.output<typeof issuedTokenSchema>

// Response projection of the existing capture:write POST /sessions operation.
export const apiCaptureResultSchema = z.object({
  guide: guideSchema,
  editUrl: z.string().min(1).max(4096),
})
export type ApiCaptureResult = z.output<typeof apiCaptureResultSchema>
// Multipart metadata for private, capture-scoped staging on the existing blob route.
export const apiCaptureBlobSchema = z.strictObject({
  captureUuid: guideSchema.shape.uuid.unwrap(),
  stepId: z
    .string()
    .min(1)
    .refine((value) => [...value].length <= 200),
  kind: z.enum(['original', 'rendered']),
})

// Authentication/device projections of Storage API v1. These are not guide fields.
export const apiSessionSchema = z.object({
  member: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.email(),
    role: z.enum(['owner', 'editor', 'viewer']),
  }),
  workspace: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  needsPasskey: z.boolean().optional(),
  recoveryCodes: z
    .array(z.string().regex(/^[A-F0-9]{6}(?:-[A-F0-9]{6}){3}$/))
    .length(10)
    .optional(),
})
export type ApiSession = z.output<typeof apiSessionSchema>
export const apiPairingCodeSchema = z.object({
  code: pairingClaimSchema.shape.code,
  expiresAt: guideSchema.shape.updatedAt,
})
export const apiDevicesSchema = z.array(
  z.object({
    id: z.string().min(1),
    kind: z.enum(['extension', 'mcp', 'ci', 'token']),
    name: z.string().min(1),
    scopes: z.array(apiScopeSchema),
    lastSeenAt: guideSchema.shape.updatedAt.nullable(),
  }),
)
export type ApiDevice = z.output<typeof apiDevicesSchema>[number]
export type ApiPairingCode = z.output<typeof apiPairingCodeSchema>
export const apiTokenInputSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((value) => new TextEncoder().encode(value).length <= 120),
  scopes: z
    .array(apiScopeSchema)
    .min(1)
    .max(6)
    .refine((scopes) => new Set(scopes).size === scopes.length),
})
export type ApiTokenInput = z.input<typeof apiTokenInputSchema>

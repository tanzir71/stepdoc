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

import { z } from 'zod'

/** Portable workspace envelope. Guide records remain stepdoc/guide@1. */
export const WORKSPACE_FORMAT = 'stepdoc/workspace@1'
export const WORKSPACE_GUIDE_LIMIT = 500
export const workspaceManifestSchema = z.strictObject({
  format: z.literal(WORKSPACE_FORMAT),
  files: z
    .array(
      z.strictObject({
        path: z.string().regex(/^guides\/[1-9][0-9]{0,2}\.stepdoc$/),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(WORKSPACE_GUIDE_LIMIT),
})

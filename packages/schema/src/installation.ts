import { z } from 'zod'

/** PHP distribution bootstrap, separate from the shared Storage API. No secrets. */
export const installationStatusSchema = z
  .object({
    phase: z.enum(['storage', 'owner', 'complete']),
    base: z
      .string()
      .max(200)
      .regex(/^(?:\/[a-zA-Z0-9_-]+)*$/),
    ready: z.boolean(),
    checks: z
      .array(
        z
          .object({
            id: z
              .string()
              .min(1)
              .max(40)
              .regex(/^[a-z-]+$/),
            status: z.enum(['ok', 'warn', 'error']),
            message: z.string().min(1).max(200),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    owner: z
      .object({
        name: z.string().min(1).max(120),
        email: z.string().email().max(254),
        workspace: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
  })
  .strict()
export type InstallationStatus = z.infer<typeof installationStatusSchema>

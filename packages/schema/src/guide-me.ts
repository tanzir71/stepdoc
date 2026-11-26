import { z } from 'zod'
import { rectSchema, stepSchema, verificationSchema } from './guide'

// Private extension walkthrough protocol, not new guide@1 data or HTTP routes.
export const guideMeStepSchema = z
  .strictObject({
    id: stepSchema.shape.id,
    index: stepSchema.shape.index,
    type: stepSchema.shape.type,
    action: stepSchema.shape.action,
    title: stepSchema.shape.title,
    description: stepSchema.shape.description,
    url: stepSchema.shape.url,
    target: stepSchema.shape.target,
    value: stepSchema.shape.value,
    key: stepSchema.shape.key,
  })
  .refine(
    (step) =>
      step.action !== 'fill' ||
      step.value?.kind === 'variable' ||
      step.value?.kind === 'secret',
  )
  .refine(
    (step) =>
      step.value?.kind !== 'literal' ||
      step.action === 'select' ||
      step.action === 'press',
  )
export const guideMeControlSchema = z.strictObject({
  type: z.literal('GUIDE_CONTROL'),
  runId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  action: z.enum(['back', 'skip', 'confirm', 'stop', 'retry', 'dismiss']),
})
export const guideMeMatchSchema = z.strictObject({
  type: z.literal('GUIDE_MATCH'),
  runId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  documentId: z.string().uuid(),
  token: z.string().uuid(),
})
export const guideMeLocateSchema = z.strictObject({
  type: z.literal('GUIDE_LOCATE'),
  runId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  step: guideMeStepSchema,
})
export const guideMeLocatedSchema = z.strictObject({
  documentId: z.string().uuid(),
  token: z.string().uuid(),
  rect: rectSchema.nullable(),
  reason: z.enum(['matched', 'missing', 'ambiguous', 'unavailable']),
  strategy: z.string().optional(),
})
export type GuideMeStep = z.output<typeof guideMeStepSchema>
export type GuideMeLocated = z.output<typeof guideMeLocatedSchema>
export type GuideMeControl = z.output<typeof guideMeControlSchema>
export type GuideMeMatch = z.output<typeof guideMeMatchSchema>
export const guideMeViewSchema = z.strictObject({
  runId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  index: z.number().int().min(0).max(500),
  total: z.number().int().min(1).max(500),
  title: z.string().max(5_000),
  description: z.string().max(20_000),
  phase: z.enum(['running', 'saving', 'complete', 'conflict', 'save-error']),
  rect: rectSchema.nullable(),
  reason: z.enum(['matched', 'missing', 'ambiguous', 'unavailable']),
  report: verificationSchema.optional(),
  confirmed: z.number().int().min(0).max(500),
})
export type GuideMeView = z.output<typeof guideMeViewSchema>

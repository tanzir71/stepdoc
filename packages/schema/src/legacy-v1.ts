import { z } from 'zod'

// Isolated v1 API/capture contracts. guide@1 lives in ./guide; these names are
// intentionally available only through @stepdoc/schema/legacy-v1 until M14 parity.

export const clickSchema = z.object({ x: z.number(), y: z.number(), radius: z.number().positive().default(24) })
export const elementMetaSchema = z.object({
  event: z.enum(['click','input','select','submit','navigation']), tag: z.string(), role: z.string().optional(),
  label: z.string().optional(), ariaLabel: z.string().optional(), innerText: z.string().optional(), placeholder: z.string().optional(),
  alt: z.string().optional(), title: z.string().optional(), name: z.string().optional(), inputType: z.string().optional(), optionLabel: z.string().optional(),
  selector: z.string().optional(), rect: z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()}).optional(),
  click: z.object({x:z.number(),y:z.number()}).optional(), devicePixelRatio: z.number().optional(),
  viewport: z.object({width:z.number(),height:z.number()}).optional(), url: z.string(), pageTitle: z.string().optional(), lowConfidence:z.boolean().optional()
})
export type ElementMeta = z.infer<typeof elementMetaSchema>
export const editsSchema = z.object({
  blur: z.array(z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()})).default([]),
  crop: z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()}).nullable().default(null),
  annotations: z.array(z.discriminatedUnion('type',[
    z.object({type:z.literal('rectangle'),x:z.number(),y:z.number(),width:z.number(),height:z.number(),color:z.string().default('#ef4444')}),
    z.object({type:z.literal('arrow'),x:z.number(),y:z.number(),toX:z.number(),toY:z.number(),color:z.string().default('#ef4444')}),
    z.object({type:z.literal('text'),x:z.number(),y:z.number(),text:z.string(),color:z.string().default('#ef4444')})
  ])).default([])
})
export type ImageEdits = z.infer<typeof editsSchema>
export const stepSchema = z.object({id:z.string().uuid().optional(),position:z.number().int().nonnegative(),type:z.enum(['action','navigate','section','manual']),text:z.string().min(1),pageUrl:z.string().nullable().optional(),screenshot:z.string().optional(),screenshotPath:z.string().nullable().optional(),renderedPath:z.string().nullable().optional(),click:clickSchema.nullable().optional(),elementMeta:elementMetaSchema.nullable().optional(),edits:editsSchema.default({blur:[],crop:null,annotations:[]}),lowConfidence:z.boolean().optional()})
export const sessionSchema = z.object({title:z.string().default('Untitled guide'),description:z.string().default(''),sourceUrl:z.string().optional(),steps:z.array(stepSchema).min(1).max(500)})
export const guideUpdateSchema = z.object({title:z.string().min(1).max(200).optional(),description:z.string().max(5000).optional(),isPublic:z.boolean().optional(),steps:z.array(stepSchema).max(500).optional()})
export type StepInput=z.infer<typeof stepSchema>; export type SessionInput=z.infer<typeof sessionSchema>

import { z } from 'zod'
import addFormats from 'ajv-formats'
import jsonSchema from '../../../docs/v2/guide.schema.json' with { type: 'json' }

export const GUIDE_SCHEMA_ID = 'stepdoc/guide@1' as const
export const GUIDE_SCHEMA_URL =
  'https://stepdoc.dev/schema/guide@1.json' as const
export const guideJsonSchema = jsonSchema

// JSON Schema formats differ from Zod's URL/UUID/ISO formats at their edges
// (URNs, UUID versions, time zones and leap seconds). Use the same RFC checks.
function formattedString(name: 'uri' | 'uuid' | 'date-time') {
  // These three named formats are synchronous string validators in ajv-formats.
  const format = addFormats.get(name) as
    | RegExp
    | ((value: string) => boolean)
    | { validate: (value: string) => boolean }
  return z.string().refine((value) => {
    if (format instanceof RegExp) return format.test(value)
    if (typeof format === 'function') return format(value)
    return format.validate(value)
  }, `Invalid ${name}`)
}

const variableName = z.string().regex(/^[a-z][a-z0-9_]{0,40}$/)
const dateTime = formattedString('date-time')
// JSON Schema counts Unicode code points and permits all finite integers.
// Zod's native max-length and int checks use UTF-16 units and safe integers.
const integer = z.number().refine(Number.isInteger, 'Expected an integer')
function boundedText(maximum: number) {
  return z
    .string()
    .refine(
      (value) => [...value].length <= maximum,
      `Must contain at most ${maximum} characters`,
    )
}
export const variableSchema = z
  .strictObject({
    name: variableName,
    kind: z.enum(['variable', 'secret']),
    type: z.enum(['string', 'number', 'boolean', 'enum']).default('string'),
    options: z.array(z.string()).optional(),
    description: z.string().optional(),
    example: z.string().optional(),
  })
  .superRefine((variable, ctx) => {
    if (variable.kind === 'secret' && variable.example !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['example'],
        message: 'Secrets cannot have stored examples',
      })
    }
  })

export const rectSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
})

export const locatorSchema = z.strictObject({
  strategy: z.enum([
    'role',
    'testId',
    'label',
    'placeholder',
    'text',
    'altText',
    'title',
    'css',
    'xpath',
  ]),
  value: z.string(),
  name: z.string().optional(),
  exact: z.boolean().default(true),
  unique: z.boolean().optional(),
})

export const targetSchema = z.strictObject({
  role: z.string().optional(),
  name: z.string().optional(),
  tag: z.string().optional(),
  locators: z.array(locatorSchema).optional(),
  frame: z.array(z.string()).optional(),
  shadowPath: z.array(z.string()).optional(),
  rect: rectSchema.optional(),
})

export const valueSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('literal'), literal: z.string() }),
  z.strictObject({ kind: z.literal('variable'), variable: variableName }),
  z.strictObject({ kind: z.literal('secret'), variable: variableName }),
])

const expectedTarget = z.strictObject({
  role: z.string().optional(),
  name: z.string().optional(),
})
export const expectationSchema = z.strictObject({
  urlMatches: z.string().optional(),
  visible: expectedTarget.optional(),
  hidden: expectedTarget.optional(),
  text: z
    .strictObject({
      role: z.string().optional(),
      contains: z.string().optional(),
    })
    .optional(),
})

export const annotationSchema = z.strictObject({
  type: z.enum(['rectangle', 'arrow', 'text', 'pin']),
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  toX: z.number().optional(),
  toY: z.number().optional(),
  text: z.string().optional(),
  color: z.string().default('accent'),
})

export const redactionSchema = z.strictObject({
  kind: z.enum([
    'password',
    'email',
    'phone',
    'card',
    'iban',
    'token',
    'ip',
    'name',
    'field',
    'custom',
  ]),
  source: z.enum(['auto', 'manual', 'policy']),
  rule: z.string().optional(),
  rect: rectSchema,
  status: z.enum(['applied', 'kept', 'open']).default('applied'),
})

export const screenshotSchema = z.strictObject({
  original: z.string().nullable().optional(),
  rendered: z.string(),
  width: integer,
  height: integer,
  devicePixelRatio: z.number().default(1),
  alt: z.string().optional(),
})

export const clickSchema = z.strictObject({
  x: z.number().optional(),
  y: z.number().optional(),
  radius: z.number().default(18),
})

export const editsSchema = z.strictObject({
  crop: rectSchema.nullable().optional(),
  annotations: z.array(annotationSchema).optional(),
})

export const stepSchema = z
  .strictObject({
    id: z.string(),
    index: integer.min(1),
    type: z.enum(['action', 'navigate', 'section', 'manual', 'assert']),
    action: z
      .enum([
        'click',
        'dblclick',
        'fill',
        'select',
        'check',
        'uncheck',
        'press',
        'hover',
        'upload',
        'navigate',
        'assert',
        'wait',
      ])
      .optional(),
    title: z.string().min(1),
    description: z.string().default(''),
    url: z.string().nullable().optional(),
    target: targetSchema.optional(),
    value: valueSchema.optional(),
    key: z.string().optional(),
    expect: expectationSchema.optional(),
    screenshot: screenshotSchema.optional(),
    click: clickSchema.nullable().optional(),
    edits: editsSchema.optional(),
    redactions: z.array(redactionSchema).default([]),
    confidence: z.number().min(0).max(1).optional(),
    lowConfidence: z.boolean().default(false),
    notes: z.string().optional(),
  })
  .superRefine((step, ctx) => {
    if (
      step.action === 'fill' &&
      step.value?.kind !== 'variable' &&
      step.value?.kind !== 'secret'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Fill steps must reference a variable or secret',
      })
    }
    if (
      step.value?.kind === 'literal' &&
      step.action !== 'select' &&
      step.action !== 'press'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: 'Literals are only allowed for select options and key names',
      })
    }
  })

export const verificationSchema = z.strictObject({
  status: z
    .enum(['passed', 'failed', 'not-replayable', 'never-run'])
    .default('never-run'),
  at: dateTime.nullable().optional(),
  runner: z.string().optional(),
  failedStep: integer.nullable().optional(),
})

export const guideSchema = z.strictObject({
  schema: z.literal(GUIDE_SCHEMA_ID),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/),
  uuid: formattedString('uuid').optional(),
  title: boundedText(200).min(1),
  description: boundedText(5000).default(''),
  app: z
    .strictObject({
      name: z.string().optional(),
      origin: formattedString('uri'),
      version: z.string().optional(),
    })
    .optional(),
  locale: z.string().default('en'),
  collectionId: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  preconditions: z.array(z.string()).default([]),
  variables: z.array(variableSchema).default([]),
  steps: z.array(stepSchema).min(1).max(500),
  version: integer.min(1),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  createdAt: dateTime,
  updatedAt: dateTime,
  capturedAt: dateTime.nullable().optional(),
  verification: verificationSchema.optional(),
  publish: z
    .strictObject({
      publicId: z.string().nullable().optional(),
      isPublic: z.boolean().default(false),
      targets: z
        .array(z.enum(['link', 'embed', 'github-pages', 'cloudflare-pages']))
        .default([]),
    })
    .optional(),
})

export type Guide = z.output<typeof guideSchema>
export type GuideInput = z.input<typeof guideSchema>
export type Step = z.output<typeof stepSchema>
export type StepInput = z.input<typeof stepSchema>
export type Target = z.output<typeof targetSchema>
export type Locator = z.output<typeof locatorSchema>
export type Variable = z.output<typeof variableSchema>
export type Value = z.output<typeof valueSchema>
export type Rect = z.output<typeof rectSchema>
export type Annotation = z.output<typeof annotationSchema>
export type Redaction = z.output<typeof redactionSchema>
export type Screenshot = z.output<typeof screenshotSchema>
export type Click = z.output<typeof clickSchema>
export type ImageEdits = z.output<typeof editsSchema>
export type Expectation = z.output<typeof expectationSchema>
export type Verification = z.output<typeof verificationSchema>

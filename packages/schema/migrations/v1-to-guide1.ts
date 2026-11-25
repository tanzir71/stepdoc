import { z } from 'zod'
import {
  GUIDE_SCHEMA_ID,
  annotationSchema,
  guideSchema,
  rectSchema,
  type Guide,
  type GuideInput,
  type Locator,
  type StepInput,
  type Target,
  type Variable,
} from '../src/guide'

// A narrow database-row projection, distinct from the legacy API payload module:
// migration consumes only replay metadata, not capture-only click/viewport fields.
const v1ElementMetaSchema = z.object({
  event: z.enum(['click', 'input', 'select', 'submit', 'navigation']),
  tag: z.string(),
  role: z.string().optional(),
  label: z.string().optional(),
  ariaLabel: z.string().optional(),
  innerText: z.string().optional(),
  placeholder: z.string().optional(),
  alt: z.string().optional(),
  title: z.string().optional(),
  name: z.string().optional(),
  inputType: z.string().optional(),
  autocomplete: z.string().optional(),
  optionLabel: z.string().optional(),
  selector: z.string().optional(),
  rect: rectSchema.optional(),
  url: z.string(),
  lowConfidence: z.boolean().optional(),
})

const v1EditsSchema = z.object({
  blur: z.array(rectSchema).default([]),
  crop: rectSchema.nullable().default(null),
  annotations: z.array(annotationSchema).default([]),
})

// Strip unknown legacy properties without reading or forwarding input values.
export const v1GuideSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    description: z
      .string()
      .nullish()
      .transform((value) => value ?? ''),
    source_url: z.string().nullable(),
    is_public: z.boolean(),
    public_id: z.string().uuid(),
    created_at: z.string(),
    updated_at: z.string(),
    steps: z
      .array(
        z.object({
          id: z.string().uuid(),
          guide_id: z.string().uuid(),
          position: z.number().int().nonnegative(),
          type: z.enum(['action', 'navigate', 'section', 'manual']),
          text: z.string().min(1),
          page_url: z.string().nullable(),
          screenshot_path: z.string().nullable(),
          rendered_path: z.string().nullable(),
          click: z
            .object({ x: z.number(), y: z.number(), radius: z.number() })
            .nullable(),
          element_meta: v1ElementMetaSchema.nullable(),
          edits: v1EditsSchema,
          created_at: z.string(),
        }),
      )
      .min(1)
      .max(500),
  })
  .superRefine((guide, ctx) => {
    const ids = new Set<string>()
    for (const [index, step] of guide.steps.entries()) {
      if (step.guide_id !== guide.id || ids.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['steps', index, 'id'],
          message: 'Step ownership or identity is invalid',
        })
      }
      ids.add(step.id)
    }
  })

export type V1Guide = z.output<typeof v1GuideSchema>
type V1Meta = z.output<typeof v1ElementMetaSchema>
export interface MigrationOptions {
  slug?: string
  /** Dimensions of each already-redacted, flattened image, supplied by the client. */
  screenshots?: Readonly<
    Record<string, { width: number; height: number; devicePixelRatio?: number }>
  >
}

function safePageUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return null
  }
}

function targetFromMeta(meta: V1Meta): Target {
  const name = [
    meta.label,
    meta.ariaLabel,
    meta.event === 'input' ? undefined : meta.innerText,
    meta.placeholder,
    meta.alt,
    meta.title,
    meta.name,
  ]
    .find((value) => value?.trim())
    ?.trim()
  let role = meta.role
  if (!role) {
    if (meta.tag === 'button') role = 'button'
    else if (meta.tag === 'a') role = 'link'
    else if (meta.tag === 'select') role = 'combobox'
    else if (meta.tag === 'textarea') role = 'textbox'
    else if (meta.tag === 'input') {
      role =
        meta.inputType === 'checkbox' || meta.inputType === 'radio'
          ? meta.inputType
          : ['submit', 'button', 'reset'].includes(meta.inputType ?? '')
            ? 'button'
            : meta.inputType === 'number'
              ? 'spinbutton'
              : meta.inputType === 'range'
                ? 'slider'
                : meta.inputType === 'search'
                  ? 'searchbox'
                  : meta.inputType === 'password'
                    ? undefined
                    : 'textbox'
    }
  }
  const locators: Locator[] = []
  if (role && name)
    locators.push({ strategy: 'role', value: role, name, exact: true })
  if (meta.label)
    locators.push({ strategy: 'label', value: meta.label, exact: true })
  if (meta.placeholder)
    locators.push({
      strategy: 'placeholder',
      value: meta.placeholder,
      exact: true,
    })
  // v1 selectors never needed a value attribute. Do not import one from unknown legacy data.
  if (meta.selector && !/\[\s*value\s*[*^$|~]?=/i.test(meta.selector)) {
    locators.push({ strategy: 'css', value: meta.selector, exact: true })
  }
  return {
    role,
    name,
    tag: meta.tag,
    locators,
    rect: meta.rect,
    frame: [],
    shadowPath: [],
  }
}

function actionFromStep(step: V1Guide['steps'][number]): StepInput['action'] {
  if (step.type === 'section' || step.type === 'manual') return undefined
  const meta = step.element_meta
  if (step.type === 'navigate' || meta?.event === 'navigation')
    return 'navigate'
  if (meta?.event === 'input') return 'fill'
  if (meta?.event === 'select') return 'select'
  if (meta?.event === 'submit') return 'press'
  if (meta?.event === 'click')
    return ['checkbox', 'radio'].includes(meta.inputType ?? '')
      ? 'check'
      : 'click'
  return undefined
}

/** Pure v1 row migration. It never opens images, reads field values or contacts a server. */
export function migrateV1ToGuide1(
  input: unknown,
  options: MigrationOptions = {},
): Guide {
  const source = v1GuideSchema.parse(input)
  const variables: Variable[] = []
  const steps = [...source.steps]
    .sort((a, b) => a.position - b.position)
    .map((step, index): StepInput => {
      const meta = step.element_meta
      const action = actionFromStep(step)
      const migrated: StepInput = {
        id: step.id,
        index: index + 1,
        type: step.type,
        title: step.text,
        action,
        url: safePageUrl(step.page_url ?? meta?.url),
        click: step.click,
        target: meta ? targetFromMeta(meta) : undefined,
        lowConfidence: meta?.lowConfidence ?? (step.type === 'action' && !meta),
        redactions: step.edits.blur.map((rect) => ({
          kind: 'custom',
          source: 'manual',
          rect,
          status: 'applied',
        })),
        edits: { crop: step.edits.crop, annotations: step.edits.annotations },
      }
      if (action === 'fill') {
        const kind =
          /^(password|email)$/i.test(meta?.inputType ?? '') ||
          /cc-|password|email|card|iban|payment/i.test(
            `${meta?.autocomplete ?? ''} ${meta?.name ?? ''} ${meta?.label ?? ''}`,
          )
            ? 'secret'
            : 'variable'
        const name = `field_${index + 1}`
        variables.push({
          name,
          kind,
          type: 'string',
          description: migrated.target?.name,
        })
        migrated.value = { kind, variable: name }
      } else if (action === 'select' && meta?.optionLabel !== undefined) {
        migrated.value = { kind: 'literal', literal: meta.optionLabel }
      } else if (action === 'press') migrated.key = 'Enter'

      const rendered = step.rendered_path ?? step.screenshot_path
      if (rendered) {
        const dimensions = options.screenshots?.[step.id]
        if (
          !dimensions ||
          !Number.isInteger(dimensions.width) ||
          dimensions.width < 1 ||
          !Number.isInteger(dimensions.height) ||
          dimensions.height < 1 ||
          (dimensions.devicePixelRatio !== undefined &&
            (!Number.isFinite(dimensions.devicePixelRatio) ||
              dimensions.devicePixelRatio <= 0))
        ) {
          throw new Error(
            'Migration requires real screenshot dimensions from the client',
          )
        }
        if (
          !step.rendered_path &&
          (step.edits.blur.length ||
            step.edits.crop ||
            step.edits.annotations.length)
        ) {
          throw new Error(
            'Migration requires a flattened screenshot for edited images',
          )
        }
        migrated.screenshot = {
          original: step.screenshot_path,
          rendered,
          ...dimensions,
          alt: migrated.target?.name
            ? `The ${migrated.target.name}${migrated.target.role ? ` ${migrated.target.role}` : ''}`
            : step.text,
        }
      } else if (step.edits.blur.length) {
        throw new Error(
          'Migration cannot apply redactions without a screenshot',
        )
      }
      return migrated
    })
  const sourceUrl =
    safePageUrl(source.source_url) ?? steps.find((step) => step.url)?.url
  const guide: GuideInput = {
    schema: GUIDE_SCHEMA_ID,
    id: options.slug ?? source.id.toLowerCase(),
    uuid: source.id,
    title: source.title,
    description: source.description,
    app: sourceUrl ? { origin: new URL(sourceUrl).origin } : undefined,
    variables,
    steps,
    version: 1,
    status: source.is_public ? 'published' : 'draft',
    createdAt: source.created_at,
    updatedAt: source.updated_at,
    capturedAt: source.created_at,
    verification: { status: 'never-run' },
    publish: {
      publicId: source.public_id,
      isPublic: source.is_public,
      targets: source.is_public ? ['link'] : [],
    },
  }
  return guideSchema.parse(guide)
}

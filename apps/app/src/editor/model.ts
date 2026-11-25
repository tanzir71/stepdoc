import {
  guideSchema,
  type Guide,
  type Step,
  type Locator,
} from '@stepdoc/schema'

export type EditorMode = 'edit' | 'preview' | 'agent'
export type InspectorPanel = 'step' | 'target' | 'redact' | 'history'
export const actions = [
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
] as const
export const strategies: Locator['strategy'][] = [
  'role',
  'testId',
  'label',
  'placeholder',
  'text',
  'altText',
  'title',
  'css',
  'xpath',
]
export function editorRoute(search: string) {
  const p = new URLSearchParams(search)
  const raw = Number(p.get('step') ?? 1)
  return {
    step: Number.isSafeInteger(raw) && raw > 0 ? raw : 1,
    mode: (['preview', 'agent'].includes(p.get('view') ?? '')
      ? p.get('view')
      : 'edit') as EditorMode,
    panel: (['step', 'redact', 'history'].includes(p.get('panel') ?? '')
      ? p.get('panel')
      : 'target') as InspectorPanel,
    q: p.get('q')?.slice(0, 200) ?? '',
  }
}
export function editorUrl(
  id: string,
  search: string,
  changes: Readonly<Record<string, string | null>>,
  page: 'edit' | 'export' = 'edit',
) {
  const p = new URLSearchParams(search)
  for (const [key, value] of Object.entries(changes)) {
    if (
      !value ||
      (key === 'view' && value === 'edit') ||
      (key === 'panel' && value === 'target')
    )
      p.delete(key)
    else p.set(key, value)
  }
  p.sort()
  return `/g/${id}/${page}${p.size ? `?${p}` : ''}`
}
export function reindex(guide: Guide) {
  guide.steps.forEach((step, index) => (step.index = index + 1))
  return guide
}
export function addStep(
  guide: Guide,
  after: string,
  type: Step['type'],
  title: string,
) {
  if (guide.steps.length >= 500) throw new Error('step_limit')
  const index = guide.steps.findIndex((step) => step.id === after)
  const step: Step = {
    id: `step-${crypto.randomUUID()}`,
    index: 1,
    type,
    title: title.trim() || 'New instruction',
    description: '',
    redactions: [],
    lowConfidence: type === 'action',
    ...(type === 'action'
      ? { action: 'click' }
      : type === 'navigate'
        ? { action: 'navigate' }
        : type === 'assert'
          ? { action: 'assert' }
          : {}),
  }
  guide.steps.splice(index + 1, 0, step)
  reindex(guide)
  return step.id
}
export function moveStep(guide: Guide, id: string, delta: -1 | 1) {
  const index = guide.steps.findIndex((step) => step.id === id)
  const next = index + delta
  if (index < 0 || next < 0 || next >= guide.steps.length) return
  const [step] = guide.steps.splice(index, 1)
  guide.steps.splice(next, 0, step!)
  reindex(guide)
}
export function moveBefore(guide: Guide, id: string, target: string) {
  if (id === target || !guide.steps.some((step) => step.id === target)) return
  const index = guide.steps.findIndex((step) => step.id === id)
  if (index < 0) return
  const [step] = guide.steps.splice(index, 1)
  guide.steps.splice(
    guide.steps.findIndex((item) => item.id === target),
    0,
    step!,
  )
  reindex(guide)
}
export function removeStep(guide: Guide, id: string) {
  if (guide.steps.length === 1) throw new Error('last_step')
  guide.steps = guide.steps.filter((step) => step.id !== id)
  reindex(guide)
}
export function safePageUrl(text: string, origin?: string): string | null {
  if (!text.trim()) return null
  try {
    const url = new URL(text, origin)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    url.username = url.password = url.search = url.hash = ''
    return url.href
  } catch {
    return null
  }
}
export function changeAction(
  guide: Guide,
  id: string,
  action: NonNullable<Step['action']>,
) {
  const step = guide.steps.find((step) => step.id === id)!
  step.lowConfidence = true
  step.type =
    action === 'navigate'
      ? 'navigate'
      : action === 'assert'
        ? 'assert'
        : 'action'
  step.action = action
  if (['fill', 'upload'].includes(action)) {
    if (step.value?.kind !== 'variable' && step.value?.kind !== 'secret') {
      let n = 1
      while (guide.variables.some((v) => v.name === `input_${n}`)) n++
      const variable = {
        name: `input_${n}`,
        kind: 'secret' as const,
        type: 'string' as const,
      }
      guide.variables.push(variable)
      step.value = { kind: 'secret', variable: variable.name }
    }
  } else if (action === 'select')
    step.value = {
      kind: 'literal',
      literal: step.value?.kind === 'literal' ? step.value.literal : '',
    }
  else if (action === 'press') {
    step.value = { kind: 'none' }
    step.key = step.key || 'Enter'
  } else step.value = { kind: 'none' }
  if (action !== 'press') delete step.key
}
export function changeStepType(guide: Guide, id: string, type: Step['type']) {
  const step = guide.steps.find((step) => step.id === id)!
  if (type === 'manual' || type === 'section') {
    step.type = type
    delete step.action
    delete step.value
    delete step.key
    return
  }
  changeAction(
    guide,
    id,
    type === 'navigate'
      ? 'navigate'
      : type === 'assert'
        ? 'assert'
        : step.action && step.action !== 'navigate' && step.action !== 'assert'
          ? step.action
          : 'click',
  )
}
export function updateTarget(
  step: Step,
  field: 'role' | 'name',
  value: string,
) {
  const before = step.target
  step.target = {
    ...before,
    [field]: value || undefined,
    locators: before?.locators?.map((locator) =>
      locator.strategy === 'role' &&
      locator.value === before.role &&
      locator.name === before.name
        ? {
            ...locator,
            value: field === 'role' ? value : locator.value,
            name: field === 'name' ? value : locator.name,
            unique: undefined,
          }
        : { ...locator, unique: undefined },
    ),
  }
  step.lowConfidence = true
}
export function layerAtPoint(
  step: Step,
  x: number,
  y: number,
  padding = 8,
): string | null {
  if (
    step.click?.x !== undefined &&
    step.click.y !== undefined &&
    Math.hypot(x - step.click.x, y - step.click.y) <=
      step.click.radius + padding
  )
    return 'click'
  const hit = (rect: { x: number; y: number; width: number; height: number }) =>
    x >= rect.x - padding &&
    x <= rect.x + rect.width + padding &&
    y >= rect.y - padding &&
    y <= rect.y + rect.height + padding
  for (
    let index = (step.edits?.annotations?.length ?? 0) - 1;
    index >= 0;
    index--
  ) {
    const a = step.edits!.annotations![index]!
    if (
      (a.type === 'rectangle' &&
        hit({ x: a.x, y: a.y, width: a.width ?? 0, height: a.height ?? 0 })) ||
      (a.type === 'text' &&
        hit({
          x: a.x,
          y: a.y - 16,
          width: (a.text?.length ?? 1) * 10,
          height: 20,
        })) ||
      (a.type === 'pin' && Math.hypot(x - a.x, y - a.y) <= 12 + padding)
    )
      return `annotation-${index}`
    if (a.type === 'arrow') {
      const dx = a.toX! - a.x,
        dy = a.toY! - a.y,
        length = dx * dx + dy * dy,
        t = length
          ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length))
          : 0
      if (Math.hypot(x - a.x - t * dx, y - a.y - t * dy) <= padding)
        return `annotation-${index}`
    }
  }
  for (let index = step.redactions.length - 1; index >= 0; index--)
    if (hit(step.redactions[index]!.rect)) return `redaction-${index}`
  return null
}
export function translateLayer(step: Step, id: string, dx: number, dy: number) {
  const index = Number(id.split('-')[1])
  const item =
    id === 'click'
      ? step.click
      : id === 'crop'
        ? step.edits?.crop
        : id.startsWith('annotation-')
          ? step.edits?.annotations?.[index]
          : step.redactions[index]?.rect
  if (!item) return
  const x = Math.max(0, (item.x ?? 0) + dx),
    y = Math.max(0, (item.y ?? 0) + dy)
  if ('type' in item && item.type === 'arrow') {
    item.toX = Math.max(0, item.toX! + x - item.x)
    item.toY = Math.max(0, item.toY! + y - item.y)
  }
  item.x = x
  item.y = y
}
export function visualKey(step: Step) {
  return JSON.stringify([
    step.screenshot?.original ?? step.screenshot?.rendered,
    step.edits ?? null,
    step.click ?? null,
    step.redactions,
  ])
}
export function validDraft(input: Guide): Guide {
  const guide = guideSchema.parse(input)
  const names = new Map(guide.variables.map((v) => [v.name, v.kind]))
  if (
    names.size !== guide.variables.length ||
    new Set(guide.steps.map((s) => s.id)).size !== guide.steps.length
  )
    throw new Error('invalid_guide')
  for (const step of guide.steps)
    if (
      (step.value?.kind === 'secret' || step.value?.kind === 'variable') &&
      names.get(step.value.variable) !== step.value.kind
    )
      throw new Error('invalid_guide')
  return reindex(guide)
}

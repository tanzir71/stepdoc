import { guideSchema, stepSchema, type Guide, type Step } from '@stepdoc/schema'
import {
  reviewEditSchema,
  type ReviewEdit,
  type CapturePreferences,
  type CaptureClock,
} from '@stepdoc/schema/capture'
export {
  capturePreferencesSchema,
  reviewEditSchema,
} from '@stepdoc/schema/capture'
import {
  IndexedDbAdapter,
  StorageError,
  type BlobUpload,
} from '@stepdoc/storage'
import { flattenImage } from '@stepdoc/core/canvas'
import { captureUrl } from '@stepdoc/core/capture'

// Private extension state. Existing guide@1 fields carry the completed capture.
export type CapturePhase =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'pausing'
  | 'paused'
  | 'stopping'
  | 'review'
  | 'saving'
export interface ReviewState {
  phase?: CapturePhase
  title?: string
  revision?: number
  preferences?: CapturePreferences
  startedAt?: string
  clock?: CaptureClock
  savedId?: string
}
export interface CaptureDraft {
  sessionId: string
  startedUrl: string
  startedAt: string
  title: string
  steps: Step[]
  images: ReadonlyArray<{ screenshot: string }>
}
export function suggestedTitle(url: string): string {
  // Never read a page title, which can include typed or account-specific values.
  return `Workflow on ${new URL(url).hostname}`.slice(0, 200)
}
export function editReview<T extends { screenshot: string }>(
  steps: Step[],
  images: T[],
  input: ReviewEdit,
) {
  const edit = reviewEditSchema.parse(input)
  if (images.length !== steps.length) throw new Error('Incomplete capture')
  const rows = steps.map((step, index) => ({
    step: stepSchema.parse(step),
    image: images[index]!,
  }))
  if (edit.operation === 'delete' || edit.operation === 'merge') {
    const selected = new Set(edit.ids)
    if (
      selected.size !== edit.ids.length ||
      edit.ids.some((id) => !rows.some((row) => row.step.id === id))
    )
      throw new Error('Unknown step')
    if (edit.operation === 'merge') {
      const positions = rows.flatMap((row, i) =>
        selected.has(row.step.id) ? [i] : [],
      )
      if (positions.some((position, i) => position !== positions[0]! + i))
        throw new Error('Select adjacent steps')
      const first = rows[positions[0]!]!
      const combined = rows.filter((row) => selected.has(row.step.id))
      first.step = stepSchema.parse({
        id: first.step.id,
        index: first.step.index,
        type: 'manual',
        title: combined.map(({ step }) => step.title).join('; '),
        description: combined
          .map(
            ({ step }, i) =>
              `${i + 1}. ${step.title}${step.description ? `\n${step.description}` : ''}`,
          )
          .join('\n'),
        notes: combined
          .map(({ step }) => step.notes ?? '')
          .filter(Boolean)
          .join('\n'),
        screenshot: first.step.screenshot,
        redactions: first.step.redactions,
        url: first.step.url,
        lowConfidence: true,
      })
      for (let i = rows.length - 1; i >= 0; i--)
        if (selected.has(rows[i]!.step.id) && rows[i] !== first)
          rows.splice(i, 1)
    } else {
      for (let i = rows.length - 1; i >= 0; i--)
        if (selected.has(rows[i]!.step.id)) rows.splice(i, 1)
    }
  } else if (edit.operation === 'move') {
    const at = rows.findIndex((row) => row.step.id === edit.id)
    if (at < 0) throw new Error('Unknown step')
    const to = at + (edit.direction === 'up' ? -1 : 1)
    if (to >= 0 && to < rows.length)
      [rows[at], rows[to]] = [rows[to]!, rows[at]!]
  }
  return {
    steps: rows.map(({ step }, index) => ({ ...step, index: index + 1 })),
    images: rows.map(({ image }) => image),
  }
}
export function capturedGuide(draft: CaptureDraft): Guide {
  const variables = new Map<
    string,
    { name: string; kind: 'variable' | 'secret' }
  >()
  for (const step of draft.steps)
    if (step.value?.kind === 'variable' || step.value?.kind === 'secret')
      variables.set(step.value.variable, {
        name: step.value.variable,
        kind: step.value.kind,
      })
  return guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id: `capture-${draft.sessionId}`,
    uuid: draft.sessionId,
    title: draft.title,
    app: { origin: new URL(draft.startedUrl).origin },
    variables: [...variables.values()],
    preconditions: [`Open ${captureUrl(draft.startedUrl)}`],
    steps: draft.steps,
    version: 1,
    createdAt: draft.startedAt,
    updatedAt: draft.startedAt,
    capturedAt: draft.startedAt,
    verification: { status: 'never-run' },
  })
}
export async function saveCapture(draft: CaptureDraft): Promise<Guide> {
  if (draft.steps.length !== draft.images.length)
    throw new Error('Incomplete capture')
  const storage = await IndexedDbAdapter.open()
  try {
    const guide = capturedGuide(draft)
    try {
      // A worker can end after the atomic commit but before acknowledging it.
      // Retrying opens the same guide, including subsequent editor changes.
      const existing = await storage.getGuide(guide.id)
      if (existing.uuid !== draft.sessionId)
        throw new Error('Capture identity conflict')
      return existing
    } catch (error) {
      if (!(error instanceof StorageError && error.code === 'not_found'))
        throw error
    }
    const uploads: BlobUpload[] = []
    for (const [index, step] of guide.steps.entries()) {
      const data = draft.images[index]!.screenshot
      if (!/^data:image\/(png|webp);base64,/i.test(data))
        throw new Error('Invalid processed image')
      const original = await (await fetch(data)).blob()
      // Source pixels were already redacted before entering extension storage.
      // Rendering adds the click marker without retaining an unredacted copy.
      const rendered = await flattenImage(original, { click: step.click })
      step.screenshot = {
        original: null,
        rendered: '',
        width: rendered.width,
        height: rendered.height,
        devicePixelRatio: step.screenshot?.devicePixelRatio ?? 1,
        alt: step.title,
      }
      uploads.push(
        { file: original, stepId: step.id, kind: 'original' },
        { file: rendered.blob, stepId: step.id, kind: 'rendered' },
      )
    }
    return await storage.createGuideWithBlobs(guide, uploads)
  } finally {
    storage.close()
  }
}

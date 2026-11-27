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
  MAX_BLOB_BYTES,
} from '@stepdoc/storage'
import { flattenImage } from '@stepdoc/core/canvas'
import { captureUrl } from '@stepdoc/core/capture'
import type {
  CaptureDestination,
  CaptureReceipt,
  CaptureDestinationErrorCode,
  ServerDestination,
} from '@stepdoc/schema/capture-destination'
import {
  captureImageBlob,
  MAX_API_JSON_BYTES,
  MAX_CAPTURE_INLINE_BYTES,
  type CaptureImageProvider,
} from '@stepdoc/storage/http'

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
  destination?: CaptureDestination
  remoteAttempt?: ServerDestination
  remoteSaved?: CaptureReceipt
  saveError?: CaptureDestinationErrorCode
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

async function captureDataUrl(file: Blob): Promise<string> {
  const prefix = `data:${file.type};base64,`
  if (prefix.length + Math.ceil(file.size / 3) * 4 > MAX_CAPTURE_INLINE_BYTES)
    throw new StorageError('upload_too_large')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const chunks: string[] = []
  for (let at = 0; at < bytes.length; at += 0x8000)
    chunks.push(String.fromCharCode(...bytes.subarray(at, at + 0x8000)))
  return prefix + btoa(chunks.join(''))
}

/** Retain metadata plus a sequential provider, without another capture-sized JSON allocation. */
export function captureUploadSource(draft: CaptureDraft): {
  guide: Guide
  images: CaptureImageProvider
} {
  if (draft.steps.length !== draft.images.length)
    throw new StorageError('invalid_guide')
  let guide: Guide
  try {
    guide = capturedGuide(draft)
  } catch {
    throw new StorageError('invalid_guide')
  }
  if (
    guide.steps.some((step) =>
      step.redactions.some((item) => item.status === 'open'),
    )
  )
    throw new StorageError('redaction_open')
  const sources = draft.images.map((image) => image.screenshot)
  for (const step of guide.steps)
    step.screenshot = {
      original: null,
      rendered: '',
      width: step.screenshot?.width ?? 1,
      height: step.screenshot?.height ?? 1,
      devicePixelRatio: step.screenshot?.devicePixelRatio ?? 1,
      alt: step.title,
    }
  return {
    guide,
    images: async (step, index) => {
      if (guide.steps[index]?.id !== step.id)
        throw new StorageError('invalid_guide')
      try {
        const original = await captureImageBlob(
          sources[index]!,
          MAX_BLOB_BYTES,
          true,
        )
        const rendered = await flattenImage(original, { click: step.click })
        return {
          original,
          rendered: rendered.blob,
          width: rendered.width,
          height: rendered.height,
          devicePixelRatio: step.screenshot?.devicePixelRatio ?? 1,
        }
      } catch (error) {
        if (error instanceof StorageError) throw error
        throw new StorageError('invalid_blob')
      }
    },
  }
}

/** Compatibility helper for servers with the existing bounded inline path. */
export async function captureUploadGuide(draft: CaptureDraft): Promise<Guide> {
  if (draft.steps.length !== draft.images.length)
    throw new StorageError('invalid_guide')
  let guide: Guide
  try {
    guide = capturedGuide(draft)
  } catch {
    throw new StorageError('invalid_guide')
  }
  const images = draft.images.map((image) => image.screenshot)
  if (
    guide.steps.some((step) =>
      step.redactions.some((item) => item.status === 'open'),
    )
  )
    throw new StorageError('redaction_open')
  let imageBytes = 0
  for (const [index, step] of guide.steps.entries()) {
    try {
      const source = images[index]!
      imageBytes += source.length
      if (imageBytes > MAX_API_JSON_BYTES)
        throw new StorageError('upload_too_large')
      const original = await captureImageBlob(source)
      // The stored source has mandatory masks already applied; the second
      // image adds its click marker. Neither image is processed by a server.
      const rendered = await flattenImage(original, { click: step.click })
      const flattened = await captureDataUrl(rendered.blob)
      imageBytes += flattened.length
      if (imageBytes > MAX_API_JSON_BYTES)
        throw new StorageError('upload_too_large')
      step.screenshot = {
        original: source,
        rendered: flattened,
        width: rendered.width,
        height: rendered.height,
        devicePixelRatio: step.screenshot?.devicePixelRatio ?? 1,
        alt: step.title,
      }
    } catch (error) {
      if (error instanceof StorageError) throw error
      throw new StorageError('invalid_blob')
    }
  }
  return guide
}

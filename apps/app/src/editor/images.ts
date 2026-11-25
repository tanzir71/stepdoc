import type { Guide, Step } from '@stepdoc/schema'
import type { StorageAdapter } from '@stepdoc/storage'
import type { FlattenOptions, PreparedCapture } from '@stepdoc/core/canvas'
import { visualKey } from './model'

export const editorFont = new URL(
  '../../../../packages/ui/assets/fonts/GeistSans.woff2',
  import.meta.url,
).href
export class ImageProcessor {
  private sequence = 0
  private pending = new Map<
    number,
    { resolve: (capture: PreparedCapture) => void; reject: () => void }
  >()
  private worker: Worker | undefined
  private closed = false
  private start() {
    const worker = new Worker(new URL('./image.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (
      event: MessageEvent<{
        id: number
        result?: PreparedCapture
        error?: string
      }>,
    ) => {
      const pending = this.pending.get(event.data.id)
      if (!pending) return
      this.pending.delete(event.data.id)
      if (event.data.result) pending.resolve(event.data.result)
      else pending.reject()
    }
    worker.onerror = () => this.reset()
    this.worker = worker
    return worker
  }
  process(file: Blob, options: FlattenOptions = {}) {
    return new Promise<PreparedCapture>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('image_failed'))
        return
      }
      const id = ++this.sequence
      this.pending.set(id, {
        resolve,
        reject: () => reject(new Error('image_failed')),
      })
      try {
        ;(this.worker ?? this.start()).postMessage({
          id,
          file,
          options,
          font: editorFont,
        })
      } catch {
        this.reset()
      }
    })
  }
  private reset() {
    this.worker?.terminate()
    this.worker = undefined
    for (const entry of this.pending.values()) entry.reject()
    this.pending.clear()
  }
  close() {
    this.closed = true
    this.reset()
  }
}
export function imageOptions(step: Step): FlattenOptions {
  return {
    format: 'image/png',
    edits: step.edits,
    click: step.click,
    redactions: step.redactions
      .filter((item) => item.status !== 'kept')
      .map((item) => item.rect),
  }
}
export async function materializeImages(
  adapter: StorageAdapter,
  processor: ImageProcessor,
  draft: Guide,
  saved: Guide,
  force: ReadonlySet<string> = new Set(),
): Promise<Guide> {
  const result = structuredClone(draft)
  for (const step of result.steps) {
    const before = saved.steps.find((item) => item.id === step.id)
    if (!step.screenshot) continue
    if (
      !force.has(step.id) &&
      before?.screenshot &&
      visualKey(before) === visualKey(step)
    ) {
      step.screenshot = { ...before.screenshot, alt: step.screenshot.alt }
      continue
    }
    if (!step.screenshot.original) throw new Error('source_missing')
    const image = await processor.process(
      await adapter.getBlob(step.screenshot.original),
      imageOptions(step),
    )
    const masked = await adapter.putBlob(result.id, {
      file: image.original.blob,
      stepId: step.id,
      kind: 'original',
    })
    const rendered = await adapter.putBlob(result.id, {
      file: image.rendered.blob,
      stepId: step.id,
      kind: 'rendered',
    })
    step.screenshot = {
      ...step.screenshot,
      original: masked.key,
      rendered: rendered.key,
      width: image.rendered.width,
      height: image.rendered.height,
    }
  }
  return result
}

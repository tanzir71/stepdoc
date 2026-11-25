import type { Guide } from '@stepdoc/schema'
import type { StorageAdapter } from '@stepdoc/storage'
import {
  ARCHIVE_LIMITS,
  ArchiveError,
  type GuideAssets,
  type StepAssets,
} from '@stepdoc/core/export/archive'
import { ImageProcessor, imageOptions } from '../editor/images'
import { newId } from '../model'
import type { ExportFormat } from './model'
import ExportWorker from './worker?worker'
import sans from '../../../../packages/ui/assets/fonts/GeistSans.woff2?url'
import mono from '../../../../packages/ui/assets/fonts/GeistMono.woff2?url'
import type {
  ExportRequest,
  ExportResult,
  ParsedBundle,
  DownloadFile,
} from './worker'

export type { ExportResult, ParsedBundle }
const fontUrls = { sans, mono }
let fontData: Promise<{ sans: string; mono: string }> | undefined
function fonts() {
  return (fontData ??= Promise.all(
    Object.values(fontUrls).map(async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error('font_failed')
      const data = new Uint8Array(await response.arrayBuffer())
      let binary = ''
      for (let at = 0; at < data.length; at += 8192)
        binary += String.fromCharCode(...data.subarray(at, at + 8192))
      return `data:font/woff2;base64,${btoa(binary)}`
    }),
  )
    .then(([sans, mono]) => ({ sans: sans!, mono: mono! }))
    .catch(() => {
      fontData = undefined
      throw new Error('font_failed')
    }))
}
function runWorker<T>(
  request: ExportRequest,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new ExportWorker()
    const close = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
    }
    const abort = () => {
      close()
      reject(new Error('export_cancelled'))
    }
    const timer = setTimeout(() => {
      close()
      reject(new Error('export_timeout'))
    }, 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    worker.onmessage = (
      event: MessageEvent<{ result?: T; error?: string }>,
    ) => {
      close()
      if (event.data.result) resolve(event.data.result)
      else reject(new Error('export_failed'))
    }
    worker.onerror = () => {
      close()
      reject(new Error('export_failed'))
    }
    const transfer: ArrayBuffer[] =
      request.type === 'parse'
        ? [request.bytes.buffer as ArrayBuffer]
        : (Object.values(request.assets).flatMap((asset) => [
            asset.rendered.data.buffer,
            ...(asset.original ? [asset.original.data.buffer] : []),
          ]) as ArrayBuffer[])
    try {
      worker.postMessage(request, [...new Set(transfer)])
    } catch {
      close()
      reject(new Error('export_failed'))
    }
  })
}
function flattenedOptions(step: Guide['steps'][number]) {
  // An imported JSON document can have only its already-flattened render. Do not
  // reapply annotations/clicks; translate any review masks into the cropped view.
  const crop = step.edits?.crop
  const x = Math.max(0, Math.floor(crop?.x ?? 0)),
    y = Math.max(0, Math.floor(crop?.y ?? 0))
  return {
    format: 'image/png' as const,
    redactions: step.redactions
      .filter((item) => item.status !== 'kept')
      .map((item) => ({
        ...item.rect,
        x: item.rect.x - x,
        y: item.rect.y - y,
      })),
  }
}
async function collectAssets(
  adapter: StorageAdapter,
  input: Guide,
  originals: boolean,
  signal?: AbortSignal,
) {
  const guide = structuredClone(input),
    processor = new ImageProcessor()
  const assets: Record<string, StepAssets> = Object.create(null)
  let bytes = 0
  const abort = () => processor.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (const step of guide.steps)
      if (step.screenshot) {
        if (signal?.aborted) throw new Error('export_cancelled')
        const hasSource = !!step.screenshot.original
        const file = await adapter.getBlob(
          step.screenshot.original ?? step.screenshot.rendered,
        )
        const capture = await processor.process(
          file,
          hasSource ? imageOptions(step) : flattenedOptions(step),
        )
        step.screenshot.width = capture.rendered.width
        step.screenshot.height = capture.rendered.height
        const rendered = {
          mime: 'image/png' as const,
          data: new Uint8Array(await capture.rendered.blob.arrayBuffer()),
        }
        const original =
          originals && hasSource
            ? {
                mime: 'image/png' as const,
                data: new Uint8Array(await capture.original.blob.arrayBuffer()),
              }
            : undefined
        bytes += rendered.data.length + (original?.data.length ?? 0)
        if (bytes > ARCHIVE_LIMITS.bytes)
          throw new ArchiveError('archive_limit')
        assets[step.id] = { rendered, ...(original ? { original } : {}) }
      }
    return { guide, assets }
  } finally {
    signal?.removeEventListener('abort', abort)
    processor.close()
  }
}
export async function prepareDownload(
  adapter: StorageAdapter,
  guide: Guide,
  formats: readonly ExportFormat[],
  signal?: AbortSignal,
): Promise<ExportResult> {
  const needsImages = formats.some(
    (format) => !['json', 'playwright'].includes(format),
  )
  const captures = needsImages
    ? await collectAssets(adapter, guide, formats.includes('bundle'), signal)
    : { guide: structuredClone(guide), assets: {} }
  const localFonts = formats.some(
    (format) => format === 'pdf' || format === 'html',
  )
    ? await fonts()
    : undefined
  return runWorker<ExportResult>(
    { type: 'build', ...captures, formats, fonts: localFonts },
    signal,
  )
}
export async function parseBundle(
  file: Blob,
  signal?: AbortSignal,
): Promise<ParsedBundle> {
  if (file.size > ARCHIVE_LIMITS.bytes) throw new ArchiveError('archive_limit')
  return runWorker<ParsedBundle>(
    { type: 'parse', bytes: new Uint8Array(await file.arrayBuffer()) },
    signal,
  )
}
export async function saveBundle(
  adapter: StorageAdapter,
  bundle: ParsedBundle,
  copy = false,
  signal?: AbortSignal,
): Promise<Guide> {
  const guide = structuredClone(bundle.guide)
  if (copy) {
    guide.id = newId(guide.title)
    guide.uuid = crypto.randomUUID()
    if (guide.publish) guide.publish = { isPublic: false, targets: [] }
  }
  const processor = new ImageProcessor()
  const abort = () => processor.close()
  signal?.addEventListener('abort', abort, { once: true })
  const check = () => {
    if (signal?.aborted) throw new Error('import_cancelled')
  }
  const prepared = new Map<
    string,
    Awaited<ReturnType<ImageProcessor['process']>>
  >()
  try {
    // Validate/decode and redact every source before creating any native record.
    for (const step of guide.steps)
      if (step.screenshot) {
        check()
        const assets = bundle.assets[step.id]!,
          source = assets.original ?? assets.rendered
        prepared.set(
          step.id,
          await processor.process(
            new Blob([new Uint8Array(source.data)], { type: source.mime }),
            assets.original ? imageOptions(step) : flattenedOptions(step),
          ),
        )
      }
    check()
    let stored = await adapter.createGuide({
      ...guide,
      steps: guide.steps.map((step) => ({ ...step, screenshot: undefined })),
    })
    try {
      check()
      for (const step of guide.steps)
        if (step.screenshot) {
          const capture = prepared.get(step.id)!
          const original = bundle.assets[step.id]!.original
            ? (
                await adapter.putBlob(stored.id, {
                  file: capture.original.blob,
                  kind: 'original',
                  stepId: step.id,
                })
              ).key
            : null
          const rendered = (
            await adapter.putBlob(stored.id, {
              file: capture.rendered.blob,
              kind: 'rendered',
              stepId: step.id,
            })
          ).key
          check()
          stored.steps.find((item) => item.id === step.id)!.screenshot = {
            ...step.screenshot,
            original,
            rendered,
            width: capture.rendered.width,
            height: capture.rendered.height,
          }
        }
      stored = await adapter.saveGuide(stored, stored.version)
      check()
      return stored
    } catch (error) {
      await adapter.deleteGuide(stored.id).catch(() => {})
      throw error
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    processor.close()
  }
}
export function download(file: DownloadFile) {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
export async function printDocument(html: string, signal?: AbortSignal) {
  const frame = document.createElement('iframe')
  frame.title = 'Printable guide'
  frame.className = 'export-print-frame'
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals')
  frame.srcdoc = html
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      frame.onload = null
    }
    const abort = () => {
      cleanup()
      frame.remove()
      reject(new Error('export_cancelled'))
    }
    const timer = setTimeout(() => {
      cleanup()
      frame.remove()
      reject(new Error('print_failed'))
    }, 30_000)
    frame.onload = () => {
      cleanup()
      resolve()
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    document.body.append(frame)
  })
  try {
    if (signal?.aborted) return
    const doc = frame.contentDocument,
      view = frame.contentWindow
    if (!doc || !view) throw new Error('print_failed')
    await doc.fonts.ready
    await Promise.all(Array.from(doc.images, (image) => image.decode()))
    if (!signal?.aborted) {
      view.addEventListener('afterprint', () => frame.remove(), { once: true })
      view.focus()
      view.print()
    }
  } finally {
    if (frame.isConnected) setTimeout(() => frame.remove(), 60_000)
  }
}

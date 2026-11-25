/// <reference lib="webworker" />
import type { Guide } from '@stepdoc/schema'
import {
  ArchiveError,
  exportBundle,
  importBundle,
  portableAssets,
  zipFiles,
  type GuideAssets,
} from '@stepdoc/core/export/archive'
import { exportGuideJson } from '@stepdoc/core/export/json'
import { exportMarkdown } from '@stepdoc/core/export/markdown'
import { exportHtml } from '@stepdoc/core/export/html'
import { exportPlaywright } from '@stepdoc/core/export/playwright'
import { exportSkill } from '@stepdoc/core/export/skill'
import type { ExportFormat } from './model'

declare const self: DedicatedWorkerGlobalScope
export type ExportRequest =
  | { type: 'parse'; bytes: Uint8Array }
  | {
      type: 'build'
      guide: Guide
      assets: GuideAssets
      formats: readonly ExportFormat[]
      fonts?: { sans: string; mono: string }
    }
export interface DownloadFile {
  name: string
  mime: string
  bytes: Uint8Array
}
export interface ExportResult {
  file?: DownloadFile
  printHtml?: string
  clipboardHtml?: string
}
export type ParsedBundle = Awaited<ReturnType<typeof importBundle>>
const encode = (value: string) => new TextEncoder().encode(value)
const dataUrl = (mime: string, bytes: Uint8Array) => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 8192)
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192))
  return `data:${mime};base64,${btoa(binary)}`
}
export async function buildExport(
  request: Extract<ExportRequest, { type: 'build' }>,
): Promise<ExportResult> {
  const { guide, assets, formats, fonts } = request
  const needsImages = formats.some(
    (format) => !['json', 'playwright'].includes(format),
  )
  const { paths, files: images } = needsImages
    ? portableAssets(guide, assets)
    : { paths: {}, files: {} }
  const options = { images: paths }
  const files: Record<string, Uint8Array> = Object.create(null)
  const types: Record<string, string> = Object.create(null)
  const add = (name: string, mime: string, value: string | Uint8Array) => {
    files[name] = typeof value === 'string' ? encode(value) : value
    types[name] = mime
  }
  const embedded: Record<string, string> = Object.create(null)
  let printHtml: string | undefined
  let clipboardHtml: string | undefined
  if (formats.includes('html') || formats.includes('pdf')) {
    if (!fonts) throw new Error('fonts_missing')
    for (const step of guide.steps)
      if (step.screenshot) {
        const asset = assets[step.id]!.rendered
        embedded[step.id] = dataUrl(asset.mime, asset.data)
      }
    if (formats.includes('html')) {
      clipboardHtml = exportHtml(guide, {
        images: embedded,
        fonts,
        standalone: true,
      })
      add('guide.html', 'text/html;charset=utf-8', clipboardHtml)
    }
    if (formats.includes('pdf'))
      printHtml = exportHtml(guide, {
        images: embedded,
        fonts,
        print: true,
        standalone: true,
      })
  }
  if (formats.includes('markdown'))
    add(
      'guide.md',
      'text/markdown;charset=utf-8',
      exportMarkdown(guide, options),
    )
  if (formats.includes('json') || formats.includes('skill'))
    add('guide.json', 'application/json', exportGuideJson(guide, options))
  if (formats.includes('playwright') || formats.includes('skill'))
    add(
      'replay.spec.ts',
      'text/plain;charset=utf-8',
      exportPlaywright(guide, options),
    )
  if (formats.includes('skill'))
    add('SKILL.md', 'text/markdown;charset=utf-8', exportSkill(guide, options))
  if (formats.includes('bundle'))
    add(
      `${guide.id}.stepdoc`,
      'application/vnd.stepdoc+zip',
      await exportBundle(guide, assets),
    )
  if (formats.includes('docx')) {
    const { exportDocx } = await import('@stepdoc/core/export/docx')
    add(
      'guide.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      await exportDocx(guide, assets),
    )
  }
  if (formats.some((format) => ['markdown', 'json', 'skill'].includes(format)))
    Object.assign(files, images)
  const entries = Object.entries(files)
  const file = !entries.length
    ? undefined
    : entries.length === 1
      ? {
          name: entries[0]![0],
          mime: types[entries[0]![0]]!,
          bytes: entries[0]![1],
        }
      : {
          name: `${guide.id}-exports.zip`,
          mime: 'application/zip',
          bytes: zipFiles(files),
        }
  return { file, printHtml, clipboardHtml }
}
if (
  typeof self !== 'undefined' &&
  'postMessage' in self &&
  !('document' in self)
)
  self.onmessage = (event: MessageEvent<ExportRequest>) => {
    void (async () => {
      try {
        if (event.data.type === 'parse') {
          const result = await importBundle(event.data.bytes)
          const transfer = Object.values(result.assets).flatMap((asset) => [
            asset.rendered.data.buffer,
            ...(asset.original ? [asset.original.data.buffer] : []),
          ]) as ArrayBuffer[]
          self.postMessage({ result }, [...new Set(transfer)])
        } else {
          const result = await buildExport(event.data)
          self.postMessage(
            { result },
            result.file ? [result.file.bytes.buffer as ArrayBuffer] : [],
          )
        }
      } catch (error) {
        self.postMessage({
          error: error instanceof ArchiveError ? error.code : 'export_failed',
        })
      }
    })()
  }

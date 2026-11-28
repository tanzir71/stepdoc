import { Inflate, zipSync } from 'fflate'
import type { Guide, GuideInput } from '@stepdoc/schema'
import { prepareExport } from './common'
import { CANVAS_LIMITS } from '../canvas/geometry'

export const BUNDLE_FORMAT = 'stepdoc/bundle@1'
export const ARCHIVE_LIMITS = Object.freeze({
  bytes: 256 * 1024 * 1024,
  image: 64 * 1024 * 1024,
  metadata: 8 * 1024 * 1024,
  entries: 1002,
})
export class ArchiveError extends Error {
  constructor(
    public readonly code:
      | 'invalid_archive'
      | 'archive_limit'
      | 'invalid_image'
      | 'missing_image',
  ) {
    super(`Guide archive failed: ${code}`)
    this.name = 'ArchiveError'
  }
}
export interface RasterAsset {
  data: Uint8Array
  mime: 'image/png' | 'image/webp'
}
export interface StepAssets {
  rendered: RasterAsset
  /** Already redacted, full-size source. Used only by the private portable bundle. */
  original?: RasterAsset
}
export type GuideAssets = Readonly<Record<string, StepAssets>>
function fail(code: ArchiveError['code'] = 'invalid_archive'): never {
  throw new ArchiveError(code)
}
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })
const u16 = (view: DataView, at: number) => view.getUint16(at, true)
const u32 = (view: DataView, at: number) => view.getUint32(at, true)
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let n = index
  for (let bit = 0; bit < 8; bit++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('')
}
/** Signature/dimension inspection only. Native decoding and redaction stay in the client worker. */
export function rasterInfo(asset: RasterAsset) {
  if (!asset || !(asset.data instanceof Uint8Array)) fail('invalid_image')
  const { data, mime } = asset
  if (!data.length || data.length > ARCHIVE_LIMITS.image) fail('archive_limit')
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let width = 0,
    height = 0
  if (
    mime === 'image/png' &&
    data.length >= 33 &&
    v.getUint32(0) === 0x89504e47 &&
    v.getUint32(4) === 0x0d0a1a0a &&
    v.getUint32(8) === 13 &&
    v.getUint32(12) === 0x49484452
  ) {
    width = v.getUint32(16)
    height = v.getUint32(20)
  } else if (
    mime === 'image/webp' &&
    data.length >= 30 &&
    v.getUint32(0) === 0x52494646 &&
    u32(v, 4) + 8 === data.length &&
    v.getUint32(8) === 0x57454250
  ) {
    const chunk = v.getUint32(12)
    if (chunk === 0x56503858) {
      width = 1 + (data[24]! | (data[25]! << 8) | (data[26]! << 16))
      height = 1 + (data[27]! | (data[28]! << 8) | (data[29]! << 16))
    } else if (chunk === 0x5650384c && data[20] === 0x2f) {
      width = 1 + ((data[21]! | (data[22]! << 8)) & 0x3fff)
      height =
        1 + (((data[22]! >> 6) | (data[23]! << 2) | (data[24]! << 10)) & 0x3fff)
    } else if (
      chunk === 0x56503820 &&
      data[23] === 0x9d &&
      data[24] === 1 &&
      data[25] === 0x2a
    ) {
      width = u16(v, 26) & 0x3fff
      height = u16(v, 28) & 0x3fff
    }
  }
  if (
    !width ||
    !height ||
    width > CANVAS_LIMITS.maxEdge ||
    height > CANVAS_LIMITS.maxEdge ||
    width * height > CANVAS_LIMITS.maxPixels
  )
    fail('invalid_image')
  return { width, height }
}
export function portableAssets(
  input: GuideInput,
  assets: GuideAssets,
  originals = false,
) {
  const paths: Record<string, string> = Object.create(null)
  const files: Record<string, Uint8Array> = Object.create(null)
  const { guide } = prepareExport(input)
  for (const step of guide.steps)
    if (step.screenshot) {
      const source = Object.hasOwn(assets, step.id)
        ? assets[step.id]
        : undefined
      if (!source) fail('missing_image')
      const dims = rasterInfo(source.rendered)
      if (
        dims.width !== step.screenshot.width ||
        dims.height !== step.screenshot.height
      )
        fail('invalid_image')
      const path = `img/step-${step.index}.${source.rendered.mime === 'image/png' ? 'png' : 'webp'}`
      paths[step.id] = path
      files[path] = new Uint8Array(source.rendered.data)
      if (originals && source.original) {
        rasterInfo(source.original)
        const original = `img/step-${step.index}-original.${source.original.mime === 'image/png' ? 'png' : 'webp'}`
        files[original] = new Uint8Array(source.original.data)
        step.screenshot.original = original
      } else if (
        originals &&
        input.steps.find((s) => s.id === step.id)?.screenshot?.original
      ) {
        fail('missing_image')
      }
      step.screenshot.rendered = path
    }
  return { guide, paths, files }
}
export function zipFiles(files: Readonly<Record<string, Uint8Array>>) {
  const entries = Object.entries(files)
  for (const [path, data] of entries)
    if (
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path
        .split('/')
        .some(
          (part) =>
            !part || part === '.' || part === '..' || part === '__proto__',
        ) ||
      /[\u0000-\u001f\u007f:]/.test(path) ||
      !(data instanceof Uint8Array)
    )
      fail()
  if (
    !entries.length ||
    entries.length > ARCHIVE_LIMITS.entries ||
    entries.reduce((sum, [, data]) => sum + data.length, 0) >
      ARCHIVE_LIMITS.bytes
  )
    fail('archive_limit')
  // Raster images are already compressed. STORE avoids recompressing large captures.
  const result = zipSync(Object.fromEntries(entries), {
    level: 0,
    mtime: new Date('2000-01-01T00:00:00Z'),
  })
  if (result.length > ARCHIVE_LIMITS.bytes) fail('archive_limit')
  return result
}
/** Validate all directory metadata before allocating/decompressing any payload. No ZIP64/encryption. */
export function readZip(
  bytes: Uint8Array,
  kind: 'guide' | 'workspace' = 'guide',
): Record<string, Uint8Array> {
  try {
    if (bytes.length < 22 || bytes.length > ARCHIVE_LIMITS.bytes)
      fail('archive_limit')
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let end = bytes.length - 22
    for (; end >= Math.max(0, bytes.length - 65557); end--) {
      if (
        u32(v, end) === 0x06054b50 &&
        end + 22 + u16(v, end + 20) === bytes.length
      )
        break
    }
    if (
      end < 0 ||
      u32(v, end) !== 0x06054b50 ||
      end + 22 + u16(v, end + 20) !== bytes.length ||
      u16(v, end + 4) ||
      u16(v, end + 6) ||
      u16(v, end + 8) !== u16(v, end + 10)
    )
      fail()
    const count = u16(v, end + 10),
      start = u32(v, end + 16)
    if (
      !count ||
      count > ARCHIVE_LIMITS.entries ||
      start + u32(v, end + 12) !== end
    )
      fail('archive_limit')
    const entries: {
      name: string
      data: number
      stop: number
      local: number
      size: number
      compressed: number
      method: number
      crc: number
    }[] = []
    const names = new Set<string>()
    let at = start,
      total = 0
    for (let i = 0; i < count; i++) {
      if (at + 46 > end || u32(v, at) !== 0x02014b50) fail()
      const flags = u16(v, at + 8),
        method = u16(v, at + 10),
        crc = u32(v, at + 16)
      const compressed = u32(v, at + 20),
        size = u32(v, at + 24),
        n = u16(v, at + 28),
        extra = u16(v, at + 30),
        comment = u16(v, at + 32),
        local = u32(v, at + 42)
      if (
        flags & ~0x080e ||
        ![0, 8].includes(method) ||
        u16(v, at + 34) ||
        at + 46 + n + extra + comment > end ||
        !n ||
        n > 128
      )
        fail()
      const nameBytes = bytes.subarray(at + 46, at + 46 + n),
        name = decoder.decode(nameBytes)
      if (
        !(
          kind === 'workspace'
            ? /^(manifest\.json|guides\/[1-9][0-9]{0,2}\.stepdoc)$/
            : /^(manifest\.json|guide\.json|img\/step-[1-9][0-9]{0,2}(?:-original)?\.(png|webp))$/
        ).test(name) ||
        names.has(name)
      )
        fail()
      names.add(name)
      const limit = name.endsWith('.json')
        ? ARCHIVE_LIMITS.metadata
        : kind === 'workspace'
          ? ARCHIVE_LIMITS.bytes
          : ARCHIVE_LIMITS.image
      total += size
      if (
        !size ||
        size > limit ||
        compressed > ARCHIVE_LIMITS.bytes ||
        total > ARCHIVE_LIMITS.bytes
      )
        fail('archive_limit')
      if (
        local + 30 > start ||
        u32(v, local) !== 0x04034b50 ||
        u16(v, local + 6) !== flags ||
        u16(v, local + 8) !== method ||
        u16(v, local + 26) !== n
      )
        fail()
      const data = local + 30 + n + u16(v, local + 28)
      if (
        data + compressed > start ||
        !nameBytes.every((byte, index) => bytes[local + 30 + index] === byte)
      )
        fail()
      if (
        !(flags & 8) &&
        (u32(v, local + 14) !== crc ||
          u32(v, local + 18) !== compressed ||
          u32(v, local + 22) !== size)
      )
        fail()
      let stop = data + compressed
      if (flags & 8) {
        const d = stop + (u32(v, stop) === 0x08074b50 ? 4 : 0)
        if (
          d + 12 > start ||
          u32(v, d) !== crc ||
          u32(v, d + 4) !== compressed ||
          u32(v, d + 8) !== size
        )
          fail()
        stop = d + 12
      }
      entries.push({ name, local, data, stop, size, compressed, method, crc })
      at += 46 + n + extra + comment
    }
    if (at !== end) fail()
    let consumed = 0
    for (const entry of [...entries].sort((a, b) => a.local - b.local)) {
      if (entry.local !== consumed) fail()
      consumed = entry.stop
    }
    if (consumed !== start) fail()
    const result: Record<string, Uint8Array> = Object.create(null)
    for (const entry of entries) {
      const input = bytes.subarray(entry.data, entry.data + entry.compressed)
      const output = new Uint8Array(entry.size)
      if (entry.method === 0) {
        if (input.length !== output.length) fail()
        output.set(input)
      } else {
        let written = 0,
          finished = false
        const stream = new Inflate((chunk, final) => {
          if (written + chunk.length > output.length) fail('archive_limit')
          output.set(chunk, written)
          written += chunk.length
          finished = final
        })
        // Bound actual inflation per push too, including dishonest size headers.
        for (let offset = 0; offset < input.length; offset += 8192)
          stream.push(
            input.subarray(offset, offset + 8192),
            offset + 8192 >= input.length,
          )
        if (!finished || written !== output.length) fail()
      }
      if (crc32(output) !== entry.crc) fail()
      result[entry.name] = output
    }
    return result
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    return fail()
  }
}
export async function exportBundle(
  input: GuideInput,
  assets: GuideAssets,
): Promise<Uint8Array> {
  const { guide, files } = portableAssets(input, assets, true)
  files['guide.json'] = encoder.encode(JSON.stringify(guide, null, 2))
  if (files['guide.json'].length > ARCHIVE_LIMITS.metadata)
    fail('archive_limit')
  const hashes: Record<string, string> = Object.create(null)
  for (const [path, data] of Object.entries(files))
    hashes[path] = await sha256(data)
  files['manifest.json'] = encoder.encode(
    JSON.stringify({ format: BUNDLE_FORMAT, files: hashes }, null, 2),
  )
  return zipFiles(files)
}
export async function importBundle(
  bytes: Uint8Array,
): Promise<{ guide: Guide; assets: GuideAssets }> {
  try {
    const files = readZip(bytes)
    const manifest: unknown = JSON.parse(decoder.decode(files['manifest.json']))
    if (
      !manifest ||
      typeof manifest !== 'object' ||
      !('format' in manifest) ||
      manifest.format !== BUNDLE_FORMAT ||
      !('files' in manifest) ||
      !manifest.files ||
      typeof manifest.files !== 'object' ||
      Array.isArray(manifest.files) ||
      Object.keys(manifest).length !== 2
    )
      fail()
    const entries = Object.entries(manifest.files)
    if (
      entries.length + 1 !== Object.keys(files).length ||
      !files['guide.json']
    )
      fail()
    for (const [path, hash] of entries) {
      if (
        path === 'manifest.json' ||
        typeof hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(hash) ||
        !files[path] ||
        (await sha256(files[path]!)) !== hash
      )
        fail()
    }
    const raw: unknown = JSON.parse(decoder.decode(files['guide.json']))
    const { guide } = prepareExport(raw as GuideInput)
    const source = raw as Guide
    const used = new Set(['guide.json', 'manifest.json'])
    const assets: Record<string, StepAssets> = Object.create(null)
    for (const step of guide.steps)
      if (step.screenshot) {
        const before = source.steps.find((s) => s.id === step.id)!.screenshot!
        const asset = (path: string, original = false): RasterAsset => {
          const expected = `img/step-${step.index}${original ? '-original' : ''}`
          if (
            ![`${expected}.png`, `${expected}.webp`].includes(path) ||
            !files[path] ||
            used.has(path)
          )
            return fail()
          used.add(path)
          const value: RasterAsset = {
            data: files[path]!,
            mime: path.endsWith('.png') ? 'image/png' : 'image/webp',
          }
          rasterInfo(value)
          return value
        }
        const rendered = asset(before.rendered)
        const dims = rasterInfo(rendered)
        if (
          dims.width !== step.screenshot.width ||
          dims.height !== step.screenshot.height
        )
          fail('invalid_image')
        assets[step.id] = {
          rendered,
          ...(before.original
            ? { original: asset(before.original, true) }
            : {}),
        }
        step.screenshot.rendered = before.rendered
        step.screenshot.original = before.original ?? null
      }
    if (used.size !== Object.keys(files).length) fail()
    return { guide, assets }
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    return fail()
  }
}

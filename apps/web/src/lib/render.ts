import sharp from 'sharp'
import type { ImageEdits } from '@stepdoc/schema/legacy-v1'

type Rect = { x: number; y: number; width: number; height: number }
type Click = { x: number; y: number; radius: number } | null | undefined

function clampRect(rect: Rect, bounds: Rect): Rect | null {
  const left = Math.max(rect.x, bounds.x)
  const top = Math.max(rect.y, bounds.y)
  const right = Math.min(rect.x + rect.width, bounds.x + bounds.width)
  const bottom = Math.min(rect.y + rect.height, bounds.y + bounds.height)
  if (right <= left || bottom <= top) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function esc(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
}

export async function flattenImage(input: Buffer, edits: ImageEdits, click?: Click) {
  const metadata = await sharp(input).metadata()
  const sourceBounds = { x: 0, y: 0, width: metadata.width ?? 1, height: metadata.height ?? 1 }
  const crop = edits.crop ? clampRect(edits.crop, sourceBounds) : sourceBounds
  if (!crop) return sharp(input).webp({ quality: 88 }).toBuffer()

  const base = sharp(input).extract({
    left: Math.round(crop.x),
    top: Math.round(crop.y),
    width: Math.max(1, Math.round(crop.width)),
    height: Math.max(1, Math.round(crop.height)),
  })
  const overlays: sharp.OverlayOptions[] = []

  for (const blur of edits.blur) {
    const visible = clampRect(blur, crop)
    if (!visible) continue
    const width = Math.max(1, Math.round(visible.width))
    const height = Math.max(1, Math.round(visible.height))
    const region = await sharp(input)
      .extract({
        left: Math.round(visible.x),
        top: Math.round(visible.y),
        width,
        height,
      })
      .resize(Math.max(1, Math.round(width / 15)), Math.max(1, Math.round(height / 15)))
      .resize(width, height, { kernel: 'nearest' })
      .toBuffer()
    overlays.push({ input: region, left: Math.round(visible.x - crop.x), top: Math.round(visible.y - crop.y) })
  }

  const svgParts = edits.annotations
    .map((annotation) => {
      if (annotation.type === 'rectangle') {
        return `<rect x="${annotation.x - crop.x}" y="${annotation.y - crop.y}" width="${annotation.width}" height="${annotation.height}" fill="none" stroke="${esc(annotation.color)}" stroke-width="4"/>`
      }
      if (annotation.type === 'arrow') {
        return `<line x1="${annotation.x - crop.x}" y1="${annotation.y - crop.y}" x2="${annotation.toX - crop.x}" y2="${annotation.toY - crop.y}" stroke="${esc(annotation.color)}" stroke-width="5" marker-end="url(#a)"/>`
      }
      return `<text x="${annotation.x - crop.x}" y="${annotation.y - crop.y}" fill="${esc(annotation.color)}" font-size="24">${esc(annotation.text)}</text>`
    })
    .join('')
  const marker = click
    ? `<circle cx="${click.x - crop.x}" cy="${click.y - crop.y}" r="${click.radius}" fill="none" stroke="#ef4444" stroke-width="5"/>`
    : ''
  const svg = `${svgParts}${marker}`
  if (svg) {
    overlays.push({
      input: Buffer.from(
        `<svg width="${Math.round(crop.width)}" height="${Math.round(crop.height)}"><defs><marker id="a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#ef4444"/></marker></defs>${svg}</svg>`,
      ),
      left: 0,
      top: 0,
    })
  }

  return base.composite(overlays).webp({ quality: 88 }).toBuffer()
}

import type { Annotation, Rect, StepInput } from '@stepdoc/schema'
import tokens from '../../../../docs/v2/design-tokens.json'
import { rectangleLabelLayout } from './labels'
import {
  assertImageDimensions,
  assertRect,
  CANVAS_LIMITS,
  CanvasImageError,
  captureRectToPixels,
  clipPixelRect,
} from './geometry'

export interface FlattenOptions {
  edits?: StepInput['edits']
  /** Image-pixel masks, selected by the caller's redaction/review policy. All are applied. */
  redactions?: readonly Rect[]
  /** Capture-time CSS-pixel masks; only these are scaled by devicePixelRatio. */
  sensitiveRects?: readonly Rect[]
  devicePixelRatio?: number
  click?: StepInput['click']
  format?: 'image/png' | 'image/webp'
  quality?: number
  redactionMode?: 'pixelate' | 'solid'
  pixelSize?: number
  theme?: 'light' | 'dark'
  strokeWidth?: number
  fontFamily?: string
  /** Disposable WebP from the final redacted canvas, without decoding its encoded output. */
  preview?: { width: number; height: number; maxBytes: number }
}

export interface EncodedImage {
  readonly blob: Blob
  readonly width: number
  readonly height: number
  readonly preview?: Blob
}
export interface PreparedCapture {
  readonly original: EncodedImage
  readonly rendered: EncodedImage
}

function validateOptions(options: FlattenOptions): void {
  if (
    options.preview &&
    (!Number.isInteger(options.preview.width) ||
      options.preview.width < 1 ||
      options.preview.width > 1024 ||
      !Number.isInteger(options.preview.height) ||
      options.preview.height < 1 ||
      options.preview.height > 1024 ||
      !Number.isInteger(options.preview.maxBytes) ||
      options.preview.maxBytes < 1 ||
      options.preview.maxBytes > CANVAS_LIMITS.maxBytes)
  )
    throw new CanvasImageError('invalid_options')
  const layers =
    (options.redactions?.length ?? 0) +
    (options.sensitiveRects?.length ?? 0) +
    (options.edits?.annotations?.length ?? 0)
  if (
    layers > CANVAS_LIMITS.maxLayers ||
    (options.format !== undefined &&
      !['image/png', 'image/webp'].includes(options.format)) ||
    (options.theme !== undefined &&
      !['light', 'dark'].includes(options.theme)) ||
    (options.redactionMode !== undefined &&
      !['pixelate', 'solid'].includes(options.redactionMode)) ||
    !Number.isFinite(options.quality ?? 0.88) ||
    (options.quality ?? 0.88) < 0 ||
    (options.quality ?? 0.88) > 1 ||
    !Number.isInteger(options.pixelSize ?? 14) ||
    (options.pixelSize ?? 14) < 2 ||
    (options.pixelSize ?? 14) > 256 ||
    !Number.isFinite(options.strokeWidth ?? 4) ||
    (options.strokeWidth ?? 4) <= 0 ||
    (options.strokeWidth ?? 4) > 128 ||
    !Number.isFinite(options.devicePixelRatio ?? 1) ||
    (options.devicePixelRatio ?? 1) <= 0 ||
    (options.devicePixelRatio ?? 1) > 8 ||
    (options.fontFamily !== undefined &&
      (!options.fontFamily.trim() ||
        options.fontFamily.length > 200 ||
        /[\n\r;{}<>]/.test(options.fontFamily)))
  )
    throw new CanvasImageError('invalid_options')
  for (const rect of [
    ...(options.redactions ?? []),
    ...(options.sensitiveRects ?? []),
  ])
    assertRect(rect)
  if (options.edits?.crop) assertRect(options.edits.crop)
  if (
    options.click &&
    (!Number.isFinite(options.click.x) ||
      !Number.isFinite(options.click.y) ||
      !Number.isFinite(options.click.radius ?? 18) ||
      (options.click.radius ?? 18) <= 0)
  )
    throw new CanvasImageError('invalid_options')
  for (const annotation of options.edits?.annotations ?? []) {
    if (
      ![annotation.x, annotation.y].every(Number.isFinite) ||
      (annotation.text !== undefined &&
        (typeof annotation.text !== 'string' ||
          annotation.text.length > CANVAS_LIMITS.maxTextLength)) ||
      (annotation.color !== undefined &&
        (typeof annotation.color !== 'string' || annotation.color.length > 128))
    )
      throw new CanvasImageError('invalid_options')
    if (annotation.type === 'rectangle') {
      assertRect({
        x: annotation.x,
        y: annotation.y,
        width: annotation.width!,
        height: annotation.height!,
      })
      if (
        annotation.text?.trim() &&
        [annotation.toX, annotation.toY].some(
          (value) => value !== undefined && !Number.isFinite(value),
        )
      )
        throw new CanvasImageError('invalid_options')
    } else if (annotation.type === 'arrow') {
      if (
        ![annotation.toX, annotation.toY].every(
          (value) => typeof value === 'number' && Number.isFinite(value),
        )
      )
        throw new CanvasImageError('invalid_options')
    } else if (annotation.type !== 'text' && annotation.type !== 'pin')
      throw new CanvasImageError('invalid_options')
    if (annotation.type === 'text' && typeof annotation.text !== 'string')
      throw new CanvasImageError('invalid_options')
  }
}

function context(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new CanvasImageError('unsupported')
  return ctx
}

async function decode(input: Blob): Promise<ImageBitmap> {
  if (
    typeof OffscreenCanvas !== 'function' ||
    typeof createImageBitmap !== 'function'
  )
    throw new CanvasImageError('unsupported')
  if (!(input instanceof Blob) || !input.size)
    throw new CanvasImageError('invalid_image')
  if (input.size > CANVAS_LIMITS.maxBytes)
    throw new CanvasImageError('image_limit')
  const bytes = new Uint8Array(await input.slice(0, 12).arrayBuffer())
  const mime = input.type.split(';')[0]?.trim().toLowerCase()
  const png =
    mime === 'image/png' &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (byte, index) => bytes[index] === byte,
    )
  const jpeg =
    mime === 'image/jpeg' &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  const webp =
    mime === 'image/webp' &&
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  if (!png && !jpeg && !webp) throw new CanvasImageError('invalid_image')
  try {
    return await createImageBitmap(input)
  } catch {
    throw new CanvasImageError('invalid_image')
  }
}

function applyMasks(canvas: OffscreenCanvas, options: FlattenOptions): void {
  const ctx = context(canvas)
  const rectangles: Rect[] = []
  for (const rect of options.redactions ?? []) {
    const clipped = clipPixelRect(rect, canvas.width, canvas.height)
    if (clipped) rectangles.push(clipped)
  }
  for (const rect of options.sensitiveRects ?? []) {
    const clipped = captureRectToPixels(
      rect,
      options.devicePixelRatio ?? 1,
      canvas.width,
      canvas.height,
    )
    if (clipped) rectangles.push(clipped)
  }
  for (const rect of rectangles) {
    ctx.save()
    try {
      if (options.redactionMode === 'solid') {
        ctx.fillStyle = tokens.color['text/primary'][options.theme ?? 'light']
        ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      } else {
        const sample = new OffscreenCanvas(
          Math.max(1, Math.ceil(rect.width / (options.pixelSize ?? 14))),
          Math.max(1, Math.ceil(rect.height / (options.pixelSize ?? 14))),
        )
        try {
          context(sample).drawImage(
            canvas,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            0,
            0,
            sample.width,
            sample.height,
          )
          ctx.imageSmoothingEnabled = false
          ctx.clearRect(rect.x, rect.y, rect.width, rect.height)
          ctx.drawImage(
            sample,
            0,
            0,
            sample.width,
            sample.height,
            rect.x,
            rect.y,
            rect.width,
            rect.height,
          )
        } finally {
          sample.width = sample.height = 1
        }
      }
    } finally {
      ctx.restore()
    }
  }
}

function resolveColor(
  ctx: OffscreenCanvasRenderingContext2D,
  value: string | undefined,
  theme: 'light' | 'dark',
): string {
  const accent = tokens.color['accent/solid'][theme]
  const color = value === undefined || value === 'accent' ? accent : value
  // OffscreenCanvas has no CSS.supports; invalid colors retain the old style.
  ctx.fillStyle = accent
  ctx.fillStyle = color
  const first = ctx.fillStyle
  ctx.fillStyle = tokens.color['text/on-accent'][theme]
  ctx.fillStyle = color
  if (first !== ctx.fillStyle) throw new CanvasImageError('invalid_options')
  return first as string
}

function drawAnnotation(
  ctx: OffscreenCanvasRenderingContext2D,
  annotation: Omit<Annotation, 'color'> & { color?: string },
  options: FlattenOptions,
): void {
  ctx.save()
  try {
    const theme = options.theme ?? 'light'
    const color = resolveColor(ctx, annotation.color, theme)
    ctx.strokeStyle = ctx.fillStyle = color
    ctx.lineWidth = options.strokeWidth ?? 4
    ctx.lineCap = ctx.lineJoin = 'round'
    if (annotation.type === 'rectangle') {
      const { x, y, width = 0, height = 0 } = annotation
      if (!width || !height) return
      const label = rectangleLabelLayout(annotation)
      ctx.lineWidth = Math.min(ctx.lineWidth, width, height)
      const inset = ctx.lineWidth / 2
      ctx.beginPath()
      ctx.roundRect(
        x + inset,
        y + inset,
        width - inset * 2,
        height - inset * 2,
        Math.max(
          0,
          Math.min(label.outlineRadius, width / 2, height / 2) - inset,
        ),
      )
      ctx.stroke()
      if (annotation.text?.trim() && width > 0 && height > 0) {
        ctx.font = `${label.fontWeight} ${label.fontSize}px ${options.fontFamily ?? tokens.font.sans}`
        const labelWidth = Math.min(
          CANVAS_LIMITS.maxEdge,
          ctx.measureText(annotation.text).width + label.padding * 2,
        )
        ctx.beginPath()
        ctx.roundRect(
          label.x,
          label.y,
          labelWidth,
          label.height,
          Math.min(label.radius, labelWidth / 2),
        )
        ctx.fill()
        ctx.clip()
        ctx.fillStyle = tokens.color['text/on-accent'][theme]
        ctx.textBaseline = 'middle'
        ctx.fillText(
          annotation.text,
          label.x + label.padding,
          label.y + label.height / 2,
          Math.max(1, labelWidth - label.padding * 2),
        )
      }
    } else if (annotation.type === 'arrow') {
      const x = annotation.toX!,
        y = annotation.toY!
      const angle = Math.atan2(y - annotation.y, x - annotation.x)
      const head = Math.max(8, ctx.lineWidth * 3)
      ctx.beginPath()
      ctx.moveTo(annotation.x, annotation.y)
      ctx.lineTo(x, y)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(
        x - head * Math.cos(angle - Math.PI / 6),
        y - head * Math.sin(angle - Math.PI / 6),
      )
      ctx.lineTo(
        x - head * Math.cos(angle + Math.PI / 6),
        y - head * Math.sin(angle + Math.PI / 6),
      )
      ctx.closePath()
      ctx.fill()
    } else {
      const style =
        tokens.type[annotation.type === 'pin' ? 'label-s' : 'heading-s']
      ctx.font = `${style.weight} ${style.size}px ${options.fontFamily ?? tokens.font.sans}`
      if (annotation.type === 'pin') {
        const radius = tokens.space['3']
        ctx.beginPath()
        ctx.arc(annotation.x, annotation.y, radius, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = tokens.color['text/on-accent'][theme]
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(
          annotation.text ?? '1',
          annotation.x,
          annotation.y,
          radius * 1.6,
        )
      } else ctx.fillText(annotation.text!, annotation.x, annotation.y)
    }
  } finally {
    ctx.restore()
  }
}

function drawRendered(
  base: OffscreenCanvas,
  options: FlattenOptions,
): OffscreenCanvas {
  const crop = options.edits?.crop
    ? clipPixelRect(options.edits.crop, base.width, base.height)
    : { x: 0, y: 0, width: base.width, height: base.height }
  if (!crop) throw new CanvasImageError('invalid_options')
  const rendered = new OffscreenCanvas(crop.width, crop.height)
  try {
    const ctx = context(rendered)
    ctx.drawImage(
      base,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      crop.width,
      crop.height,
    )
    ctx.translate(-crop.x, -crop.y)
    for (const annotation of options.edits?.annotations ?? [])
      drawAnnotation(ctx, annotation, options)
    if (options.click) {
      ctx.strokeStyle = tokens.color['accent/solid'][options.theme ?? 'light']
      ctx.lineWidth = options.strokeWidth ?? 4
      ctx.beginPath()
      ctx.arc(
        options.click.x!,
        options.click.y!,
        options.click.radius ?? 18,
        0,
        Math.PI * 2,
      )
      ctx.stroke()
    }
    return rendered
  } catch (error) {
    rendered.width = rendered.height = 1
    throw error
  }
}

async function encode(
  canvas: OffscreenCanvas,
  options: FlattenOptions,
): Promise<EncodedImage> {
  try {
    const format = options.format ?? 'image/webp'
    const blob = await canvas.convertToBlob({
      type: format,
      quality: options.quality ?? 0.88,
    })
    if (!blob.size || blob.type !== format) throw new Error()
    return { blob, width: canvas.width, height: canvas.height }
  } catch {
    throw new CanvasImageError('encode_failed')
  }
}

async function canvasPreview(
  canvas: OffscreenCanvas,
  bounds: NonNullable<FlattenOptions['preview']>,
): Promise<Blob> {
  const ratio = Math.min(
    1,
    bounds.width / canvas.width,
    bounds.height / canvas.height,
  )
  const preview = new OffscreenCanvas(
    Math.max(1, Math.round(canvas.width * ratio)),
    Math.max(1, Math.round(canvas.height * ratio)),
  )
  try {
    context(preview).drawImage(canvas, 0, 0, preview.width, preview.height)
    const blob = await preview.convertToBlob({
      type: 'image/webp',
      quality: 0.8,
    })
    if (!blob.size || blob.type !== 'image/webp' || blob.size > bounds.maxBytes)
      throw new CanvasImageError('encode_failed')
    return blob
  } finally {
    preview.width = preview.height = 1
  }
}

async function processImage(
  input: Blob,
  options: FlattenOptions,
  keepOriginal: true,
): Promise<PreparedCapture>
async function processImage(
  input: Blob,
  options: FlattenOptions,
  keepOriginal: false,
): Promise<EncodedImage>
async function processImage(
  input: Blob,
  options: FlattenOptions,
  keepOriginal: boolean,
): Promise<PreparedCapture | EncodedImage> {
  try {
    // UI state may change while image decoding yields. Keep this job's mask set fixed.
    options = structuredClone(options)
    validateOptions(options)
  } catch (error) {
    if (error instanceof CanvasImageError) throw error
    throw new CanvasImageError('invalid_options')
  }
  let bitmap: ImageBitmap | undefined
  let base: OffscreenCanvas | undefined
  let rendered: OffscreenCanvas | undefined
  try {
    bitmap = await decode(input)
    assertImageDimensions(bitmap.width, bitmap.height)
    base = new OffscreenCanvas(bitmap.width, bitmap.height)
    context(base).drawImage(bitmap, 0, 0)
    bitmap.close()
    bitmap = undefined
    applyMasks(base, options)
    const original = keepOriginal ? await encode(base, options) : undefined
    rendered = drawRendered(base, options)
    base.width = base.height = 1
    const preview = options.preview
      ? await canvasPreview(rendered, options.preview).catch(() => undefined)
      : undefined
    const encoded = await encode(rendered, options)
    const output = preview ? { ...encoded, preview } : encoded
    return original ? { original, rendered: output } : output
  } catch (error) {
    if (error instanceof CanvasImageError) throw error
    throw new CanvasImageError('render_failed')
  } finally {
    bitmap?.close()
    if (base) base.width = base.height = 1
    if (rendered) rendered.width = rendered.height = 1
  }
}

/** Both returned blobs are encoded after masking. The raw capture is never returned. */
export async function prepareCapture(
  input: Blob,
  options: FlattenOptions = {},
): Promise<PreparedCapture> {
  return processImage(input, options, true)
}

/** All geometry is in source-image pixels, except explicitly named sensitiveRects. */
export async function flattenImage(
  input: Blob,
  options: FlattenOptions = {},
): Promise<EncodedImage> {
  return processImage(input, options, false)
}

import type { Rect } from '@stepdoc/schema'

export class CanvasImageError extends Error {
  constructor(
    public readonly code:
      | 'unsupported'
      | 'invalid_image'
      | 'invalid_options'
      | 'image_limit'
      | 'render_failed'
      | 'encode_failed',
  ) {
    super(`Image processing failed: ${code}`)
    this.name = 'CanvasImageError'
  }
}

export const CANVAS_LIMITS = Object.freeze({
  maxEdge: 16_384,
  maxPixels: 64_000_000,
  maxBytes: 64 * 1024 * 1024,
  maxLayers: 1000,
  maxTextLength: 5000,
})

export function assertImageDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  )
    throw new CanvasImageError('invalid_image')
  if (
    width > CANVAS_LIMITS.maxEdge ||
    height > CANVAS_LIMITS.maxEdge ||
    width * height > CANVAS_LIMITS.maxPixels
  )
    throw new CanvasImageError('image_limit')
}

export function assertRect(rect: Rect): void {
  if (
    ![
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      rect.x + rect.width,
      rect.y + rect.height,
    ].every(Number.isFinite) ||
    rect.width < 0 ||
    rect.height < 0
  )
    throw new CanvasImageError('invalid_options')
}

/** Round outwards so fractional bounds never leave a strip of sensitive pixels. */
export function clipPixelRect(
  rect: Rect,
  width: number,
  height: number,
): Rect | null {
  assertImageDimensions(width, height)
  assertRect(rect)
  if (rect.width === 0 || rect.height === 0) return null
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  const right = Math.min(width, Math.ceil(rect.x + rect.width))
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height))
  return right > x && bottom > y
    ? { x, y, width: right - x, height: bottom - y }
    : null
}

export function captureRectToPixels(
  rect: Rect,
  devicePixelRatio: number,
  width: number,
  height: number,
): Rect | null {
  if (
    !Number.isFinite(devicePixelRatio) ||
    devicePixelRatio <= 0 ||
    devicePixelRatio > 8
  )
    throw new CanvasImageError('invalid_options')
  assertRect(rect)
  return clipPixelRect(
    {
      x: rect.x * devicePixelRatio,
      y: rect.y * devicePixelRatio,
      width: rect.width * devicePixelRatio,
      height: rect.height * devicePixelRatio,
    },
    width,
    height,
  )
}

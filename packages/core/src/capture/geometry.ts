import type { Rect } from '@stepdoc/schema'

export interface FrameTransform {
  x: number
  y: number
  sx: number
  sy: number
}
export interface FrameContext {
  documentId: string
  frame: string[]
  url: string
  topUrl: string
  transform: FrameTransform
  clip: Rect
  devicePixelRatio: number
  precise: boolean
}
export const identityTransform: Readonly<FrameTransform> = Object.freeze({
  x: 0,
  y: 0,
  sx: 1,
  sy: 1,
})
function finite(values: number[]): void {
  if (!values.every(Number.isFinite)) throw new Error('Invalid frame geometry')
}
export function transformPoint(
  transform: FrameTransform,
  point: { x: number; y: number },
): { x: number; y: number } {
  const x = transform.x + point.x * transform.sx,
    y = transform.y + point.y * transform.sy
  finite([x, y])
  return { x, y }
}
export function transformRect(transform: FrameTransform, rect: Rect): Rect {
  const point = transformPoint(transform, rect),
    width = rect.width * transform.sx,
    height = rect.height * transform.sy
  finite([width, height])
  if (width < 0 || height < 0) throw new Error('Invalid frame geometry')
  return { ...point, width, height }
}
export function intersectRects(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y),
    right = Math.min(a.x + a.width, b.x + b.width),
    bottom = Math.min(a.y + a.height, b.y + b.height)
  finite([x, y, right, bottom])
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  }
}
export function childTransform(
  parent: FrameTransform,
  content: Rect,
  viewport: { width: number; height: number },
): FrameTransform {
  if (viewport.width <= 0 || viewport.height <= 0)
    throw new Error('Invalid frame geometry')
  const origin = transformPoint(parent, content)
  const sx = (parent.sx * content.width) / viewport.width,
    sy = (parent.sy * content.height) / viewport.height
  finite([sx, sy])
  if (sx <= 0 || sy <= 0) throw new Error('Invalid frame geometry')
  return { ...origin, sx, sy }
}

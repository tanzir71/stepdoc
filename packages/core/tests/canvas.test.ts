import { describe, expect, it } from 'vitest'
import {
  assertImageDimensions,
  CANVAS_LIMITS,
  CanvasImageError,
  captureRectToPixels,
  clipPixelRect,
  flattenImage,
  prepareCapture,
  type FlattenOptions,
} from '../src/canvas'

describe('image geometry and resource limits', () => {
  it('clips partial masks and rounds outward over every covered pixel', () => {
    expect(
      clipPixelRect({ x: -5.2, y: -3.2, width: 10.5, height: 8.5 }, 100, 80),
    ).toEqual({ x: 0, y: 0, width: 6, height: 6 })
    expect(
      clipPixelRect({ x: 98.1, y: 78.1, width: 10, height: 10 }, 100, 80),
    ).toEqual({ x: 98, y: 78, width: 2, height: 2 })
    expect(
      clipPixelRect({ x: 5.2, y: 6.7, width: 0.1, height: 0.1 }, 100, 80),
    ).toEqual({ x: 5, y: 6, width: 1, height: 1 })
  })
  it.each([
    { x: 100, y: 0, width: 2, height: 2 },
    { x: 0, y: -10, width: 2, height: 2 },
    { x: 0, y: 0, width: 0, height: 1 },
  ])('omits zero-area/outside rectangles', (rect) =>
    expect(clipPixelRect(rect, 100, 80)).toBeNull(),
  )
  it('converts CSS masks to image pixels before clipping', () => {
    expect(
      captureRectToPixels({ x: -2, y: 3.2, width: 5, height: 2.4 }, 2, 100, 80),
    ).toEqual({ x: 0, y: 6, width: 6, height: 6 })
  })
  it.each([0, -1, Infinity, NaN, 9])('rejects invalid DPR %s', (dpr) =>
    expect(() =>
      captureRectToPixels({ x: 0, y: 0, width: 1, height: 1 }, dpr, 100, 80),
    ).toThrow(CanvasImageError),
  )
  it.each([
    { x: NaN, y: 0, width: 1, height: 1 },
    { x: 0, y: Infinity, width: 1, height: 1 },
    { x: 0, y: 0, width: -1, height: 1 },
    { x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 },
  ])('rejects invalid mask geometry', (rect) =>
    expect(() => clipPixelRect(rect, 100, 80)).toThrow(CanvasImageError),
  )
  it.each([
    [0, 1],
    [1.5, 1],
    [NaN, 1],
    [CANVAS_LIMITS.maxEdge + 1, 1],
    [10_000, 10_000],
  ])('rejects invalid/oversized image dimensions %s×%s', (width, height) =>
    expect(() => assertImageDimensions(width!, height!)).toThrow(
      CanvasImageError,
    ),
  )
})

describe('fail-closed image processing options', () => {
  const input = new Blob(['not decoded in Node'], { type: 'image/png' })
  it('does not require DOM globals at import time and rejects a missing canvas runtime', async () => {
    expect(typeof document).toBe('undefined')
    expect(typeof OffscreenCanvas).toBe('undefined')
    await expect(flattenImage(input)).rejects.toMatchObject({
      code: 'unsupported',
    })
    await expect(prepareCapture(input)).rejects.toMatchObject({
      code: 'unsupported',
    })
  })
  it.each([
    { quality: NaN },
    { quality: 2 },
    { pixelSize: 1 },
    { pixelSize: 2.5 },
    { strokeWidth: 0 },
    { redactions: [{ x: NaN, y: 0, width: 5, height: 5 }] },
    { click: { x: 1, y: 1, radius: -1 } },
    { click: { radius: 1 } },
    { edits: { annotations: [{ type: 'arrow', x: 1, y: 1 }] } },
    { edits: { annotations: [{ type: 'rectangle', x: 1, y: 1 }] } },
    { edits: { annotations: [{ type: 'text', x: 1, y: 1 }] } },
    {
      edits: {
        annotations: [{ type: 'text', x: 1, y: 1, text: 'a'.repeat(5001) }],
      },
    },
    { fontFamily: 'bad; font' },
    {
      redactions: Array.from({ length: 1001 }, () => ({
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      })),
    },
  ] satisfies FlattenOptions[])(
    'rejects invalid options before attempting decoding',
    async (options) => {
      await expect(prepareCapture(input, options)).rejects.toMatchObject({
        code: 'invalid_options',
      })
    },
  )
  it('does not include source data or causes in errors', async () => {
    try {
      await flattenImage(
        new Blob(['private-image-data'], { type: 'image/png' }),
      )
      throw new Error('Expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasImageError)
      expect(String(error) + JSON.stringify(error)).not.toContain(
        'private-image-data',
      )
      expect(error).not.toHaveProperty('cause')
    }
  })
})

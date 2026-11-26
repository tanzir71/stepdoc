import { describe, expect, it } from 'vitest'
import {
  childTransform,
  identityTransform,
  intersectRects,
  transformPoint,
  transformRect,
} from './geometry'

describe('frame geometry', () => {
  it('composes nested content-box scale and offsets without adding borders twice', () => {
    const first = childTransform(
      identityTransform,
      { x: 12, y: 24, width: 300, height: 150 },
      { width: 600, height: 300 },
    )
    const next = childTransform(
      first,
      { x: 20, y: 40, width: 100, height: 50 },
      { width: 100, height: 50 },
    )
    expect(transformPoint(next, { x: 40, y: 20 })).toEqual({ x: 42, y: 54 })
    expect(
      transformRect(next, { x: 10, y: 20, width: 30, height: 40 }),
    ).toEqual({ x: 27, y: 54, width: 15, height: 20 })
  })
  it('clips fractional/negative positions to each ancestor viewport', () => {
    expect(
      intersectRects(
        { x: -2.5, y: 9.5, width: 10, height: 20 },
        { x: 0, y: 0, width: 100, height: 15 },
      ),
    ).toEqual({ x: 0, y: 9.5, width: 7.5, height: 5.5 })
    expect(
      intersectRects(
        { x: 200, y: 0, width: 10, height: 10 },
        { x: 0, y: 0, width: 100, height: 100 },
      ).width,
    ).toBe(0)
  })
  it('rejects invalid viewport, inverted scale and overflowing transforms', () => {
    expect(() =>
      childTransform(
        identityTransform,
        { x: 0, y: 0, width: 10, height: 10 },
        { width: 0, height: 1 },
      ),
    ).toThrow('Invalid frame geometry')
    expect(() =>
      transformRect(
        { x: 0, y: 0, sx: -1, sy: 1 },
        { x: 0, y: 0, width: 10, height: 10 },
      ),
    ).toThrow('Invalid frame geometry')
    expect(() =>
      transformPoint(
        { x: Number.MAX_VALUE, y: 0, sx: Number.MAX_VALUE, sy: 1 },
        { x: 10, y: 0 },
      ),
    ).toThrow('Invalid frame geometry')
  })
})

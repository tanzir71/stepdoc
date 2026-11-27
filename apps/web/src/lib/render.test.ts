import { beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { flattenImage } from './render'

describe('flattenImage', () => {
  beforeAll(async () => {
    // libvips/Pango initializes host fonts on the first SVG text render.
    // Keep native setup outside the unchanged five-second layer behavior check.
    await sharp(
      Buffer.from('<svg width="16" height="16"><text x="0" y="12" font-size="12">A</text></svg>'),
    ).png().toBuffer()
  }, 30000)

  it('applies non-destructive crop, blur, annotation and marker layers', async () => {
    const original = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#ffffff' },
    }).png().toBuffer()

    const output = await flattenImage(
      original,
      {
        blur: [{ x: 5, y: 5, width: 20, height: 20 }],
        crop: { x: 0, y: 0, width: 40, height: 30 },
        annotations: [
          { type: 'rectangle', x: 2, y: 2, width: 10, height: 10, color: '#ef4444' },
          { type: 'arrow', x: 4, y: 4, toX: 20, toY: 16, color: '#ef4444' },
          { type: 'text', x: 6, y: 24, text: 'Note', color: '#ef4444' },
        ],
      },
      { x: 20, y: 15, radius: 8 },
    )

    const originalMeta = await sharp(original).metadata()
    const outputMeta = await sharp(output).metadata()
    expect(originalMeta).toMatchObject({ width: 80, height: 60, format: 'png' })
    expect(outputMeta).toMatchObject({ width: 40, height: 30, format: 'webp' })
  })
})

import type * as CanvasCore from '../../src/canvas'
import type { composite as Composite } from '../../../../apps/extension/src/image'

export async function verifyCanvas(
  core: typeof CanvasCore,
  composite: typeof Composite,
): Promise<number> {
  let checks = 0
  function check(condition: boolean, name: string) {
    if (!condition) throw new Error(name)
    checks++
  }
  function eq(
    actual: readonly number[],
    expected: readonly number[],
    name: string,
  ) {
    check(
      actual.join(',') === expected.join(','),
      `${name}: ${actual.join(',')}`,
    )
  }
  const canvas = new OffscreenCanvas(96, 64)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, 96, 64)
  ctx.fillStyle = '#ff0000'
  ctx.fillRect(0, 0, 16, 16)
  const input = await canvas.convertToBlob({ type: 'image/png' })
  const bytesBefore = [...new Uint8Array(await input.arrayBuffer())]
  async function pixels(image: CanvasCore.EncodedImage) {
    const bitmap = await createImageBitmap(image.blob)
    check(
      bitmap.width === image.width && bitmap.height === image.height,
      'encoded dimensions',
    )
    const copy = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = copy.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    const data = context.getImageData(0, 0, copy.width, copy.height).data
    const width = copy.width
    copy.width = copy.height = 1
    return (x: number, y: number) => [
      ...data.slice((y * width + x) * 4, (y * width + x) * 4 + 4),
    ]
  }

  const prepared = await core.prepareCapture(input, {
    format: 'image/png',
    redactionMode: 'solid',
    redactions: [{ x: 0, y: 0, width: 16, height: 16 }],
    edits: {
      crop: { x: 8, y: 8, width: 32, height: 24 },
      annotations: [{ type: 'rectangle', x: 25, y: 20, width: 10, height: 8 }],
    },
    click: { x: 40, y: 25, radius: 5 },
  })
  check(prepared.original.blob !== input, 'raw capture must not be returned')
  check(
    prepared.original.width === 96 && prepared.original.height === 64,
    'original dimensions',
  )
  check(
    prepared.rendered.width === 32 && prepared.rendered.height === 24,
    'cropped dimensions',
  )
  const original = await pixels(prepared.original)
  const rendered = await pixels(prepared.rendered)
  eq(original(4, 4), [20, 20, 22, 255], 'original is redacted')
  eq(rendered(1, 1), [20, 20, 22, 255], 'rendered crop is redacted')
  eq(original(25, 20), [255, 255, 255, 255], 'original has no annotations')
  check(
    rendered(17, 12)[0] === 242 && rendered(17, 12)[1] === 85,
    'annotation is translated with crop',
  )
  eq(original(35, 25), [255, 255, 255, 255], 'original has no click marker')

  const scaled = await core.flattenImage(input, {
    format: 'image/png',
    redactionMode: 'solid',
    devicePixelRatio: 2,
    sensitiveRects: [{ x: -2, y: 2, width: 5, height: 3 }],
  })
  const scalePixels = await pixels(scaled)
  eq(scalePixels(5, 5), [20, 20, 22, 255], 'CSS mask scaled and clipped')
  eq(
    scalePixels(6, 5),
    [255, 0, 0, 255],
    'negative clipping does not over-redact',
  )
  const fractional = await pixels(
    await core.flattenImage(input, {
      format: 'image/png',
      redactionMode: 'solid',
      redactions: [{ x: 8.4, y: 8.4, width: 0.2, height: 0.2 }],
    }),
  )
  eq(fractional(8, 8), [20, 20, 22, 255], 'fractional mask rounds outward')
  eq(
    fractional(9, 8),
    [255, 0, 0, 255],
    'fractional mask does not grow an extra pixel',
  )

  const state = {
    format: 'image/png' as const,
    redactionMode: 'solid' as const,
    redactions: [{ x: 0, y: 0, width: 16, height: 16 }],
  }
  const inFlight = core.prepareCapture(input, state)
  state.redactions.length = 0
  eq(
    (await pixels((await inFlight).original))(4, 4),
    [20, 20, 22, 255],
    'mask snapshot survives UI state mutation',
  )
  eq(
    [...new Uint8Array(await input.arrayBuffer())],
    bytesBefore,
    'source bytes unchanged',
  )

  const pattern = new OffscreenCanvas(16, 16)
  const patternContext = pattern.getContext('2d')!
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      patternContext.fillStyle = (x + y) % 2 ? '#ffffff' : '#000000'
      patternContext.fillRect(x, y, 1, 1)
    }
  const patternBlob = await pattern.convertToBlob({ type: 'image/png' })
  const pixelated = await pixels(
    await core.flattenImage(patternBlob, {
      format: 'image/png',
      pixelSize: 16,
      redactions: [{ x: 0, y: 0, width: 16, height: 16 }],
    }),
  )
  check(
    pixelated(0, 0)[0]! > 80 && pixelated(0, 0)[0]! < 180,
    'pixelation removes high-frequency detail',
  )
  eq(pixelated(0, 0), pixelated(15, 15), 'pixelation cell is constant')

  const dark = await pixels(
    await core.flattenImage(input, {
      format: 'image/png',
      theme: 'dark',
      strokeWidth: 4,
      click: { x: 40, y: 32, radius: 8 },
      edits: {
        annotations: [
          { type: 'arrow', x: 20, y: 40, toX: 60, toY: 40 },
          { type: 'text', x: 20, y: 58, text: 'Note' },
          { type: 'pin', x: 75, y: 16, text: '1' },
        ],
      },
    }),
  )
  check(
    dark(40, 24)[0] === 255 &&
      dark(40, 24)[1]! >= 100 &&
      dark(40, 24)[1]! <= 110,
    'marker uses dark accent',
  )
  eq(dark(40, 40), [255, 106, 61, 255], 'arrow uses token color')
  check(dark(75, 8)[0] === 255 && dark(75, 8)[1] === 106, 'pin rendered')
  let ink = false
  for (let y = 45; y < 60; y++)
    for (let x = 20; x < 58; x++) if (dark(x, y)[1]! < 230) ink = true
  check(ink, 'text annotation rendered in worker')

  for (const mime of ['image/webp', 'image/jpeg'] as const) {
    const source = await canvas.convertToBlob({ type: mime, quality: 1 })
    const output = await core.flattenImage(source)
    check(
      output.blob.type === 'image/webp' && output.blob.size > 0,
      `${mime} raster accepted and WebP encoded`,
    )
    await pixels(output)
  }
  for (const options of [
    { edits: { crop: { x: 500, y: 500, width: 10, height: 10 } } },
    { edits: { crop: { x: 0, y: 0, width: 0, height: 10 } } },
    {
      edits: {
        annotations: [
          {
            type: 'text' as const,
            x: 0,
            y: 0,
            text: 'Note',
            color: 'url(https://invalid.test/)',
          },
        ],
      },
    },
  ]) {
    let failed = false
    try {
      await core.prepareCapture(input, options)
    } catch (error) {
      failed =
        error instanceof core.CanvasImageError &&
        error.code === 'invalid_options'
    }
    check(failed, 'invalid crop/color cannot produce partial image output')
  }
  for (const bad of [
    new Blob(['<svg/>'], { type: 'image/svg+xml' }),
    new Blob(['private-invalid-image'], { type: 'image/png' }),
  ]) {
    let failed = false
    try {
      await core.flattenImage(bad)
    } catch (error) {
      failed =
        error instanceof core.CanvasImageError &&
        error.code === 'invalid_image' &&
        !String(error).includes('private')
    }
    check(failed, 'invalid/non-raster input rejected without data in errors')
  }
  const nativeEncode = OffscreenCanvas.prototype.convertToBlob
  OffscreenCanvas.prototype.convertToBlob = () =>
    Promise.reject(new Error('private-encoder-message'))
  try {
    let failed = false
    try {
      await core.prepareCapture(input)
    } catch (error) {
      failed =
        error instanceof core.CanvasImageError &&
        error.code === 'encode_failed' &&
        !String(error).includes('private')
    }
    check(failed, 'encoder failure cannot return raw or partial capture data')
  } finally {
    OffscreenCanvas.prototype.convertToBlob = nativeEncode
  }
  const nativeContext = OffscreenCanvas.prototype.getContext
  OffscreenCanvas.prototype.getContext = () => null
  try {
    let failed = false
    try {
      await core.prepareCapture(input)
    } catch (error) {
      failed =
        error instanceof core.CanvasImageError && error.code === 'unsupported'
    }
    check(failed, 'unavailable 2D context cannot return raw capture data')
  } finally {
    OffscreenCanvas.prototype.getContext = nativeContext
  }
  let binary = ''
  for (const byte of new Uint8Array(await patternBlob.arrayBuffer()))
    binary += String.fromCharCode(byte)
  const legacy = await composite(
    `data:image/png;base64,${btoa(binary)}`,
    [{ x: 0, y: 0, width: 8, height: 8 }],
    undefined,
    2,
  )
  const legacyBlob = await (await fetch(legacy)).blob()
  const legacyPixels = await pixels({ blob: legacyBlob, width: 16, height: 16 })
  check(
    legacyPixels(0, 0)[0]! > 50 && legacyPixels(0, 0)[0]! < 200,
    'extension adapter uses shared redaction',
  )
  let refusedRemote = false
  try {
    await composite('https://invalid.test/image.png', [])
  } catch {
    refusedRemote = true
  }
  check(refusedRemote, 'extension adapter refuses remote image URLs')
  return checks
}

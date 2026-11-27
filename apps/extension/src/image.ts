import {
  flattenImage,
  captureRectToPixels,
  assertImageDimensions,
} from '@stepdoc/core/canvas'
import type { Redaction } from '@stepdoc/schema'
import { CAPTURE_PREVIEW } from '@stepdoc/schema/capture'

export async function compositeFrame(
  dataUrl: string,
  masks: Redaction[],
  dpr: number,
) {
  if (!/^data:image\/(png|webp|jpeg);base64,/i.test(dataUrl))
    throw new Error('Invalid capture image')
  const input = await (await fetch(dataUrl)).blob()
  const image = await flattenImage(input, {
    sensitiveRects: masks.map((item) => item.rect),
    devicePixelRatio: dpr,
  })
  const redactions: Redaction[] = []
  for (const mask of masks) {
    const rect = captureRectToPixels(mask.rect, dpr, image.width, image.height)
    if (rect) redactions.push({ ...mask, rect, status: 'applied' })
  }
  return {
    dataUrl: await blobToDataUrl(image.blob),
    preview: await previewImage(image.blob).catch(() => undefined),
    width: image.width,
    height: image.height,
    redactions,
  }
}

/** Only pass already-masked local pixels. No full image crosses a controls RPC. */
export async function previewImage(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  let canvas: OffscreenCanvas | undefined
  try {
    assertImageDimensions(bitmap.width, bitmap.height)
    const ratio = Math.min(
      1,
      CAPTURE_PREVIEW.width / bitmap.width,
      CAPTURE_PREVIEW.height / bitmap.height,
    )
    canvas = new OffscreenCanvas(
      Math.max(1, Math.round(bitmap.width * ratio)),
      Math.max(1, Math.round(bitmap.height * ratio)),
    )
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Preview unavailable')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const preview = await canvas.convertToBlob({
      type: 'image/webp',
      quality: 0.8,
    })
    if (
      preview.type !== 'image/webp' ||
      !preview.size ||
      preview.size > CAPTURE_PREVIEW.maxBytes
    )
      throw new Error('Preview unavailable')
    return preview
  } finally {
    bitmap.close()
    if (canvas) canvas.width = canvas.height = 1
  }
}

export async function composite(
  dataUrl: string,
  sensitive: { x: number; y: number; width: number; height: number }[],
  click?: { x: number; y: number },
  dpr = 1,
) {
  // Capture data URLs are local raster data; never fetch a page or remote image here.
  if (!/^data:image\/(png|webp|jpeg);base64,/i.test(dataUrl))
    throw new Error('Invalid capture image')
  const input = await (await fetch(dataUrl)).blob()
  const image = await flattenImage(input, {
    sensitiveRects: sensitive,
    devicePixelRatio: dpr,
    click: click
      ? { x: click.x * dpr, y: click.y * dpr, radius: 20 * dpr }
      : null,
    strokeWidth: 5 * dpr,
  })
  return blobToDataUrl(image.blob)
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${blob.type};base64,${btoa(binary)}`
}

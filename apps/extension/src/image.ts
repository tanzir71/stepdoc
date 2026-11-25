import { flattenImage } from '@stepdoc/core/canvas'

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

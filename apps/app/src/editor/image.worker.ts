/// <reference lib="webworker" />
import {
  CanvasImageError,
  prepareCapture,
  type FlattenOptions,
} from '@stepdoc/core/canvas'
declare const self: DedicatedWorkerGlobalScope
export interface ImageRequest {
  id: number
  file: Blob
  options: FlattenOptions
  font: string
}
let font: Promise<void> | undefined
self.onmessage = (event: MessageEvent<ImageRequest>) => {
  const { id, file, options } = event.data
  void (async () => {
    try {
      font ??= (async () => {
        const face = new FontFace('Geist', `url("${event.data.font}")`, {
          weight: '100 900',
          style: 'normal',
        })
        self.fonts.add(await face.load())
      })().catch((error) => {
        font = undefined
        throw error
      })
      await font
      const result = await prepareCapture(file, {
        ...options,
        fontFamily: 'Geist',
      })
      self.postMessage({ id, result })
    } catch (error) {
      self.postMessage({
        id,
        error: error instanceof CanvasImageError ? error.code : 'render_failed',
      })
    }
  })()
}

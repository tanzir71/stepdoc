export type CaptureFrame<T, F = string> = {
  event: T
  frame: F
  reused: boolean
}
export class CaptureQueue<T, F = string> {
  private items: T[] = []
  private draining: Promise<void> | null = null
  private lastFrame: F | undefined
  private epoch = 0
  private privacyEpoch = 0
  constructor(
    private readonly capture: (event: T) => Promise<F>,
    private readonly persist: (
      result: CaptureFrame<T, F>,
    ) => Promise<void | boolean>,
  ) {}
  enqueue(event: T) {
    this.items.push(event)
    return this.drain()
  }
  clear() {
    this.items = []
    this.lastFrame = undefined
    this.epoch++
  }
  invalidateFrame() {
    this.lastFrame = undefined
    this.epoch++
    this.privacyEpoch++
  }
  primeFrame(frame: F) {
    if (this.draining || this.items.length)
      throw new Error('Capture queue is busy')
    this.lastFrame = frame
  }
  drain(): Promise<void> {
    if (this.draining) return this.draining
    this.draining = this.run().finally(() => {
      this.draining = null
      if (this.items.length) void this.drain()
    })
    return this.draining
  }
  private async run() {
    while (this.items.length) {
      const event = this.items.shift()!
      let attempts = 0
      while (true) {
        if (++attempts > 3)
          throw new Error('Capture privacy changed repeatedly')
        const epoch = this.epoch
        const privacyEpoch = this.privacyEpoch
        let frame: F,
          reused = false
        try {
          frame = await this.capture(event)
          if (privacyEpoch !== this.privacyEpoch) continue
          if (epoch === this.epoch) this.lastFrame = frame
        } catch (error) {
          if (privacyEpoch !== this.privacyEpoch) continue
          if (this.lastFrame === undefined) throw error
          frame = this.lastFrame
          reused = true
        }
        if ((await this.persist({ event, frame, reused })) !== false) break
      }
    }
  }
  get pending() {
    return this.items.length + (this.draining ? 1 : 0)
  }
}

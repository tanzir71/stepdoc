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
  constructor(
    private readonly capture: (event: T) => Promise<F>,
    private readonly persist: (result: CaptureFrame<T, F>) => Promise<void>,
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
      const epoch = this.epoch
      let frame: F,
        reused = false
      try {
        frame = await this.capture(event)
        if (epoch === this.epoch) this.lastFrame = frame
      } catch (error) {
        if (this.lastFrame === undefined) throw error
        frame = this.lastFrame
        reused = true
      }
      await this.persist({ event, frame, reused })
    }
  }
  get pending() {
    return this.items.length + (this.draining ? 1 : 0)
  }
}

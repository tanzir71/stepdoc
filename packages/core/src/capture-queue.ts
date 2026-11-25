export type CaptureFrame<T> = { event: T; frame: string; reused: boolean }
export class CaptureQueue<T> {
  private items: T[] = []
  private draining: Promise<void> | null = null
  private lastFrame = ''
  constructor(
    private readonly capture: () => Promise<string>,
    private readonly persist: (result: CaptureFrame<T>) => Promise<void>,
  ) {}
  enqueue(event: T) {
    this.items.push(event)
    return this.drain()
  }
  clear() {
    this.items = []
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
      let frame: string,
        reused = false
      try {
        frame = await this.capture()
        this.lastFrame = frame
      } catch (error) {
        if (!this.lastFrame) throw error
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

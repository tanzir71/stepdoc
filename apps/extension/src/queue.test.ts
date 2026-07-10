import { describe, expect, it, vi } from 'vitest'
import { CaptureQueue } from './queue'

describe('CaptureQueue', () => {
  it('preserves a rapid five-event burst', async () => {
    const saved: number[] = []
    const queue = new CaptureQueue<number>(
      async () => 'frame',
      async (result) => {
        saved.push(result.event)
      },
    )
    await Promise.all([1, 2, 3, 4, 5].map((event) => queue.enqueue(event)))
    await queue.drain()
    expect(saved).toEqual([1, 2, 3, 4, 5])
  })

  it('reuses the last frame after throttling', async () => {
    const capture = vi.fn().mockResolvedValueOnce('one').mockRejectedValueOnce(new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND'))
    const saved: { frame: string; reused: boolean }[] = []
    const queue = new CaptureQueue<number>(capture, async (result) => {
      saved.push(result)
    })
    await queue.enqueue(1)
    await queue.enqueue(2)
    expect(saved).toEqual([
      { event: 1, frame: 'one', reused: false },
      { event: 2, frame: 'one', reused: true },
    ])
  })

  it('does not drop events added during persistence', async () => {
    const saved: number[] = []
    const queue = new CaptureQueue<number>(
      async () => 'f',
      async (result) => {
        saved.push(result.event)
        if (result.event === 1) void queue.enqueue(2)
      },
    )
    await queue.enqueue(1)
    await queue.drain()
    expect(saved).toEqual([1, 2])
  })

  it('clears queued work on cancel', async () => {
    const saved: number[] = []
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queue = new CaptureQueue<number>(
      async () => {
        await gate
        return 'f'
      },
      async (result) => {
        saved.push(result.event)
      },
    )
    const draining = queue.enqueue(1)
    void queue.enqueue(2)
    queue.clear()
    release()
    await draining
    await queue.drain()
    expect(saved).toEqual([1])
  })

  it('surfaces a first-frame failure', async () => {
    const queue = new CaptureQueue<number>(
      async () => {
        throw Error('no frame')
      },
      async () => {},
    )
    await expect(queue.enqueue(1)).rejects.toThrow('no frame')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { CaptureQueue } from './capture-queue'

describe('CaptureQueue', () => {
  it('retries in-flight work after a new manual mask without storing the old image', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const capture = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        return 'old-mask-set'
      })
      .mockResolvedValue('new-mask-set')
    const saved: unknown[] = []
    const queue = new CaptureQueue<number>(capture, async (result) => {
      saved.push(result)
    })
    queue.primeFrame('old-cache')
    const draining = queue.enqueue(1)
    void queue.enqueue(2)
    queue.invalidateFrame()
    release()
    await draining
    expect(saved).toEqual([
      { event: 1, frame: 'new-mask-set', reused: false },
      { event: 2, frame: 'new-mask-set', reused: false },
    ])
    expect(capture).toHaveBeenCalledTimes(3)
  })
  it('retries when a serialized writer rejects stale privacy and never falls back across invalidation', async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce('old')
      .mockResolvedValueOnce('new')
    const saved: string[] = []
    let first = true
    const queue = new CaptureQueue<number>(capture, async ({ frame }) => {
      if (first) {
        first = false
        queue.invalidateFrame()
        return false
      }
      saved.push(frame)
    })
    await queue.enqueue(1)
    expect(saved).toEqual(['new'])
    queue.invalidateFrame()
    capture.mockRejectedValue(new Error('No fresh frame'))
    await expect(queue.enqueue(2)).rejects.toThrow('No fresh frame')
  })
  it('bounds retries if privacy keeps changing', async () => {
    const queue = new CaptureQueue<number>(
      async () => {
        queue.invalidateFrame()
        return 'invalidated'
      },
      async () => {
        throw new Error('Must not store')
      },
    )
    await expect(queue.enqueue(1)).rejects.toThrow(
      'Capture privacy changed repeatedly',
    )
  })
  it('reuses the primed processed image together with its applied-mask provenance', async () => {
    const frame = {
      data: 'redacted-only',
      masks: [{ x: 1, y: 2, width: 3, height: 4 }],
    }
    const saved: unknown[] = []
    const queue = new CaptureQueue<number, typeof frame>(
      async () => {
        throw new Error('Throttled')
      },
      async (result) => {
        saved.push(result)
      },
    )
    queue.primeFrame(frame)
    await queue.enqueue(1)
    expect(saved).toEqual([{ event: 1, frame, reused: true }])
    queue.clear()
    await expect(queue.enqueue(2)).rejects.toThrow('Throttled')
  })
  it('rejects priming while capture is in flight', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queue = new CaptureQueue<number>(
      async () => {
        await gate
        return 'redacted'
      },
      async () => {},
    )
    const running = queue.enqueue(1)
    expect(() => queue.primeFrame('new')).toThrow('busy')
    release()
    await running
  })
  it('passes event context to capture and never reuses a frame across clear', async () => {
    const capture = vi
      .fn()
      .mockResolvedValueOnce('redacted-frame')
      .mockRejectedValueOnce(new Error('No screenshot'))
    const queue = new CaptureQueue<number>(capture, async () => {})
    await queue.enqueue(1)
    expect(capture).toHaveBeenCalledWith(1)
    queue.clear()
    await expect(queue.enqueue(2)).rejects.toThrow('No screenshot')
  })
  it('does not repopulate the cache from an in-flight capture after clear', async () => {
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const capture = vi
      .fn()
      .mockImplementationOnce(async () => {
        await gate
        return 'old-redacted'
      })
      .mockRejectedValueOnce(new Error('No new screenshot'))
    const queue = new CaptureQueue<number>(capture, async () => {})
    const running = queue.enqueue(1)
    queue.clear()
    release()
    await running
    await expect(queue.enqueue(2)).rejects.toThrow('No new screenshot')
  })
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
    const capture = vi
      .fn()
      .mockResolvedValueOnce('one')
      .mockRejectedValueOnce(
        new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND'),
      )
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForCaptureSources } from './source-ready'

afterEach(() => vi.useRealTimers())
describe('bounded source readiness', () => {
  it('waits for the explicit producer acknowledgement and clears its deadline', async () => {
    vi.useFakeTimers()
    let acknowledge!: (value: unknown) => void
    let settled = false
    const ready = waitForCaptureSources([
      Promise.resolve({ ok: true }),
      new Promise((resolve) => {
        acknowledge = resolve
      }),
    ]).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1999)
    expect(settled).toBe(false)
    acknowledge({ ok: true })
    await ready
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([undefined, { ok: false }, { ok: 'true' }])(
    'rejects an absent or unsuccessful acknowledgement %j',
    async (response) => {
      await expect(
        waitForCaptureSources([
          Promise.resolve({ ok: true }),
          Promise.resolve(response),
        ]),
      ).rejects.toThrow('Capture source unavailable')
    },
  )
  it('bounds a non-responsive producer to two seconds and ignores a late reply', async () => {
    vi.useFakeTimers()
    let acknowledge!: (value: unknown) => void
    const ready = waitForCaptureSources([
      Promise.resolve({ ok: true }),
      new Promise((resolve) => {
        acknowledge = resolve
      }),
    ])
    const failed = expect(ready).rejects.toThrow(
      'Capture source unavailable',
    )
    await vi.advanceTimersByTimeAsync(2000)
    await failed
    acknowledge({ ok: true })
    await vi.runAllTimersAsync()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects an empty producer set', async () => {
    await expect(waitForCaptureSources([])).rejects.toThrow(
      'Capture source unavailable',
    )
  })
  it('does not expose a native transport error', async () => {
    await expect(
      waitForCaptureSources([Promise.reject(new Error('PRIVATE_NATIVE'))]),
    ).rejects.toThrow(/^Capture source unavailable$/)
  })
})

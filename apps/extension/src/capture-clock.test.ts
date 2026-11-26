import { describe, expect, it } from 'vitest'
import {
  captureClockSchema,
  capturePillControlSchema,
  capturePillViewSchema,
} from '@stepdoc/schema/capture'
import {
  captureElapsed,
  formatCaptureTime,
  startClock,
  stopClock,
} from './capture-clock'

describe('active recording clock and pill protocol', () => {
  it('counts active segments only across pause, resume, stop and reload', () => {
    const first = startClock(undefined, 1_000)
    expect(captureElapsed(first, 3_500)).toBe(2_500)
    const paused = stopClock(first, 3_500)
    expect(captureElapsed(paused, 120_000)).toBe(2_500)
    const resumed = startClock(JSON.parse(JSON.stringify(paused)), 120_000)
    expect(captureElapsed(resumed, 121_500)).toBe(4_000)
    expect(stopClock(resumed, 121_500)).toEqual({
      elapsedMs: 4_000,
      runningSince: null,
    })
    expect(first).toEqual({ elapsedMs: 0, runningSince: 1_000 })
  })
  it('handles clock rollback and repeated stop without negative or double time', () => {
    expect(captureElapsed(startClock(undefined, 10_000), 9_000)).toBe(0)
    const stopped = stopClock({ elapsedMs: 5_000, runningSince: null }, 99_000)
    expect(stopClock(stopped, 100_000)).toEqual(stopped)
    expect(
      captureElapsed(
        { elapsedMs: Number.MAX_SAFE_INTEGER, runningSince: 0 },
        1,
      ),
    ).toBe(Number.MAX_SAFE_INTEGER)
  })
  it('formats elapsed minutes and hours without a 24-hour wrap', () => {
    expect(
      [0, 41_999, 60_000, 3_599_999, 3_600_000, 90_061_000].map(
        formatCaptureTime,
      ),
    ).toEqual(['00:00', '00:41', '01:00', '59:59', '01:00:00', '25:01:01'])
  })
  it('rejects extra page data, nonfinite clocks, malformed sessions and commands', () => {
    const sessionId = '09cd3706-3fe8-4714-96d0-925f70868b66'
    expect(
      capturePillControlSchema.parse({
        type: 'CAPTURE_PILL_CONTROL',
        sessionId,
        action: 'pause',
      }).action,
    ).toBe('pause')
    expect(
      capturePillControlSchema.safeParse({
        type: 'CAPTURE_PILL_CONTROL',
        sessionId,
        action: 'pause',
        value: 'PRIVATE_TYPED',
      }).success,
    ).toBe(false)
    expect(
      capturePillControlSchema.safeParse({
        type: 'CAPTURE_PILL_CONTROL',
        sessionId: 'bad',
        action: 'stop',
      }).success,
    ).toBe(false)
    expect(
      captureClockSchema.safeParse({ elapsedMs: -1, runningSince: null })
        .success,
    ).toBe(false)
    expect(
      captureClockSchema.safeParse({ elapsedMs: 0, runningSince: Infinity })
        .success,
    ).toBe(false)
    expect(
      capturePillViewSchema.safeParse({
        sessionId,
        phase: 'recording',
        count: 501,
      }).success,
    ).toBe(false)
    expect(
      capturePillViewSchema.safeParse({
        sessionId,
        phase: 'recording',
        count: 1,
        screenshot: 'PRIVATE_PIXELS',
      }).success,
    ).toBe(false)
  })
})

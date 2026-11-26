import type { CaptureClock } from '@stepdoc/schema/capture'

export function captureElapsed(clock: CaptureClock, now = Date.now()): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    clock.elapsedMs +
      (clock.runningSince === null ? 0 : Math.max(0, now - clock.runningSince)),
  )
}
export function stopClock(
  clock?: CaptureClock,
  now = Date.now(),
): CaptureClock {
  return {
    elapsedMs: clock ? captureElapsed(clock, now) : 0,
    runningSince: null,
  }
}
export function startClock(
  clock?: CaptureClock,
  now = Date.now(),
): CaptureClock {
  return { ...stopClock(clock, now), runningSince: now }
}
export function formatCaptureTime(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000)
  const part = (value: number) => String(value).padStart(2, '0')
  return `${seconds >= 3_600 ? `${part(Math.floor(seconds / 3_600))}:` : ''}${part(Math.floor(seconds / 60) % 60)}:${part(seconds % 60)}`
}

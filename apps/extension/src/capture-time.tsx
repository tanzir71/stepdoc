import { useEffect, useState } from 'react'
import type { CaptureClock } from '@stepdoc/schema/capture'
import { captureElapsed, formatCaptureTime } from './capture-clock'

export function CaptureTime({ clock }: { clock?: CaptureClock }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    setNow(Date.now())
    if (!clock || clock.runningSince === null) return
    const tick = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(tick)
  }, [clock?.elapsedMs, clock?.runningSince])
  const elapsed = clock ? captureElapsed(clock, now) : undefined
  return (
    <time
      role="timer"
      aria-live="off"
      aria-label="Active recording time"
      data-sd="capture-time"
      dateTime={
        elapsed === undefined ? undefined : `PT${Math.floor(elapsed / 1_000)}S`
      }
    >
      {elapsed === undefined ? '--:--' : formatCaptureTime(elapsed)}
    </time>
  )
}

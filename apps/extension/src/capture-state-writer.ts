/** Serialize private capture snapshots and their durable ordering stamp together. */
export function captureStateWriter<T extends object>(io: {
  readRevision: () => Promise<unknown>
  write: (value: T & { captureStateRevision: number }) => Promise<void>
  now?: () => number
}) {
  let writes = Promise.resolve()
  let last = 0
  return (value: T): Promise<number> => {
    const next = writes.then(async () => {
      const raw = await io.readRevision()
      const persisted =
        typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
          ? raw
          : 0
      const clock = Math.max(0, Math.floor((io.now ?? Date.now)()))
      const revision =
        Math.max(persisted, last, Number.isSafeInteger(clock) ? clock : 0) + 1
      if (!Number.isSafeInteger(revision))
        throw new Error('Capture state unavailable')
      await io.write({ ...value, captureStateRevision: revision })
      last = revision
      return revision
    })
    writes = next.then(
      () => {},
      () => {},
    )
    return next
  }
}

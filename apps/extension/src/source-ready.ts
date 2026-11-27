const unavailable = () => new Error('Capture source unavailable')

/** Bound the producer handshake while the capture state writer is held. */
export async function waitForCaptureSources(
  requests: readonly Promise<unknown>[],
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    if (!requests.length) throw unavailable()
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(unavailable()), 2000)
    })
    await Promise.race([
      Promise.all(
        requests.map(async (request) => {
          const ready = await request
          if (
            typeof ready !== 'object' ||
            ready === null ||
            !('ok' in ready) ||
            ready.ok !== true
          )
            throw unavailable()
        }),
      ),
      deadline,
    ])
  } catch {
    throw unavailable()
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

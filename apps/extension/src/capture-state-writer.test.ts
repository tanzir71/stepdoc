import { describe, expect, it, vi } from 'vitest'
import { captureStateWriter } from './capture-state-writer'

describe('durable recorder snapshot ordering', () => {
  it('commits a snapshot and its ordering stamp together, serializing competing writers', async () => {
    let persisted = 19
    const snapshots: Array<{
      recording: boolean
      captureStateRevision: number
    }> = []
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = captureStateWriter<{
      recording: boolean
      captureStateRevision?: number
    }>({
      readRevision: async () => persisted,
      now: () => 5,
      write: async (value) => {
        snapshots.push(value)
        if (snapshots.length === 1) await held
        persisted = value.captureStateRevision
      },
    })
    const first = write({ recording: false, captureStateRevision: 999 })
    const second = write({ recording: true })
    await vi.waitFor(() => expect(snapshots).toHaveLength(1))
    expect(persisted).toBe(19)
    release()
    expect(await Promise.all([first, second])).toEqual([20, 21])
    expect(snapshots).toEqual([
      { recording: false, captureStateRevision: 20 },
      { recording: true, captureStateRevision: 21 },
    ])
  })

  it('upgrades old caches and preserves ordering across worker restarts and a backwards clock', async () => {
    let persisted: number | undefined
    const io = {
      readRevision: async () => persisted,
      write: async (value: { captureStateRevision: number }) => {
        persisted = value.captureStateRevision
      },
    }
    expect(await captureStateWriter({ ...io, now: () => 100 })({})).toBe(101)
    expect(await captureStateWriter({ ...io, now: () => 20 })({})).toBe(102)
  })

  it('does not publish a failed write and keeps the writer usable for a later operation', async () => {
    let attempts = 0
    const committed: number[] = []
    const write = captureStateWriter({
      readRevision: async () => 10,
      now: () => 5,
      write: async (value) => {
        if (++attempts === 1) throw new Error('Fixture failure')
        committed.push(value.captureStateRevision)
      },
    })
    await expect(write({})).rejects.toThrow('Fixture failure')
    expect(committed).toEqual([])
    expect(await write({})).toBe(11)
    expect(committed).toEqual([11])
  })

  it('repairs an invalid cache counter without retaining it, and refuses unsafe overflow', async () => {
    const writes = vi.fn(async () => {})
    expect(
      await captureStateWriter({
        readRevision: async () => 'PRIVATE_CORRUPTION',
        now: () => 100,
        write: writes,
      })({}),
    ).toBe(101)
    expect(JSON.stringify(writes.mock.calls)).not.toContain(
      'PRIVATE_CORRUPTION',
    )
    writes.mockClear()
    await expect(
      captureStateWriter({
        readRevision: async () => Number.MAX_SAFE_INTEGER,
        write: writes,
      })({}),
    ).rejects.toThrow('Capture state unavailable')
    expect(writes).not.toHaveBeenCalled()
  })
})

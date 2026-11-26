import {
  captureDestinationSchema,
  captureReceiptSchema,
  type CaptureDestination,
  type ServerDestination,
  type CaptureReceipt,
  type CaptureDestinationErrorCode,
} from '@stepdoc/schema/capture-destination'
import {
  CaptureHttpClient,
  HttpAdapter,
  storageApiUrl,
} from '@stepdoc/storage/http'
import { StorageError, type GuideSummary } from '@stepdoc/storage'
import type { ConnectionVault } from './connection-vault'
import { captureUploadGuide, type CaptureDraft } from './review'

export class DestinationFailure extends Error {
  constructor(readonly code: CaptureDestinationErrorCode) {
    super(`Capture destination operation failed: ${code}`)
    this.name = 'DestinationFailure'
  }
}
export function destinationError(error: unknown): DestinationFailure {
  if (error instanceof DestinationFailure) return error
  if (error instanceof StorageError) {
    if (['unauthorized', 'forbidden'].includes(error.code))
      return new DestinationFailure('revoked')
    if (error.code === 'upload_too_large')
      return new DestinationFailure('too_large')
    if (error.code === 'redaction_open')
      return new DestinationFailure('redaction_open')
    if (['invalid_blob', 'invalid_guide', 'corrupt_data'].includes(error.code))
      return new DestinationFailure('invalid_capture')
    if (error.code === 'closed') return new DestinationFailure('cancelled')
    return new DestinationFailure('unavailable')
  }
  return new DestinationFailure('storage_unavailable')
}
export function destinationChoice(value: unknown): CaptureDestination {
  if (value === undefined) return { kind: 'browser' }
  const result = captureDestinationSchema.safeParse(value)
  if (!result.success) throw new DestinationFailure('connection_changed')
  return result.data
}
export class CaptureDestinations {
  constructor(private readonly vault: ConnectionVault) {}
  async validate(input: CaptureDestination): Promise<CaptureDestination> {
    const choice = destinationChoice(input)
    if (choice.kind === 'browser') return choice
    await this.connection(choice)
    return choice
  }
  private async connection(choice: ServerDestination) {
    let state
    try {
      state = await this.vault.read()
    } catch {
      throw new DestinationFailure('storage_unavailable')
    }
    if (!state.connection) throw new DestinationFailure('no_connection')
    if (
      state.generation !== choice.generation ||
      state.connection.server !== choice.server ||
      state.connection.deviceId !== choice.deviceId
    )
      throw new DestinationFailure('connection_changed')
    if (state.connection.status === 'revoked')
      throw new DestinationFailure('revoked')
    try {
      if (storageApiUrl(choice.server) !== choice.server) throw new Error()
    } catch {
      throw new DestinationFailure('connection_changed')
    }
    return state.connection
  }
  private root(choice: ServerDestination) {
    return new URL('../../', choice.server)
  }
  async editor(input: CaptureReceipt, sessionId: string): Promise<string> {
    const result = captureReceiptSchema.safeParse(input)
    if (!result.success || result.data.id !== `capture-${sessionId}`)
      throw new DestinationFailure('stale')
    await this.connection(result.data.destination)
    return new URL(
      `g/${result.data.id}/edit`,
      this.root(result.data.destination),
    ).href
  }
  async recent(
    choice: ServerDestination,
  ): Promise<Array<GuideSummary & { editUrl: string }>> {
    await this.connection(choice)
    let adapter: HttpAdapter | undefined,
      lookupFailure: DestinationFailure | undefined
    try {
      adapter = await HttpAdapter.open(choice.server, {
        readOnly: true,
        auth: {
          kind: 'bearer',
          token: async () => {
            try {
              return (await this.connection(choice)).token
            } catch (error) {
              lookupFailure = destinationError(error)
              throw error
            }
          },
        },
      })
      const page = await adapter.listGuides()
      return page.items.slice(0, 3).map((guide) => ({
        ...guide,
        editUrl: new URL(`g/${guide.id}/edit`, this.root(choice)).href,
      }))
    } catch (error) {
      throw lookupFailure ?? destinationError(error)
    } finally {
      adapter?.close()
    }
  }
  async upload(
    draft: CaptureDraft,
    choice: ServerDestination,
    operation: {
      signal: AbortSignal
      guard: () => Promise<void>
      started: () => Promise<void>
    },
  ): Promise<CaptureReceipt> {
    const guard = async () => {
      if (operation.signal.aborted) throw new DestinationFailure('cancelled')
      await operation.guard()
      await this.connection(choice)
      if (operation.signal.aborted) throw new DestinationFailure('cancelled')
    }
    let client: CaptureHttpClient | undefined,
      lookupFailure: DestinationFailure | undefined
    try {
      await guard()
      const guide = await captureUploadGuide(draft)
      await guard()
      client = await CaptureHttpClient.open(choice.server, {
        signal: operation.signal,
        token: async () => {
          try {
            await guard()
            return (await this.connection(choice)).token
          } catch (error) {
            lookupFailure = destinationError(error)
            throw error
          }
        },
      })
      const result = await client.upload(guide, async () => {
        await guard()
        await operation.started()
      })
      await guard()
      return { id: result.guide.id, destination: choice }
    } catch (error) {
      if (operation.signal.aborted) throw new DestinationFailure('cancelled')
      throw lookupFailure ?? destinationError(error)
    } finally {
      client?.close()
    }
  }
}

import { HttpAdapter, claimPairing, storageApiUrl } from '@stepdoc/storage/http'
import { StorageError } from '@stepdoc/storage'
import {
  pairingStateSchema,
  type PairingState,
  type PairingCommand,
  type PairingErrorCode,
  type PrivateConnection,
} from '@stepdoc/schema/pairing'
import { PairingFailure, type ConnectionVault } from './connection-vault'

type Attempt = {
  id: string
  kind: 'connect' | 'test'
  controller: AbortController
}
type Dependencies = {
  vault: ConnectionVault
  extensionId: string
  deviceName: string
  canChange: () => Promise<boolean>
  changed: (state: PairingState) => void | Promise<void>
}
const mapped = (error: unknown): PairingErrorCode =>
  error instanceof PairingFailure
    ? error.code
    : error instanceof StorageError
      ? error.code === 'invalid_pairing'
        ? 'invalid_code'
        : error.code === 'invalid_options'
          ? 'invalid_server'
          : ['unauthorized', 'forbidden'].includes(error.code)
            ? 'revoked'
            : error.code === 'corrupt_data'
              ? 'invalid_server'
              : 'connection_unavailable'
      : 'storage_unavailable'
export class PairingController {
  #attempt?: Attempt
  #forgetting = false
  #error: PairingErrorCode | null = null
  #epoch = crypto.randomUUID()
  #sequence = 0
  constructor(private readonly dependencies: Dependencies) {}
  get busy() {
    return !!this.#attempt || this.#forgetting
  }
  async state(): Promise<PairingState> {
    const sequence = ++this.#sequence
    try {
      const state = await this.dependencies.vault.read(),
        connection = state.connection
      return pairingStateSchema.parse({
        epoch: this.#epoch,
        sequence,
        generation: state.generation,
        connection: connection
          ? {
              server: connection.server,
              deviceId: connection.deviceId,
              deviceName: connection.deviceName,
              scopes: connection.scopes,
              pairedAt: connection.pairedAt,
              checkedAt: connection.checkedAt,
              status: connection.status,
            }
          : null,
        pending: this.#attempt
          ? { id: this.#attempt.id, kind: this.#attempt.kind }
          : null,
        error: this.#error,
      })
    } catch {
      return {
        epoch: this.#epoch,
        sequence,
        generation: null,
        connection: null,
        pending: null,
        error: 'storage_unavailable',
      }
    }
  }
  private notify() {
    void this.state()
      .then((state) => this.dependencies.changed(state))
      .catch(() => {})
  }
  private current(attempt: Attempt) {
    return this.#attempt === attempt && !attempt.controller.signal.aborted
  }
  private stop() {
    this.#attempt?.controller.abort()
    this.#attempt = undefined
  }
  async handle(
    command: PairingCommand,
  ): Promise<{ ok: boolean; error?: PairingErrorCode; state?: PairingState }> {
    if (command.type === 'PAIR_STATUS') {
      const state = await this.state()
      if (
        state.generation &&
        state.error === 'storage_unavailable' &&
        !this.busy
      ) {
        this.#error = null
        state.error = null
      }
      return { ok: true, state }
    }
    if (command.type === 'PAIR_CANCEL') {
      if (this.#attempt?.id !== command.attemptId)
        return { ok: false, error: 'conflict' }
      this.stop()
      this.#error = 'cancelled'
      this.notify()
      return { ok: true }
    }
    if (command.type === 'PAIR_FORGET') {
      if (this.#forgetting) return { ok: false, error: 'busy' }
      this.#forgetting = true
      try {
        if (!(await this.dependencies.canChange()))
          throw new PairingFailure('busy')
        this.stop()
        await this.dependencies.vault.forget(
          command.expectedGeneration,
          () => this.#forgetting && !this.#attempt,
        )
        this.#error = null
        this.notify()
        return { ok: true }
      } catch (error) {
        this.#error = mapped(error)
        this.notify()
        return { ok: false, error: this.#error }
      } finally {
        this.#forgetting = false
        this.notify()
      }
    }
    if (this.busy) return { ok: false, error: 'busy' }
    const attempt: Attempt = {
      id: command.attemptId,
      kind: command.type === 'PAIR_CONNECT' ? 'connect' : 'test',
      controller: new AbortController(),
    }
    this.#attempt = attempt
    this.#error = null
    this.notify()
    try {
      if (!(await this.dependencies.canChange()))
        throw new PairingFailure('busy')
      const before = await this.dependencies.vault.read()
      if (before.generation !== command.expectedGeneration)
        throw new PairingFailure('conflict')
      if (!this.current(attempt)) throw new PairingFailure('cancelled')
      if (command.type === 'PAIR_CONNECT') {
        const server = storageApiUrl(command.server)
        const issued = await claimPairing(
          server,
          {
            code: command.code,
            deviceName: this.dependencies.deviceName,
            extensionId: this.dependencies.extensionId,
          },
          { signal: attempt.controller.signal },
        )
        if (!this.current(attempt)) throw new PairingFailure('cancelled')
        await this.dependencies.vault.write(
          before.generation,
          {
            server,
            deviceId: issued.id,
            deviceName: this.dependencies.deviceName,
            token: issued.token,
            scopes: issued.scopes,
            pairedAt: new Date().toISOString(),
            checkedAt: null,
            status: 'paired',
          },
          () => this.current(attempt),
        )
      } else {
        const connection = before.connection
        if (!connection) throw new PairingFailure('conflict')
        let adapter: HttpAdapter | undefined,
          status: PrivateConnection['status'] = 'ready',
          failure: PairingErrorCode | null = null
        try {
          adapter = await HttpAdapter.open(connection.server, {
            auth: { kind: 'bearer', token: () => connection.token },
            readOnly: true,
            signal: attempt.controller.signal,
          })
          await adapter.listGuides()
        } catch (error) {
          failure = mapped(error)
          status = failure === 'revoked' ? 'revoked' : 'unavailable'
        } finally {
          adapter?.close()
        }
        if (!this.current(attempt)) throw new PairingFailure('cancelled')
        await this.dependencies.vault.write(
          before.generation,
          { ...connection, status, checkedAt: new Date().toISOString() },
          () => this.current(attempt),
        )
        if (failure) throw new PairingFailure(failure)
      }
      return { ok: true }
    } catch (error) {
      const code = this.current(attempt) ? mapped(error) : 'cancelled'
      if (this.#attempt === attempt) this.#error = code
      return { ok: false, error: code }
    } finally {
      if (this.#attempt === attempt) {
        this.#attempt = undefined
        this.notify()
      }
    }
  }
}

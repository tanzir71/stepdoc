import {
  connectionVaultSchema,
  type ConnectionVaultState,
  type PrivateConnection,
  type PairingErrorCode,
} from '@stepdoc/schema/pairing'
import { storageApiUrl } from '@stepdoc/storage/http'

export class PairingFailure extends Error {
  constructor(readonly code: PairingErrorCode) {
    super(`Pairing operation failed: ${code}`)
    this.name = 'PairingFailure'
  }
}
export interface ConnectionVault {
  read(): Promise<ConnectionVaultState>
  write(
    expected: string,
    connection: PrivateConnection,
    guard: () => boolean,
  ): Promise<ConnectionVaultState>
  forget(
    expected: string | null,
    guard: () => boolean,
  ): Promise<ConnectionVaultState>
}
export const CONNECTION_DATABASE = 'stepdoc-connections-v1'
const fresh = (): ConnectionVaultState => ({
  version: 1,
  generation: crypto.randomUUID(),
  connection: null,
})
function checked(value: unknown): ConnectionVaultState {
  try {
    const state = connectionVaultSchema.parse(value)
    if (
      state.connection &&
      storageApiUrl(state.connection.server) !== state.connection.server
    )
      throw new Error()
    return state
  } catch {
    throw new PairingFailure('storage_unavailable')
  }
}
/** Extension-origin IDB, separate from chrome.storage and every guide/export. */
export class IndexedDbConnectionVault implements ConnectionVault {
  constructor(private readonly name = CONNECTION_DATABASE) {}
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, 1)
      let settled = false
      request.onupgradeneeded = () => request.result.createObjectStore('state')
      request.onsuccess = () => {
        if (settled) request.result.close()
        else resolve(request.result)
      }
      request.onerror = request.onblocked = () => {
        settled = true
        reject(new PairingFailure('storage_unavailable'))
      }
    })
  }
  private async change(
    work: (raw: unknown) => { state: ConnectionVaultState; write: boolean },
  ): Promise<ConnectionVaultState> {
    let db: IDBDatabase
    try {
      db = await this.open()
    } catch {
      throw new PairingFailure('storage_unavailable')
    }
    return new Promise((resolve, reject) => {
      let failure: PairingFailure | undefined,
        result: ConnectionVaultState | undefined
      let tx: IDBTransaction
      try {
        tx = db.transaction('state', 'readwrite', { durability: 'strict' })
      } catch {
        db.close()
        reject(new PairingFailure('storage_unavailable'))
        return
      }
      const store = tx.objectStore('state')
      const request = store.get('current')
      request.onsuccess = () => {
        try {
          const next = work(request.result as unknown)
          result = checked(next.state)
          if (next.write) store.put(result, 'current')
        } catch (error) {
          failure =
            error instanceof PairingFailure
              ? error
              : new PairingFailure('storage_unavailable')
          tx.abort()
        }
      }
      tx.oncomplete = () => {
        db.close()
        resolve(result!)
      }
      tx.onabort = () => {
        db.close()
        reject(failure ?? new PairingFailure('storage_unavailable'))
      }
      tx.onerror = () => {}
    })
  }
  read(): Promise<ConnectionVaultState> {
    return this.change((raw) => ({
      state: raw === undefined ? fresh() : checked(raw),
      write: raw === undefined,
    }))
  }
  write(
    expected: string,
    connection: PrivateConnection,
    guard: () => boolean,
  ): Promise<ConnectionVaultState> {
    const copy = checked({
      version: 1,
      generation: crypto.randomUUID(),
      connection,
    }).connection!
    return this.change((raw) => {
      const current = checked(raw)
      if (current.generation !== expected) throw new PairingFailure('conflict')
      if (!guard()) throw new PairingFailure('cancelled')
      return {
        state: {
          version: 1,
          generation: crypto.randomUUID(),
          connection: copy,
        },
        write: true,
      }
    })
  }
  forget(
    expected: string | null,
    guard: () => boolean,
  ): Promise<ConnectionVaultState> {
    return this.change((raw) => {
      let current: ConnectionVaultState | undefined
      try {
        current = checked(raw)
      } catch {
        if (expected !== null) throw new PairingFailure('conflict')
      }
      if (current && current.generation !== expected)
        throw new PairingFailure('conflict')
      if (!guard()) throw new PairingFailure('cancelled')
      return { state: fresh(), write: true }
    })
  }
}

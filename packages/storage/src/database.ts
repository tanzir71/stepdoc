import { StorageError, storageError } from './adapter'

export const DATABASE_VERSION = 1
export function openDatabase(name: string): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined')
    return Promise.reject(new StorageError('unsupported'))
  return new Promise((resolve, reject) => {
    let settled = false
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(name, DATABASE_VERSION)
    } catch (error) {
      reject(storageError(error))
      return
    }
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort()
        return
      }
      const db = request.result
      db.createObjectStore('guides', { keyPath: 'id' })
      const versions = db.createObjectStore('versions', {
        keyPath: ['guideId', 'version'],
      })
      versions.createIndex('guideId', 'guideId')
      const blobs = db.createObjectStore('blobs', { keyPath: 'key' })
      blobs.createIndex('guideId', 'guideId')
    }
    request.onblocked = () => {
      settled = true
      reject(new StorageError('blocked'))
    }
    request.onerror = () => {
      settled = true
      reject(storageError(request.error))
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
  })
}

/** Only IndexedDB requests may be awaited inside work. Complete means committed. */
export function transaction<T>(
  db: IDBDatabase,
  names: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction(
        names,
        mode,
        mode === 'readwrite' ? { durability: 'strict' } : undefined,
      )
    } catch (error) {
      reject(storageError(error))
      return
    }
    let output: T
    let finished = false
    let failure: StorageError | undefined
    tx.oncomplete = () =>
      finished
        ? resolve(output)
        : reject(new StorageError('storage_unavailable'))
    tx.onabort = () => reject(failure ?? storageError(tx.error))
    // Let request failures abort the entire transaction (including prior queued writes).
    tx.onerror = () => {}
    const fail = (error: unknown) => {
      failure = storageError(error)
      try {
        tx.abort()
      } catch {
        reject(failure)
      }
    }
    try {
      void work(tx)
        .then((result) => {
          output = result
          finished = true
        })
        .catch(fail)
    } catch (error) {
      fail(error)
    }
  })
}
export function request<T>(input: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    input.onsuccess = () => resolve(input.result)
    input.onerror = () => reject(storageError(input.error))
  })
}

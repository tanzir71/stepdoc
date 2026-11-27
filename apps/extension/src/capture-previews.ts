import { CAPTURE_PREVIEW } from '@stepdoc/schema/capture'

export const CAPTURE_PREVIEW_DATABASE = 'stepdoc-capture-previews-v1'
/** A disposable extension-origin cache; full-resolution captures stay elsewhere. */
export class CapturePreviews {
  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CAPTURE_PREVIEW_DATABASE, 1)
      let failed = false
      request.onupgradeneeded = () =>
        request.result.createObjectStore('previews')
      request.onsuccess = () => {
        if (failed) request.result.close()
        else resolve(request.result)
      }
      request.onerror = request.onblocked = () => {
        failed = true
        reject(new Error('Preview unavailable'))
      }
    })
  }
  private async transaction<T>(
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.open()
    return new Promise((resolve, reject) => {
      let tx: IDBTransaction
      let request: IDBRequest<T>
      try {
        tx = db.transaction('previews', mode)
        request = work(tx.objectStore('previews'))
      } catch {
        db.close()
        reject(new Error('Preview unavailable'))
        return
      }
      tx.oncomplete = () => {
        db.close()
        resolve(request.result)
      }
      tx.onabort = () => {
        db.close()
        reject(new Error('Preview unavailable'))
      }
      tx.onerror = () => {}
    })
  }
  async get(sessionId: string, stepId: string): Promise<Blob | undefined> {
    const value: unknown = await this.transaction('readonly', (store) =>
      store.get([sessionId, stepId]),
    )
    return value instanceof Blob &&
      value.type === 'image/webp' &&
      value.size > 0 &&
      value.size <= CAPTURE_PREVIEW.maxBytes
      ? value
      : undefined
  }
  async put(sessionId: string, stepId: string, file: Blob): Promise<void> {
    if (
      file.type !== 'image/webp' ||
      !file.size ||
      file.size > CAPTURE_PREVIEW.maxBytes
    )
      throw new Error('Preview unavailable')
    await this.transaction('readwrite', (store) =>
      store.put(file, [sessionId, stepId]),
    )
  }
  async clear(): Promise<void> {
    await this.transaction('readwrite', (store) => store.clear())
  }
}

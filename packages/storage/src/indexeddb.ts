import type { Guide, GuideInput } from '@stepdoc/schema'
import {
  StorageError,
  storageError,
  type BlobUpload,
  type GuidePage,
  type GuideQuery,
  type GuideVersion,
  type StorageAdapter,
} from './adapter'
import { openDatabase, request, transaction } from './database'
import {
  guidePage,
  validateGuide,
  validateId,
  validateQuery,
  validateVersion,
} from './guides'

export const MAX_BLOB_BYTES = 64 * 1024 * 1024
export interface IndexedDbOptions {
  /** A private database/OPFS namespace, not a filesystem path. */
  databaseName?: string
  pageSize?: number
  blobStorage?: 'auto' | 'opfs' | 'indexeddb'
  now?: () => Date
}
interface GuideRecord {
  id: string
  doc: Guide
  deletedAt: string | null
}
interface VersionRecord extends GuideVersion {
  guideId: string
  doc: Guide
}
interface BlobRecord {
  key: string
  guideId: string
  stepId: string
  kind: BlobUpload['kind']
  mime: string
  bytes: number
  sha256: string
  backend: 'opfs' | 'indexeddb'
  fileName?: string
  data?: Blob
}

function recordGuide(record: GuideRecord | undefined): Guide {
  if (record === undefined) throw new StorageError('not_found')
  validateRecord(record)
  if (record.deletedAt !== null) throw new StorageError('not_found')
  const guide = validateGuide(record.doc, true)
  if (record.id !== guide.id) throw new StorageError('corrupt_data')
  return guide
}
function validateRecord(record: GuideRecord): void {
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.id !== 'string' ||
    (record.deletedAt !== null && typeof record.deletedAt !== 'string')
  )
    throw new StorageError('corrupt_data')
}
function validateKey(key: string): void {
  if (
    typeof key !== 'string' ||
    !/^blobs\/[a-f0-9-]{36}\.(png|webp)$/.test(key)
  )
    throw new StorageError('invalid_blob')
}
async function digest(blob: Blob): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}
async function validateBlob(upload: BlobUpload): Promise<Blob> {
  if (
    !upload ||
    typeof upload.stepId !== 'string' ||
    !upload.stepId ||
    !['original', 'rendered', 'thumb'].includes(upload.kind) ||
    !(upload.file instanceof Blob) ||
    !upload.file.size ||
    upload.file.size > MAX_BLOB_BYTES
  )
    throw new StorageError('invalid_blob')
  const file = upload.file
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const png =
    file.type === 'image/png' &&
    [137, 80, 78, 71, 13, 10, 26, 10].every(
      (value, index) => bytes[index] === value,
    )
  const webp =
    file.type === 'image/webp' &&
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  if (!png && !webp) throw new StorageError('invalid_blob')
  return file
}

export class IndexedDbAdapter implements StorageAdapter {
  readonly capabilities = Object.freeze({
    target: 'browser' as const,
    readOnly: false,
    versions: true,
    maxUploadBytes: MAX_BLOB_BYTES,
  })
  readonly blobBackend: 'opfs' | 'indexeddb'
  private closed = false
  private directory?: Promise<FileSystemDirectoryHandle>
  private constructor(
    private readonly db: IDBDatabase,
    private readonly options: Required<IndexedDbOptions>,
    backend: 'opfs' | 'indexeddb',
  ) {
    this.blobBackend = backend
    db.onversionchange = () => this.close()
    db.onclose = () => {
      this.closed = true
    }
  }

  static async open(options: IndexedDbOptions = {}): Promise<IndexedDbAdapter> {
    try {
      if (!options || typeof options !== 'object')
        throw new StorageError('invalid_options')
      options = {
        databaseName: options.databaseName,
        pageSize: options.pageSize,
        blobStorage: options.blobStorage,
        now: options.now,
      }
      if (
        (options.databaseName !== undefined &&
          (typeof options.databaseName !== 'string' ||
            !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(options.databaseName))) ||
        !Number.isInteger(options.pageSize ?? 50) ||
        (options.pageSize ?? 50) < 1 ||
        (options.pageSize ?? 50) > 200 ||
        (options.blobStorage !== undefined &&
          !['auto', 'opfs', 'indexeddb'].includes(options.blobStorage)) ||
        (options.now !== undefined && typeof options.now !== 'function')
      )
        throw new StorageError('invalid_options')
      if (
        typeof crypto === 'undefined' ||
        !crypto.subtle ||
        typeof crypto.randomUUID !== 'function'
      )
        throw new StorageError('unsupported')
      const settings = {
        databaseName: options.databaseName ?? 'stepdoc-browser-v1',
        pageSize: options.pageSize ?? 50,
        blobStorage: options.blobStorage ?? 'auto',
        now: options.now ?? (() => new Date()),
      }
      const hasOpfs =
        typeof navigator !== 'undefined' &&
        typeof navigator.storage?.getDirectory === 'function'
      if (settings.blobStorage === 'opfs' && !hasOpfs)
        throw new StorageError('unsupported')
      const backend =
        settings.blobStorage === 'indexeddb' || !hasOpfs ? 'indexeddb' : 'opfs'
      const db = await openDatabase(settings.databaseName)
      return new IndexedDbAdapter(db, settings, backend)
    } catch (error) {
      throw storageError(error)
    }
  }
  close(): void {
    this.closed = true
    this.db.close()
  }
  private ready(): void {
    if (this.closed) throw new StorageError('closed')
  }
  private at(): string {
    try {
      return this.options.now().toISOString()
    } catch {
      throw new StorageError('invalid_options')
    }
  }
  private run<T>(
    names: string[],
    mode: IDBTransactionMode,
    work: (tx: IDBTransaction) => Promise<T>,
  ): Promise<T> {
    this.ready()
    return transaction(this.db, names, mode, work)
  }
  async listGuides(query: GuideQuery = {}): Promise<GuidePage> {
    this.ready()
    try {
      validateQuery(query)
      query = {
        q: query.q,
        status: query.status,
        cursor: query.cursor,
        collection: query.collection,
      }
    } catch {
      throw new StorageError('invalid_query')
    }
    try {
      const rows = await this.run(['guides'], 'readonly', (tx) =>
        request<GuideRecord[]>(tx.objectStore('guides').getAll()),
      )
      for (const row of rows) validateRecord(row)
      return await guidePage(
        rows.filter((row) => row.deletedAt === null).map(recordGuide),
        query,
        this.options.pageSize,
      )
    } catch (error) {
      throw storageError(error)
    }
  }
  async getGuide(id: string): Promise<Guide> {
    validateId(id)
    return this.run(['guides'], 'readonly', async (tx) =>
      recordGuide(
        await request<GuideRecord | undefined>(
          tx.objectStore('guides').get(id),
        ),
      ),
    )
  }
  async createGuide(input: GuideInput): Promise<Guide> {
    const doc = validateGuide(input)
    doc.version = 1
    doc.updatedAt = this.at()
    return this.run(['guides', 'versions'], 'readwrite', async (tx) => {
      const store = tx.objectStore('guides')
      const existing = await request<GuideRecord | undefined>(store.get(doc.id))
      if (existing) {
        validateRecord(existing)
        const stored = validateGuide(existing.doc, true)
        if (stored.id !== doc.id) throw new StorageError('corrupt_data')
        throw new StorageError('conflict', stored.version)
      }
      await request(
        store.add({ id: doc.id, doc, deletedAt: null } satisfies GuideRecord),
      )
      await request(
        tx.objectStore('versions').add({
          guideId: doc.id,
          version: doc.version,
          at: doc.updatedAt,
          by: 'This device',
          summary: 'Created',
          doc,
        } satisfies VersionRecord),
      )
      return doc
    })
  }
  async saveGuide(input: GuideInput, ifMatch: number): Promise<Guide> {
    const doc = validateGuide(input)
    validateVersion(ifMatch)
    const at = this.at()
    return this.run(['guides', 'versions'], 'readwrite', async (tx) => {
      const store = tx.objectStore('guides')
      const current = recordGuide(
        await request<GuideRecord | undefined>(store.get(doc.id)),
      )
      if (ifMatch !== current.version || doc.version !== ifMatch)
        throw new StorageError('conflict', current.version)
      if (current.version === Number.MAX_SAFE_INTEGER)
        throw new StorageError('invalid_guide')
      doc.version = current.version + 1
      doc.createdAt = current.createdAt
      doc.updatedAt = at
      await request(
        store.put({ id: doc.id, doc, deletedAt: null } satisfies GuideRecord),
      )
      await request(
        tx.objectStore('versions').add({
          guideId: doc.id,
          version: doc.version,
          at,
          by: 'This device',
          summary: 'Saved',
          doc,
        } satisfies VersionRecord),
      )
      return doc
    })
  }
  async deleteGuide(id: string): Promise<void> {
    validateId(id)
    const at = this.at()
    return this.run(['guides'], 'readwrite', async (tx) => {
      const store = tx.objectStore('guides')
      const row = await request<GuideRecord | undefined>(store.get(id))
      if (!row) return
      validateRecord(row)
      if (row.deletedAt !== null) return
      const doc = recordGuide(row)
      await request(store.put({ id, doc, deletedAt: at } satisfies GuideRecord))
    })
  }
  async listVersions(id: string): Promise<GuideVersion[]> {
    validateId(id)
    return this.run(['guides', 'versions'], 'readonly', async (tx) => {
      recordGuide(
        await request<GuideRecord | undefined>(
          tx.objectStore('guides').get(id),
        ),
      )
      const versions = await request<VersionRecord[]>(
        tx.objectStore('versions').index('guideId').getAll(id),
      )
      return versions
        .sort((a, b) => b.version - a.version)
        .map((row) => {
          const doc = validateGuide(row.doc, true)
          if (
            doc.id !== id ||
            doc.version !== row.version ||
            row.guideId !== id ||
            typeof row.at !== 'string' ||
            typeof row.by !== 'string' ||
            typeof row.summary !== 'string'
          )
            throw new StorageError('corrupt_data')
          return {
            version: row.version,
            at: row.at,
            by: row.by,
            summary: row.summary,
          }
        })
    })
  }
  async getVersion(id: string, version: number): Promise<Guide> {
    validateId(id)
    validateVersion(version)
    return this.run(['guides', 'versions'], 'readonly', async (tx) => {
      recordGuide(
        await request<GuideRecord | undefined>(
          tx.objectStore('guides').get(id),
        ),
      )
      const row = await request<VersionRecord | undefined>(
        tx.objectStore('versions').get([id, version]),
      )
      if (!row) throw new StorageError('not_found')
      const doc = validateGuide(row.doc, true)
      if (row.guideId !== id || doc.id !== id || doc.version !== version)
        throw new StorageError('corrupt_data')
      return doc
    })
  }
  private files(): Promise<FileSystemDirectoryHandle> {
    if (!this.directory)
      this.directory = (async () => {
        if (
          typeof navigator === 'undefined' ||
          typeof navigator.storage?.getDirectory !== 'function'
        )
          throw new StorageError('unsupported')
        const root = await navigator.storage.getDirectory()
        const directory = await root.getDirectoryHandle('stepdoc', {
          create: true,
        })
        return directory.getDirectoryHandle(this.options.databaseName, {
          create: true,
        })
      })().catch((error: unknown) => {
        this.directory = undefined
        throw storageError(error)
      })
    return this.directory
  }
  async putBlob(id: string, input: BlobUpload): Promise<{ key: string }> {
    this.ready()
    validateId(id)
    let directory: FileSystemDirectoryHandle | undefined
    let fileName: string | undefined
    try {
      if (!input || typeof input !== 'object')
        throw new StorageError('invalid_blob')
      // Snapshot only known metadata synchronously. Never walk arbitrary capture properties.
      const upload = {
        file: input.file,
        stepId: input.stepId,
        kind: input.kind,
      }
      const file = await validateBlob(upload)
      const guide = await this.getGuide(id)
      if (!guide.steps.some((step) => step.id === upload.stepId))
        throw new StorageError('not_found')
      const sha256 = await digest(file)
      fileName = `${crypto.randomUUID()}.${file.type === 'image/png' ? 'png' : 'webp'}`
      const key = `blobs/${fileName}`
      const row: BlobRecord = {
        key,
        guideId: id,
        stepId: upload.stepId,
        kind: upload.kind,
        mime: file.type,
        bytes: file.size,
        sha256,
        backend: this.blobBackend,
      }
      if (this.blobBackend === 'opfs') {
        directory = await this.files()
        const handle = await directory.getFileHandle(fileName, { create: true })
        const writer = await handle.createWritable()
        try {
          await writer.write(file)
          await writer.close()
        } catch (error) {
          await writer.abort().catch(() => {})
          throw error
        }
        row.fileName = fileName
      } else row.data = file
      await this.run(['guides', 'blobs'], 'readwrite', async (tx) => {
        const current = recordGuide(
          await request<GuideRecord | undefined>(
            tx.objectStore('guides').get(id),
          ),
        )
        if (!current.steps.some((step) => step.id === upload.stepId))
          throw new StorageError('not_found')
        await request(tx.objectStore('blobs').add(row))
      })
      return { key }
    } catch (error) {
      // A failed metadata commit must not expose a partially written file.
      if (directory && fileName)
        await directory.removeEntry(fileName).catch(() => {})
      throw storageError(error)
    }
  }
  async getBlob(key: string): Promise<Blob> {
    validateKey(key)
    try {
      const row = await this.run(
        ['guides', 'blobs'],
        'readonly',
        async (tx) => {
          const blob = await request<BlobRecord | undefined>(
            tx.objectStore('blobs').get(key),
          )
          if (!blob) throw new StorageError('not_found')
          recordGuide(
            await request<GuideRecord | undefined>(
              tx.objectStore('guides').get(blob.guideId),
            ),
          )
          return blob
        },
      )
      if (
        row.key !== key ||
        !['opfs', 'indexeddb'].includes(row.backend) ||
        !['image/png', 'image/webp'].includes(row.mime) ||
        !Number.isSafeInteger(row.bytes) ||
        row.bytes <= 0 ||
        row.bytes > MAX_BLOB_BYTES ||
        !/^[a-f0-9]{64}$/.test(row.sha256)
      )
        throw new StorageError('corrupt_data')
      let data: Blob
      if (row.backend === 'opfs') {
        if (row.fileName !== key.slice(6))
          throw new StorageError('corrupt_data')
        try {
          data = await (
            await (await this.files()).getFileHandle(row.fileName)
          ).getFile()
        } catch (error) {
          if (error instanceof DOMException && error.name === 'NotFoundError')
            throw new StorageError('corrupt_data')
          throw error
        }
      } else {
        if (!(row.data instanceof Blob)) throw new StorageError('corrupt_data')
        data = row.data
      }
      if (data.size !== row.bytes || (await digest(data)) !== row.sha256)
        throw new StorageError('corrupt_data')
      return new Blob([data], { type: row.mime })
    } catch (error) {
      throw storageError(error)
    }
  }
}

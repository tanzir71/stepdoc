import {
  IndexedDbAdapter,
  MAX_BLOB_BYTES,
  StorageError,
  type IndexedDbOptions,
} from '../src'
import { transaction, request } from '../src/database'
import type { GuideInput } from '@stepdoc/schema'

let checks = 0
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
  checks++
}
async function rejects(work: () => Promise<unknown>, code: string) {
  try {
    await work()
  } catch (error) {
    check(
      error instanceof StorageError && error.code === code,
      `Expected sanitized ${code}`,
    )
    check(
      !String(error).includes('private-native') && !('cause' in error),
      'No private native errors or causes',
    )
    return error
  }
  throw new Error(`Expected ${code}`)
}
function guide(id = 'browser-guide'): GuideInput {
  return {
    schema: 'stepdoc/guide@1',
    id,
    title: 'Private local guide',
    description: 'Owned by this browser',
    steps: [
      { id: 'step-one', index: 1, type: 'manual', title: 'Open settings' },
    ],
    version: 9,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  }
}
async function image(type = 'image/png', color = 'black'): Promise<Blob> {
  const canvas = new OffscreenCanvas(4, 4)
  const context = canvas.getContext('2d')!
  context.fillStyle = color
  context.fillRect(0, 0, 4, 4)
  return canvas.convertToBlob({ type })
}
async function rawDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(new Error('Fixture database failed'))
  })
}
async function count(name: string, store: string): Promise<number> {
  const db = await rawDb(name)
  try {
    return await transaction(db, [store], 'readonly', (tx) =>
      request(tx.objectStore(store).count()),
    )
  } finally {
    db.close()
  }
}
async function fileCount(name: string): Promise<number> {
  const root = await navigator.storage.getDirectory()
  const directory = await (
    await root.getDirectoryHandle('stepdoc')
  ).getDirectoryHandle(name)
  let result = 0
  for await (const _entry of directory.values()) result++
  return result
}

const fixture = {
  async atomicCapture(backend: 'opfs' | 'indexeddb') {
    const name = `stepdoc-capture-${backend}`
    const adapter = await IndexedDbAdapter.open({
      databaseName: name,
      blobStorage: backend,
    })
    const input = guide('atomic-capture')
    input.steps[0]!.screenshot = { rendered: '', width: 4, height: 4 }
    const file = await image()
    const uploads = [
      { file, stepId: 'step-one', kind: 'original' as const },
      { file, stepId: 'step-one', kind: 'rendered' as const },
    ]
    // A failure after blob records were queued must abort the entire document.
    const add = IDBObjectStore.prototype.add
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === 'versions') throw new Error('private-native-failure')
      return add.apply(this, args)
    }
    try {
      await rejects(
        () => adapter.createGuideWithBlobs(input, uploads),
        'storage_unavailable',
      )
    } finally {
      IDBObjectStore.prototype.add = add
    }
    check(
      (await count(name, 'guides')) === 0 &&
        (await count(name, 'versions')) === 0 &&
        (await count(name, 'blobs')) === 0,
      'Capture transaction left no partial document, history or blobs',
    )
    if (backend === 'opfs')
      check(
        (await fileCount(name)) === 0,
        'Capture rollback cleaned staged files',
      )
    await rejects(
      () => adapter.createGuideWithBlobs(input, [uploads[0]!]),
      'invalid_blob',
    )
    check(
      (await adapter.listGuides()).items.length === 0,
      'Missing rendered image is not published',
    )
    const rival = await IndexedDbAdapter.open({
      databaseName: name,
      blobStorage: backend,
    })
    const results = await Promise.allSettled([
      adapter.createGuideWithBlobs(input, uploads),
      rival.createGuideWithBlobs(input, uploads),
    ])
    check(
      results.filter((result) => result.status === 'fulfilled').length === 1,
      'One capture wins competing imports',
    )
    check(
      (await count(name, 'guides')) === 1 &&
        (await count(name, 'versions')) === 1 &&
        (await count(name, 'blobs')) === 2,
      'Capture is atomically visible once with exactly its two files',
    )
    if (backend === 'opfs')
      check(
        (await fileCount(name)) === 2,
        'Losing capture cleaned only its own files',
      )
    const saved = await adapter.getGuide(input.id)
    check(
      saved.version === 1 && input.steps[0]!.screenshot!.rendered === '',
      'Capture import snapshots input and owns version',
    )
    for (const key of [
      saved.steps[0]!.screenshot!.original!,
      saved.steps[0]!.screenshot!.rendered,
    ])
      check(
        (await adapter.getBlob(key)).size === file.size,
        'Both captured images are readable with integrity verification',
      )
    check(
      (await adapter.listVersions(input.id)).length === 1,
      'First capture history includes images',
    )
    adapter.close()
    rival.close()
    return checks
  },
  async basic(backend: 'opfs' | 'indexeddb') {
    const name = `stepdoc-test-${backend}`
    const adapter = await IndexedDbAdapter.open({
      databaseName: name,
      blobStorage: backend,
      pageSize: 2,
    })
    check(
      adapter.blobBackend === backend && adapter.capabilities.versions,
      'Requested backend and version support',
    )
    const input = guide()
    const pending = adapter.createGuide(input)
    input.title = 'UI mutation after save'
    const created = await pending
    check(
      created.version === 1 && created.title === 'Private local guide',
      'Creation snapshots input and owns version',
    )
    check(input.version === 9, 'Creation does not mutate caller version')
    created.title = 'Caller mutation'
    check(
      (await adapter.getGuide(created.id)).title === 'Private local guide',
      'Returned documents do not alias persisted data',
    )
    await rejects(() => adapter.createGuide(guide()), 'conflict')
    const first = await adapter.getGuide(created.id)
    const second = await adapter.saveGuide(
      { ...first, title: 'Second version', createdAt: '2030-01-01T00:00:00Z' },
      1,
    )
    check(
      second.version === 2 && second.createdAt === first.createdAt,
      'Save increments version and preserves creation date',
    )
    check(
      (await adapter.getVersion(created.id, 1)).title === first.title,
      'History remains immutable',
    )
    const conflict = await rejects(
      () => adapter.saveGuide(first, 1),
      'conflict',
    )
    check(
      conflict.currentVersion === 2,
      'Conflict exposes only current version',
    )
    const versions = await adapter.listVersions(created.id)
    check(
      versions.map((row) => row.version).join(',') === '2,1' &&
        !('doc' in versions[0]!),
      'History summaries descend and omit content',
    )
    const file = await image()
    const upload = { file, stepId: 'step-one', kind: 'original' as const }
    Object.defineProperty(upload, 'value', {
      enumerable: true,
      get() {
        throw new Error('private-native-value-read')
      },
    })
    const original = await adapter.putBlob(created.id, upload)
    const render = await adapter.putBlob(created.id, {
      file: await image('image/webp'),
      stepId: 'step-one',
      kind: 'rendered',
    })
    const render2 = await adapter.putBlob(created.id, {
      file,
      stepId: 'step-one',
      kind: 'rendered',
    })
    check(render.key !== render2.key, 'Blob keys never overwrite prior renders')
    const loaded = await adapter.getBlob(original.key)
    check(
      loaded.type === file.type && loaded.size === file.size,
      'Blob MIME/size round trip',
    )
    check(
      Array.from(new Uint8Array(await loaded.arrayBuffer())).join(',') ===
        Array.from(new Uint8Array(await file.arrayBuffer())).join(','),
      'Blob bytes round trip',
    )
    check(
      (await adapter.getBlob(render.key)).type === 'image/webp',
      'Prior WebP render remains available',
    )
    const third = await adapter.saveGuide(
      {
        ...second,
        title: 'Third version',
        steps: [
          {
            ...second.steps[0]!,
            screenshot: {
              original: original.key,
              rendered: render2.key,
              width: 4,
              height: 4,
              devicePixelRatio: 1,
            },
          },
        ],
      },
      2,
    )
    check(
      (await adapter.listGuides()).items[0]?.thumb === render2.key,
      'Library uses rendered image only',
    )
    check(
      (await adapter.getVersion(created.id, 2)).steps[0]!.screenshot ===
        undefined,
      'Version images do not change retroactively',
    )
    await rejects(() => adapter.getVersion(created.id, 99), 'not_found')
    await rejects(() => adapter.getGuide('missing-guide'), 'not_found')
    for (const invalid of [
      new Blob([], { type: 'image/png' }),
      new Blob(['<svg/>'], { type: 'image/svg+xml' }),
      new Blob(['not-raster'], { type: 'image/png' }),
      new Blob([file], { type: 'image/webp' }),
    ])
      await rejects(
        () =>
          adapter.putBlob(created.id, {
            file: invalid,
            stepId: 'step-one',
            kind: 'rendered',
          }),
        'invalid_blob',
      )
    const oversized = new Blob(['not-read'], { type: 'image/png' })
    Object.defineProperty(oversized, 'size', { value: MAX_BLOB_BYTES + 1 })
    await rejects(
      () =>
        adapter.putBlob(created.id, {
          file: oversized,
          stepId: 'step-one',
          kind: 'rendered',
        }),
      'invalid_blob',
    )
    await rejects(
      () =>
        adapter.putBlob(created.id, {
          file,
          stepId: 'missing-step',
          kind: 'rendered',
        }),
      'not_found',
    )
    await rejects(() => adapter.getBlob('../private-path'), 'invalid_blob')
    await rejects(
      () => adapter.getBlob('blobs/00000000-0000-0000-0000-000000000000.png'),
      'not_found',
    )
    const bad = guide('invalid-private-guide')
    Object.assign(bad.steps[0]!, {
      action: 'fill',
      value: { kind: 'literal', literal: 'private-typed-value' },
    })
    await rejects(() => adapter.createGuide(bad), 'invalid_guide')
    check(
      (await count(name, 'guides')) === 1 && (await count(name, 'blobs')) === 3,
      'Invalid operations leave no partial records',
    )
    if (backend === 'opfs')
      check((await fileCount(name)) === 3, 'Invalid uploads leave no files')
    adapter.close()
    await rejects(() => adapter.getGuide(created.id), 'closed')
    return {
      checks,
      key: render2.key,
      original: original.key,
      version: third.version,
    }
  },
  async reload(backend: 'opfs' | 'indexeddb', key: string) {
    const adapter = await IndexedDbAdapter.open({
      databaseName: `stepdoc-test-${backend}`,
      blobStorage: backend,
    })
    const doc = await adapter.getGuide('browser-guide')
    check(
      doc.title === 'Third version' && doc.version === 3,
      'Document persists through a real page reload',
    )
    check(
      doc.steps[0]!.screenshot?.rendered === key &&
        (await adapter.getBlob(key)).size > 0,
      'Persisted image resolves after reload',
    )
    check(
      (await adapter.listVersions(doc.id)).length === 3,
      'History persists through reload',
    )
    adapter.close()
    return checks
  },
  async concurrentSetup() {
    const adapter = await IndexedDbAdapter.open({
      databaseName: 'stepdoc-concurrent',
    })
    await adapter.createGuide(guide())
    adapter.close()
  },
  async concurrentSave(title: string) {
    const adapter = await IndexedDbAdapter.open({
      databaseName: 'stepdoc-concurrent',
    })
    try {
      const input = guide()
      input.version = 1
      input.title = title
      return { ok: true, version: (await adapter.saveGuide(input, 1)).version }
    } catch (error) {
      check(
        error instanceof StorageError &&
          error.code === 'conflict' &&
          error.currentVersion === 2,
        'Competing tab receives version conflict',
      )
      return { ok: false, code: error.code }
    } finally {
      adapter.close()
    }
  },
  async concurrencyCheck() {
    const adapter = await IndexedDbAdapter.open({
      databaseName: 'stepdoc-concurrent',
    })
    check(
      (await adapter.getGuide('browser-guide')).version === 2,
      'Exactly one concurrent save commits',
    )
    check(
      (await adapter.listVersions('browser-guide')).length === 2,
      'Conflict does not add a history row',
    )
    adapter.close()
    return checks
  },
  async fallback() {
    const defaults = await IndexedDbAdapter.open({
      databaseName: 'stepdoc-option-defaults',
      pageSize: undefined,
      blobStorage: undefined,
      now: undefined,
    })
    check(
      (await defaults.createGuide(guide())).version === 1,
      'Explicit undefined options keep documented defaults',
    )
    defaults.close()
    const own = Object.getOwnPropertyDescriptor(
      navigator.storage,
      'getDirectory',
    )
    Object.defineProperty(navigator.storage, 'getDirectory', {
      value: undefined,
      configurable: true,
    })
    let adapter: IndexedDbAdapter | undefined
    try {
      adapter = await IndexedDbAdapter.open({
        databaseName: 'stepdoc-auto-fallback',
      })
      check(
        adapter.blobBackend === 'indexeddb',
        'Auto fallback detects missing OPFS',
      )
      await rejects(
        () =>
          IndexedDbAdapter.open({
            databaseName: 'stepdoc-no-opfs',
            blobStorage: 'opfs',
          }),
        'unsupported',
      )
      const doc = await adapter.createGuide(guide())
      const { key } = await adapter.putBlob(doc.id, {
        file: await image(),
        stepId: 'step-one',
        kind: 'thumb',
      })
      check(
        (await adapter.getBlob(key)).type === 'image/png',
        'Fallback is real IndexedDB Blob persistence',
      )
    } finally {
      adapter?.close()
      if (own) Object.defineProperty(navigator.storage, 'getDirectory', own)
      else Reflect.deleteProperty(navigator.storage, 'getDirectory')
    }
    return checks
  },
  async failures() {
    const name = 'stepdoc-failures'
    const adapter = await IndexedDbAdapter.open({
      databaseName: name,
      blobStorage: 'opfs',
    })
    const add = IDBObjectStore.prototype.add
    const failHistory = function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'versions')
        throw new DOMException('private-native-quota', 'QuotaExceededError')
      return add.call(this, value, key)
    }
    IDBObjectStore.prototype.add = failHistory
    try {
      await rejects(() => adapter.createGuide(guide()), 'storage_full')
    } finally {
      IDBObjectStore.prototype.add = add
    }
    check(
      (await count(name, 'guides')) === 0 &&
        (await count(name, 'versions')) === 0,
      'Late history failure rolls back guide creation',
    )
    const doc = await adapter.createGuide(guide())
    IDBObjectStore.prototype.add = failHistory
    try {
      await rejects(
        () => adapter.saveGuide({ ...doc, title: 'Must roll back' }, 1),
        'storage_full',
      )
    } finally {
      IDBObjectStore.prototype.add = add
    }
    check(
      (await adapter.getGuide(doc.id)).title === doc.title &&
        (await adapter.listVersions(doc.id)).length === 1,
      'Late history failure rolls back guide update',
    )
    const file = await image()
    const first = await adapter.putBlob(doc.id, {
      file,
      stepId: 'step-one',
      kind: 'rendered',
    })
    check((await fileCount(name)) === 1, 'Successful file installed')
    const writable = FileSystemFileHandle.prototype.createWritable
    FileSystemFileHandle.prototype.createWritable = async () => {
      throw new DOMException('private-native-path', 'QuotaExceededError')
    }
    try {
      await rejects(
        () =>
          adapter.putBlob(doc.id, {
            file,
            stepId: 'step-one',
            kind: 'rendered',
          }),
        'storage_full',
      )
    } finally {
      FileSystemFileHandle.prototype.createWritable = writable
    }
    check(
      (await fileCount(name)) === 1 && (await count(name, 'blobs')) === 1,
      'Write failure removes new file and exposes no metadata',
    )
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'blobs')
        throw new DOMException('private-native-metadata', 'QuotaExceededError')
      return add.call(this, value, key)
    }
    try {
      await rejects(
        () =>
          adapter.putBlob(doc.id, {
            file,
            stepId: 'step-one',
            kind: 'rendered',
          }),
        'storage_full',
      )
    } finally {
      IDBObjectStore.prototype.add = add
    }
    check(
      (await fileCount(name)) === 1 && (await count(name, 'blobs')) === 1,
      'Metadata failure removes fully written orphan',
    )
    check(
      (await adapter.getBlob(first.key)).size === file.size,
      'Failed write cannot damage earlier image',
    )
    const root = await navigator.storage.getDirectory()
    const directory = await (
      await root.getDirectoryHandle('stepdoc')
    ).getDirectoryHandle(name)
    const handle = await directory.getFileHandle(first.key.slice(6))
    const writer = await handle.createWritable()
    await writer.write(await image('image/png', 'white'))
    await writer.close()
    await rejects(() => adapter.getBlob(first.key), 'corrupt_data')
    await directory.removeEntry(first.key.slice(6))
    await rejects(() => adapter.getBlob(first.key), 'corrupt_data')
    adapter.close()
    const retry = await IndexedDbAdapter.open({
      databaseName: 'stepdoc-directory-retry',
      blobStorage: 'opfs',
    })
    await retry.createGuide(guide())
    const descriptor = Object.getOwnPropertyDescriptor(
      navigator.storage,
      'getDirectory',
    )
    Object.defineProperty(navigator.storage, 'getDirectory', {
      configurable: true,
      value: async () => {
        throw new DOMException('private-native-denied', 'NotAllowedError')
      },
    })
    try {
      await rejects(
        () =>
          retry.putBlob(doc.id, { file, stepId: 'step-one', kind: 'rendered' }),
        'storage_unavailable',
      )
    } finally {
      if (descriptor)
        Object.defineProperty(navigator.storage, 'getDirectory', descriptor)
      else Reflect.deleteProperty(navigator.storage, 'getDirectory')
    }
    check(
      (
        await retry.putBlob(doc.id, {
          file,
          stepId: 'step-one',
          kind: 'rendered',
        })
      ).key.startsWith('blobs/'),
      'Directory failures are retryable after recovery',
    )
    retry.close()
    const raceName = 'stepdoc-step-removed'
    const race = await IndexedDbAdapter.open({
      databaseName: raceName,
      blobStorage: 'opfs',
    })
    const before = await race.createGuide(guide())
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      const stream = await writable.call(this, options)
      await race.saveGuide(
        {
          ...before,
          steps: [
            {
              id: 'replacement',
              index: 1,
              type: 'manual',
              title: 'Replacement step',
            },
          ],
        },
        before.version,
      )
      return stream
    }
    try {
      await rejects(
        () =>
          race.putBlob(before.id, {
            file,
            stepId: 'step-one',
            kind: 'rendered',
          }),
        'not_found',
      )
    } finally {
      FileSystemFileHandle.prototype.createWritable = writable
    }
    check(
      (await fileCount(raceName)) === 0 &&
        (await count(raceName, 'blobs')) === 0,
      'Step removal during OPFS write cannot commit an orphaned image',
    )
    race.close()
    return checks
  },
  async deleted(backend: 'opfs' | 'indexeddb', key: string) {
    const name = `stepdoc-test-${backend}`
    const adapter = await IndexedDbAdapter.open({
      databaseName: name,
      blobStorage: backend,
    })
    await adapter.deleteGuide('browser-guide')
    await adapter.deleteGuide('browser-guide')
    await adapter.deleteGuide('missing-guide')
    check(
      (await adapter.listGuides()).items.length === 0,
      'Trash is omitted from library',
    )
    await rejects(() => adapter.getGuide('browser-guide'), 'not_found')
    await rejects(() => adapter.getBlob(key), 'not_found')
    await rejects(() => adapter.getVersion('browser-guide', 1), 'not_found')
    await rejects(() => adapter.createGuide(guide()), 'conflict')
    check(
      (await count(name, 'guides')) === 1 &&
        (await count(name, 'versions')) === 3 &&
        (await count(name, 'blobs')) === 3,
      'Soft deletion retains history and blobs for future trash restore',
    )
    adapter.close()
    return checks
  },
  async upgrade() {
    const name = 'stepdoc-upgrade'
    const adapter = await IndexedDbAdapter.open({ databaseName: name })
    await adapter.createGuide(guide())
    const next = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name, 2)
      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(new Error('Fixture upgrade failed'))
      open.onblocked = () =>
        reject(new Error('Adapter did not close for schema upgrade'))
    })
    check(
      next.version === 2,
      'Connections close on versionchange instead of blocking migration',
    )
    await rejects(() => adapter.getGuide('browser-guide'), 'closed')
    next.close()
    await rejects(
      () => IndexedDbAdapter.open({ databaseName: name }),
      'storage_unavailable',
    )
    return checks
  },
  async corruptFallback() {
    const name = 'stepdoc-corrupt-fallback'
    const adapter = await IndexedDbAdapter.open({
      databaseName: name,
      blobStorage: 'indexeddb',
    })
    const doc = await adapter.createGuide(guide())
    const { key } = await adapter.putBlob(doc.id, {
      file: await image(),
      stepId: 'step-one',
      kind: 'rendered',
    })
    const db = await rawDb(name)
    await transaction(db, ['blobs'], 'readwrite', async (tx) => {
      const store = tx.objectStore('blobs')
      const row = await request<Record<string, unknown>>(store.get(key))
      await request(
        store.put({
          ...row,
          data: new Blob(['corrupt'], { type: 'image/png' }),
        }),
      )
    })
    await rejects(() => adapter.getBlob(key), 'corrupt_data')
    await transaction(db, ['guides'], 'readwrite', (tx) =>
      request(
        tx.objectStore('guides').put({
          id: doc.id,
          doc: { ...doc, private: 'private-typed-value' },
          deletedAt: null,
        }),
      ),
    )
    await rejects(() => adapter.getGuide(doc.id), 'corrupt_data')
    await rejects(() => adapter.listGuides(), 'corrupt_data')
    db.close()
    adapter.close()
    return checks
  },
  counts() {
    return checks
  },
}
Object.assign(globalThis, { storageFixture: fixture })

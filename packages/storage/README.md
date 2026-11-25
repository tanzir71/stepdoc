# @stepdoc/storage

`StorageAdapter` defines the common guide, library, version-history and raster-blob
operations used by the SPA and extension. Names/shapes follow Storage API v1 in
`docs/v2/storage-api.openapi.yaml`: HTTP adapters map `saveGuide`'s `ifMatch` to the
required header, and library results use `GuideSummary`/`nextCursor`. Auth,
collaboration and publishing extend this interface in their milestones. This
package currently ships the browser adapter; HTTP and static adapters come with
their server/publishing targets.

```ts
import { IndexedDbAdapter } from '@stepdoc/storage'

const storage = await IndexedDbAdapter.open()
const page = await storage.listGuides({ q: 'billing', status: 'needs-review' })
if (page.items[0]) {
  const guide = await storage.getGuide(page.items[0].id)
  await storage.saveGuide({ ...guide, title: 'Updated guide' }, guide.version)
}
storage.close()
```

Browser metadata lives in IndexedDB database version 1, in `guides`, `versions`
and `blobs` stores. Validated guide snapshots isolate callers from persisted data.
Create assigns version 1; save compares both the document version and `ifMatch`,
increments the version, preserves `createdAt` and writes an immutable history row
in the same strict-durability transaction. Conflicts include only the current
version. Snapshots keep the source schema identifier and guide data unchanged.
Duplicate step IDs/indices, duplicate declarations, mismatched/undeclared variable
references and invalid guide@1 data are rejected before writes.

Library queries support title/description/tag/app search, status/review/replay
filters, collections, stable timestamp/ID ordering and keyset pagination. Page
size defaults to 50 (configurable from 1–200); a cursor is tied to a hash of its
filters and contains no search text or guide content. Blob bytes are never loaded
for library queries. Metadata filtering currently scans guide JSON; an indexed
summary/search projection can replace that implementation for larger libraries.

`deleteGuide` is idempotent and moves a guide to local trash. Its snapshots and
images are retained, and its ID stays reserved; deleted guides/images cannot be
read through the active adapter API. Trash restore/purge UI belongs to the later
parity work. Connections close on `versionchange`; opening a newer database with
this implementation fails instead of trying to downgrade it. Future database
versions must add migrations; they must not recreate existing stores.

`putBlob` accepts **already redacted** originals or **already flattened** rendered/
thumbnail PNG or WebP `Blob`s, with a guide ID, step ID and kind. The caller must
run the core compositor/review first. No pixel processing or URL fetching happens
here. MIME/signature and 64 MB bounds are checked; unknown metadata properties are
never walked. Only immutable generated keys enter file paths. The adapter checks
that the guide/step still exists after the file write, then publishes metadata.
Reads verify byte length and SHA-256 and restore the stored MIME type.

OPFS is preferred when available, with files under `stepdoc/<databaseName>/`.
`blobStorage: 'indexeddb'` forces atomic native IndexedDB Blob storage;
`blobStorage: 'opfs'` requires OPFS; the default `'auto'` falls back to IndexedDB
when the OPFS API is absent. Reads select the backend recorded for each blob, so
both formats can coexist. This is a capability fallback, not a migration of old
OPFS files: those still require OPFS access. A runtime quota/permission failure is
reported, not silently retried in a second backend.

OPFS files finish writing before metadata becomes visible. Ordinary write/commit
failures attempt to remove the new file; earlier keys are never overwritten.
IndexedDB and OPFS do not share a transaction: a terminated process or failed
cleanup can leave an unreachable file. Maintenance must later collect those
orphans without deleting images retained by any version or an in-flight write.

`StorageError` exposes fixed codes/messages without raw validation/native details
or causes. Unsupported capabilities, quota, missing/corrupt content, blocked
upgrades, closed connections and version conflicts are separate UI states. No
storage permission prompt or persistent-storage request is made implicitly.

Run `pnpm --filter @stepdoc/storage test`. Unit tests cover guide privacy/identity,
summaries, queries/cursors and safe errors. The real Chromium check uses an
intercepted localhost origin, real IndexedDB/OPFS, a real reload, two competing
tabs and a module worker. It also verifies IndexedDB fallback, transaction rollback,
native quota/write/metadata failures, step removal during an image write,
corruption detection, soft deletion and schema-upgrade connection closure. No
external service is contacted. Native API references:
[OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
[IndexedDB transaction lifetime](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction).

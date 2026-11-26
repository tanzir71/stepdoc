# @stepdoc/storage

`StorageAdapter` defines the common guide, library, version-history and raster-blob
operations used by the SPA and extension. Names/shapes follow Storage API v1 in
`docs/v2/storage-api.openapi.yaml`: HTTP adapters map `saveGuide`'s `ifMatch` to the
required header, and library results use `GuideSummary`/`nextCursor`. Auth,
collaboration and publishing extend this interface in their milestones. This
package ships the browser adapter and the HTTP client. The static adapter comes
with the publishing target. Actual server implementations remain separate work.

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

Library queries support title/description/tag/app and authored step-text search, status/review/replay
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

`IndexedDbAdapter.createGuideWithBlobs` is a browser-only atomic capture import.
It snapshots the guide and original/rendered uploads, verifies raster signatures,
assigns immutable keys, finishes OPFS files, then commits guide/history/blob
metadata in one transaction. Invalid, missing, duplicate or foreign image slots
and competing imports cannot expose a partial guide. Ordinary failures remove
only the attempt's new files. A terminated OPFS write has the orphan limitation
above. This adds no Storage API endpoint or adapter requirement for servers.

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

## HTTP client and pairing transport

Import `HttpAdapter`, `claimPairing` and `storageApiUrl` from
`@stepdoc/storage/http`. This separate entrypoint keeps unused network validators
and transport code out of the browser-only SPA. `HttpAdapter.open(server, options)`
accepts a server root, a subdirectory installation or its explicit `/api/v1` URL.
It validates the public `/health` response before obtaining any credentials.
Remote URLs require HTTPS; HTTP is accepted for localhost/loopback fixtures.
URL credentials, query strings and fragments are rejected with a fixed error.

The default authentication mode uses the server's session cookie. Extension/API
clients provide `{ auth: { kind: 'bearer', token: loadPrivateCredential } }` instead.
That callback runs for each authenticated request, supporting rotation/revocation
without a cached token in the adapter. Health and pairing requests are anonymous;
bearer requests omit cookies. Every request rejects redirects, disables caching
and sends no referrer. The embedding app owns private credential storage; the
adapter never persists credentials or exposes them through serialization.

All current `StorageAdapter` operations use their existing API paths. Library
filters/cursors are URL-encoded (`collection: null` uses an empty collection
parameter). Creates send version one, and saves require the document version to
match `ifMatch`, send `If-Match`, and validate the returned next revision. Guides,
summaries, history and blob keys are validated and copied; mismatched identities,
duplicate rows and a repeated cursor fail safely. History has no arbitrary row
limit. A remote 409 carries only a sanitized conflict code; callers reload the
current guide instead of guessing a version from an error message.

`putBlob` sends only `file`, `stepId` and `kind` in native multipart form data,
with a neutral filename. Callers must supply already-redacted/flattened pixels.
PNG/WebP signatures, advertised upload capacity and the 64 MB client raster limit
are checked without image decoding. Downloaded keys remain opaque encoded path
components at the selected API, including keys containing slashes. Downloads
validate MIME/signature and stay within the raster budget. HTTP supplies no
checksum field, so this does not claim the IndexedDB backend's persisted SHA-256
integrity guarantee or an atomic transaction across create/blob/save requests.

JSON is limited to 64 MB by default (`maxJsonBytes` may lower that budget).
Declared and streamed byte counts, UTF-8, MIME and schema are checked before a
response leaves the adapter. Timeouts default to 15 seconds and are configurable
up to two minutes. `close()` aborts outstanding requests, including body reads or
credential lookup. Safe status codes distinguish revoked/forbidden credentials,
conflicts, rate limiting, upload size and redaction policy; server/native error
text is never returned. Writes are never automatically retried. `readOnly`
prevents client writes; server authorization remains authoritative.

`claimPairing` checks the public health contract, then anonymously posts the
explicit code/device/extension fields to `/pairing/claim`. It returns a one-time
credential only when the response has exactly `capture:write` and `guides:read`.
It does not persist that credential, implement server-side hashing/revocation or
grant generic guide-write permission. E05 UI, scoped capture upload, destination
selection and paired editor integration remain M11 work; no public endpoint has
been added or changed by this client implementation.

`pnpm --filter @stepdoc/storage test` includes HTTP unit checks and a real Chromium
client fixture on two local HTTP origins. It exercises CORS preflights, actual
cookie/bearer isolation, multipart raster round trips, concurrent `If-Match`
saves/history, anonymous one-use pairing, redirect rejection, abort/close and a
module worker under a CSP without eval. Fixture servers persist bytes only and
are local stand-ins, not implementations of the PHP/Worker/Node targets or the
future cross-target contract suite. Existing IndexedDB/OPFS checks still run.

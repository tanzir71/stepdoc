# PHP + SQLite server

This is the first M12 server unit. It implements the existing Storage API v1
health, guide CRUD/list, version history and private raster-blob paths. Passkey,
email/recovery sign-in, pairing/devices, capture ingestion, public publishing,
MCP, the SPA distribution and the shared-hosting installer are still unfinished.
`/health` reports those capabilities as unavailable. This is not the deploy ZIP.

The PHP runtime uses PDO SQLite and validates guide@1 against
[`docs/v2/guide.schema.json`](../../docs/v2/guide.schema.json) through the locked
[Opis JSON Schema validator](https://opis.io/json-schema/2.x/). No Node process,
image decoder, image transformer or remote service is used by the server.
Blob checks cover MIME and the PNG/WebP byte signature; already-redacted client
bytes are stored unchanged. The server never retains an upload filename.

Run the automated local suite:

```powershell
pnpm --filter @stepdoc/php setup
pnpm test:contract --target=php
```

The launcher uses the installed PHP binary (`STEPDOC_PHP_BINARY` overrides it).
On Windows it enables the bundled PDO SQLite/OpenSSL/cURL/ZIP DLLs for its CLI
processes when needed. Composer 2.11.3 is downloaded only when dependencies are
missing, checked against its [official SHA-256](https://getcomposer.org/download/),
and kept under ignored `test-results/tools/`. `composer.lock` pins runtime
dependencies. No Composer plugins or scripts run. Production PHP must have PDO
SQLite enabled; its normal PHP configuration controls its hosting limits.

`pnpm verify` includes PHP syntax checks, TypeScript checks for the contract
harness, and this contract suite. Tests start two real `php -S` processes on
loopback with a shared SQLite file, then terminate those exact child processes.
They use generated local credentials and retain ignored evidence under
`test-results/php-contract-*`; there is no HTTP test backdoor or test auth mode.
The HTTP suite is target-independent. PHP-only SQL/filesystem checks live in a
separate file. Worker and Node launchers remain explicit failures until M13/M14
implement them; they never claim contract coverage from this PHP run.

## Configuration and local administration

| Setting | Behavior |
| --- | --- |
| `STEPDOC_DATA_DIR` | SQLite, WAL and blobs; defaults to `servers/php/data/`, outside `public/`. A location inside the public root is rejected. |
| `STEPDOC_ORIGIN` | Canonical frontend origin without a trailing slash; HTTPS, or loopback HTTP. Defaults to `https://localhost` for an unconfigured development install. |
| `STEPDOC_API_PATH` | Defaults to `/api/v1`; a subdirectory installation can use `/tools/api/v1`. |
| `STEPDOC_MAX_UPLOAD_BYTES` | Defaults to 64 MiB; capped by `upload_max_filesize` and `post_max_size` with multipart overhead reserved. The effective cap is returned by `/health`. |
| `STEPDOC_PAGE_SIZE` | 1–100, default 100; cursors bind to the active filter. |

JSON metadata requests are capped at 8 MiB. Limit failures return 413 and a safe
JSON error. Blob bytes have a separate effective limit. Static files and PHP's
`public/` directory must be the only web root; the DB and blob directory stay
private. `.htaccess` routes API requests through the front controller and disables
directory indexes. The local router applies the same root boundary.

For this foundation, server operators can create workspaces and scoped tokens
through `bin/stepdoc.php`. Commands read a JSON object from stdin and return JSON.
Run with the same data configuration as the server. The supported commands are:

- `workspace:create`: `{ "name": "Workspace" }` → `{ "id": "…" }`.
- `token:issue`: `{ "workspaceId": "…", "name": "CLI", "scopes": ["guides:read"] }`
  → the token shown once, its ID and scopes. An optional `origin` binds an extension
  token to its exact `chrome-extension://…` or `moz-extension://…` origin.
- `token:revoke`: `{ "id": "…" }` → `{ "revoked": true }`.

Only token hashes are stored. Each authenticated request checks revocation and
scope in SQLite; observational `last_seen_at` writes are limited to once per
minute. CORS permits the configured same origin and registered extension origins,
never a wildcard. A registered revoked origin may receive its 401 response, while
its token remains unusable. Capture-only tokens cannot mutate general guides or
upload through the editor blob path; capture ingestion remains a later M12 unit.

Guide writes use prepared SQL and transactions. `If-Match` compares the submitted
revision with the current revision under the same write lock; successful writes
append an immutable version and safe audit event. Slugs are isolated by workspace.
Trash preserves historical JSON and blob bytes while hiding all related HTTP
reads. Private blob responses require guide access, verify stored length/hash,
send the recorded raster MIME and disable caching/sniffing. General guide writes
cannot enable public access or bypass the future publish/policy gate.

# PHP + SQLite server

This M12 server implements the existing Storage API v1
health, guide CRUD/list, version history, private raster-blob paths, passkey and
email/recovery sign-in, cookie sessions, pairing/devices, scoped API tokens and
capture ingestion with private large-image staging. It serves the shared SPA with
cookie-session sign-in and HTTP-backed library/editor storage. The W01 installer
enrolls its first owner with a passkey, recovery codes and extension pairing.
Build the self-contained archive with `pnpm build:php`; follow [INSTALL.md](INSTALL.md)
for its public document root, private setup key and subdirectory configuration.
Public publishing, MCP, remaining API operations and lazy backups remain unfinished.
`/health` reports current capabilities and configuration.

The PHP runtime uses PDO SQLite and validates guide@1 against
[`docs/v2/guide.schema.json`](../../docs/v2/guide.schema.json) through the locked
[Opis JSON Schema validator](https://opis.io/json-schema/2.x/). No Node process,
image decoder or image transformer is used by the server.
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
| `STEPDOC_APP_DIR` | Compiled SPA directory; defaults to the packaged `app/`, or the repository's `apps/app/dist`. Build with `pnpm --filter @stepdoc/app build`. |
| `STEPDOC_MAX_UPLOAD_BYTES` | Defaults to 64 MiB; capped by `upload_max_filesize` and `post_max_size` with multipart overhead reserved. The effective cap is returned by `/health`. |
| `STEPDOC_PAGE_SIZE` | 1–100, default 100; cursors bind to the active filter. |

JSON metadata requests are capped at 8 MiB. Limit failures return 413 and a safe
JSON error. Blob bytes have a separate effective limit. Static files and PHP's
`public/` directory must be the only web root; the DB and blob directory stay
private. `.htaccess` routes API requests through the front controller and disables
directory indexes. The local router applies the same root boundary.

The frontend root is derived from the API path: `/tools/api/v1` serves the app at
`/tools/`. Direct editor/export links and reloads use the same root. PHP injects
only the installation's API path in a non-script HTML meta element; no bearer,
cookie, workspace data or setup secret is serialized into HTML. Static modules,
workers, CSS, original SVGs and self-hosted fonts resolve inside that root.
Unknown assets and private filesystem paths return a JSON 404 instead of the SPA.

The hosted client uses the existing session cookie and Storage API. It never
falls back to IndexedDB when sign-in or the server is unavailable. Passkeys are
the default sign-in method, with configured email codes and one-use recovery
codes as alternatives. Code sign-in prompts passkey enrollment; first enrollment
shows recovery codes once in memory. A session expiry hides the existing editor
while the same member signs in again, retaining its unsaved draft for explicit
save retry. Sign-out clears that app instance; a different identity replaces it.
Packaged installations use W01 to provision their first workspace and owner;
local administration remains available below.

For this foundation, server operators can create workspaces and scoped tokens
through `bin/stepdoc.php`. Commands read a JSON object from stdin and return JSON.
Run with the same data configuration as the server. The supported commands are:

- `workspace:create`: `{ "name": "Workspace" }` → `{ "id": "…" }`.
- `token:issue`: `{ "workspaceId": "…", "name": "CLI", "scopes": ["guides:read"] }`
  → the token shown once, its ID and scopes. An optional `origin` binds an extension
  token to its exact `chrome-extension://…` or `moz-extension://…` origin.
- `token:revoke`: `{ "id": "…" }` → `{ "revoked": true }`.
- `owner:create`: `{ "workspaceId": "…", "name": "Owner", "email": "owner@example.com" }`
  creates the first owner only when that workspace has no members.
- `member:add`: `{ "workspaceId": "…", "name": "Editor", "email": "editor@example.com", "role": "editor" }`
  provisions an editor or viewer through local administration. HTTP invitations
  and member management remain M15. The current email-based auth contract selects
  one membership per email address.

Only token hashes are stored. Each authenticated request checks revocation and
scope in SQLite; observational `last_seen_at` writes are limited to once per
minute. CORS permits the configured same origin and registered extension origins,
never a wildcard. A registered revoked origin may receive its 401 response, while
its token remains unusable. Capture-only tokens cannot mutate general guides or
upload through the editor blob path; capture ingestion remains a later M12 unit.
Chrome's privileged extension GET requests omit Origin. These reads still require
the valid scoped bearer; any supplied Origin must match the registered extension,
and extension mutations require it. Cookie-authenticated mutations retain their
separate exact canonical-Origin requirement.

Guide writes use prepared SQL and transactions. `If-Match` compares the submitted
revision with the current revision under the same write lock; successful writes
append an immutable version and safe audit event. Slugs are isolated by workspace.
Trash preserves historical JSON and blob bytes while hiding all related HTTP
reads. Private blob responses require guide access, verify stored length/hash,
send the recorded raster MIME and disable caching/sniffing. General guide writes
cannot enable public access or bypass the future publish/policy gate.

## Authentication and devices

The existing `/auth/passkey/options` and `/auth/passkey/verify` operations use the
locked [lbuchs/WebAuthn](https://github.com/lbuchs/WebAuthn) library. Options return
`{ "publicKey": … }` with standard base64url-encoded WebAuthn binary fields;
verification accepts the standard `PublicKeyCredential.toJSON()` object. Require
user presence and verification; the server checks the exact configured origin,
RP hash, challenge, credential/user binding and signature counter. Challenges
expire after five minutes and are consumed on the first submission, including a
failure. IP rate limits apply. Registration is limited to the signed-in member;
before the workspace has any passkeys, a CLI-issued admin token can enroll the
locally provisioned owner. That bootstrap token must authenticate both ceremony
requests. Anonymous owner registration is denied. A real DNS RP ID (including
localhost for local checks) is required; IP-address installations report passkeys
unavailable.

The first successful enrollment returns ten high-entropy `recoveryCodes` once.
They are never returned by session reads, later key registrations or sign-in.
`POST /auth/recovery {email,code}` consumes one and sets `needsPasskey: true` so
the later sign-in UI can prompt enrollment. All sign-in methods rotate the
session. `sd_session` and the ceremony cookie are always Secure, HttpOnly,
SameSite=Lax and scoped to the installation path. Sessions expire after seven
days; logout deletes the server record. Cookie-authenticated mutations require
the exact canonical Origin. An explicit invalid bearer cannot fall back to a
more privileged cookie. Role changes invalidate old sessions; member-created
tokens are checked against current role permissions on every request and are
removed with the member. Tokens and paired devices created through those tokens
inherit the same member link. Pending pairing also rechecks the issuer's current
permissions and revocation before issuing credentials.

Email codes use locked [PHPMailer](https://github.com/PHPMailer/PHPMailer) with
SMTP or the host's `mail()` transport. Configure `STEPDOC_MAIL_FROM`. SMTP uses
`STEPDOC_SMTP_HOST`, `STEPDOC_SMTP_PORT`, `STEPDOC_SMTP_USERNAME`,
`STEPDOC_SMTP_PASSWORD` and `STEPDOC_SMTP_SECURITY=starttls|smtps|none` (default
STARTTLS; `none` is accepted only for loopback SMTP). No TLS verification is
disabled. Unconfigured email is reported unavailable. Requests return the same
202 response for known/unknown addresses and delivery failures; failed delivery
invalidates that code. Codes are six digits, valid for ten minutes, single-use,
limited to five guesses, with additional email/IP request and verification
limits. Short codes are HMACed with a private 32-byte `auth.key` outside the web
root; sessions, challenges and API tokens also persist only hashes. Credentials
and mail bodies are never written to application logs or audit metadata.

Owner/editor sessions create five-minute `XXX-XXX` codes through
`POST /pairing/codes`; `/pairing/claim` atomically exchanges one for only
`capture:write` and `guides:read`. The claim's extension ID must match its exact
Chrome/Firefox Origin. Only this anonymous exchange permits a syntactically valid
new extension origin for CORS/preflight; no credentialed endpoint does. A valid
claim registers that exact origin for subsequent requests. Revoked tokens stay
revoked even though their registered origin can read a 401 response.

`POST /tokens {name,scopes}` issues explicit API scopes once; callers cannot grant
permissions they lack. `/devices` returns metadata only. Owners can revoke any
workspace device; editors can list/revoke only their own, and viewers cannot
manage credentials. The test suite uses real Chromium virtual WebAuthn and an
in-memory loopback SMTP receiver, with no real email, hardware authenticator or
HTTP authentication bypass.
`pnpm --filter @stepdoc/contract test:extension` runs the real E05 panel against
PHP after the Chrome build. The default loaded-extension gate invokes it after
building the actual extension, proving pair/check/reopen/revoke with the real
private bearer client and PHP API rather than a protocol stub.

## Capture uploads

`POST /sessions` requires `capture:write` and a private draft guide@1 with stable
ID/UUID, version 1, and no unresolved redactions. Small captures may carry
client-prepared PNG/WebP data URLs (8 MiB each and an 8 MiB total JSON budget).
The server validates transport signatures, copies bytes unchanged and atomically
creates the guide, immutable first version and image references. It does no image
decoding, redaction, annotation, thumbnailing or rendering.

`/health` advertises `captureBlobUpload: true`, `maxJsonBytes` and the effective
per-file `maxUploadBytes`. Larger captures first send multipart files to the
existing `/guides/{id}/blobs` route with `captureUuid`, `stepId` and `kind`.
Capture-scoped staging accepts only `original`/`rendered`, binds the capture to
its workspace/ID/UUID/authenticated issuer, and cannot alter an existing guide.
Pending guides and bytes are not readable through the guide/blob APIs. The final
`POST /sessions` replaces URLs with staged keys and promotes only matching
step/image roles in the same transaction as the new guide.

Identical stage retries return their previous key; changed bytes replace the
private step/role stage, including repair of missing/corrupt files. Pending
captures expire after 24 hours of inactivity and are collected lazily. Committed
receipts and guide versions are retained. Same-issuer commit retries return the
current saved guide without overwriting later editor changes; trash is never
resurrected. Private filenames, inline data URLs and rejected typed literals do
not enter database/audit records. General guide/blob mutations still require
`guides:write`.

The extension prepares one redacted source/render pair at a time and uploads it
with its private scoped bearer; it does not build a second large JSON image
document. `unlimitedStorage` permits retained captures beyond Chrome's local
10 MiB quota ([Chrome Storage API](https://developer.chrome.com/docs/extensions/reference/api/storage)). The bounded inline protocol remains supported for older servers.
Controls receive display metadata rather than retained rasters or pending upload
bodies. Source pages receive only recorder status, count and pill state, and cannot
request control state or previews. A separate extension-origin IndexedDB cache
holds already-masked WebP previews (at most 224×144 pixels and 64 KiB each), read
lazily by visible rows. Older retained captures recover previews on demand without
changing their original bytes. This avoids Chrome's
[64 MiB runtime-message limit](https://developer.chrome.com/docs/extensions/develop/concepts/messaging);
control metadata itself is bounded below that limit before serialization.
New frames create previews directly from their already-redacted canvas, avoiding
a second decode of the full-size WebP before recording can start. Preview failure
still preserves the full-resolution capture. Older-cache recovery remains lazy.
The PHP editor route now opens this hosted client and requests user sign-in;
extension credentials never enter the URL or the hosted page. Packaged W01 setup
uses this same authenticated workspace after first-owner registration.

## Installation protocol

The packaged `install.php?action=...` bootstrap is separate from Storage API v1.
`GET status` returns a strict public installation status: phase (`storage`, `owner`,
`complete`), mount `base`, `ready`, and bounded host checks. Pending owner details
are returned only to the current installation cookie. `POST claim` accepts the
build-specific key; `POST owner-options` accepts workspace/name/email; `POST
owner-verify` accepts the native WebAuthn credential. The last two reuse the normal
passkey implementation with a private temporary credential. They never expose
that bearer to JavaScript or add an authentication bypass to the Storage API.

Mutation bodies are bounded JSON, require the exact origin and a private global
lock, and reject Authorization headers. The Secure/HttpOnly installation cookie
and its hashed, revocable enrollment credential expire after ten minutes. Reclaim
rotates them while preserving pending owner details. Verified registration
permanently closes enrollment, revokes its token and establishes a normal cookie
session. Recovery codes are returned once; they never enter a URL or stored screen.
The explicit `/browser/` client has its own mount with no Storage API bootstrap;
hosted errors never select browser storage automatically.

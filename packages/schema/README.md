# @stepdoc/schema

`@stepdoc/schema` exports the guide@1 Zod schemas, inferred input/output types,
schema ID/URL and source JSON Schema (`docs/v2/guide.schema.json`). The Zod/Ajv
fixture suite proves contract parity. Typed fill input is represented only by
variable/secret references; secret examples and fill literals are rejected.

`@stepdoc/schema/capture` validates private `stepdoc/capture@1` extension messages,
including local events, browser-frame snapshots and nonce-only identity probes.
These bounded DTOs carry no field values and are separate from persisted guides
and Storage API v1. Hidden frames can report zero-sized viewports; visible local
events require positive dimensions. The package changelog records why this needs
no guide migration.

`@stepdoc/schema/migrations/v1-to-guide1` migrates v1 database rows. It uses a narrow
row projection to discard capture-only/unknown fields, never reads stored input
values, and requires client-supplied image dimensions/already-flattened images.
See the migration options and tests for edited screenshot requirements.

`@stepdoc/schema/legacy-v1` contains the v1 extension/session/PATCH contracts moved
from the deleted `packages/shared` during M9. Its `ElementMeta`, `ImageEdits`,
`StepInput`, `SessionInput` and schema names are isolated from the guide@1 root
exports. Defaults, accepted payloads and unknown-key stripping remain unchanged;
this move needs no guide-data migration. The extension and Next v1 app import this
module until their replacements reach parity. New product code uses guide@1.

The source JSON Schema import uses the standard `type: 'json'` attribute so native
ESM tooling and the browser bundler can consume the same module. This changes no
guide fields, defaults or schema version and needs no data migration.

RFC URI/UUID/date-time checks import the pinned `ajv-formats` validators directly.
This retains identical format semantics without bundling Ajv's unused dynamic
compiler into client/extension code, where MV3 CSP prohibits `new Function`.
The Zod/Ajv parity fixtures remain the verification; no wire format changes.

Run `pnpm --filter @stepdoc/schema test` for Ajv/Zod privacy and migration checks.
The original shared text/selector regressions now run in `@stepdoc/core`.

`@stepdoc/schema/pairing` owns the strict private extension pairing protocol,
public metadata projection and version-1 private connection record. It is
separate from guide@1 and the public HTTP contract. Only the vault record has a
token; public state and commands do not accept unexpected credential fields.

`@stepdoc/schema/capture-target` owns private origin/tab/browser-session selection
and start DTOs. It rejects titles, paths, query strings, credentials and unexpected
value fields. These controls do not change guide@1 or Storage API v1.

`@stepdoc/schema/capture-destination` owns private browser/server choices,
optimistic save commands and metadata-only receipts. A server choice binds the
exact installation, device and private-vault generation. Tokens and unexpected
fields are rejected. An absent choice on an older capture means this browser;
retained write intent prevents editing a capture whose server commit is uncertain.

The existing `/sessions` response has a typed client projection in
`@stepdoc/schema/storage-api`. Guide parsing also creates independent mutable
array defaults for each document; editing one guide cannot change another
guide's omitted redactions, variables, tags, preconditions or publish targets.
Wire defaults and identifiers are unchanged; see CHANGELOG.md for the version
and migration note.

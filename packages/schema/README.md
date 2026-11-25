# @stepdoc/schema

`@stepdoc/schema` exports the guide@1 Zod schemas, inferred input/output types,
schema ID/URL and source JSON Schema (`docs/v2/guide.schema.json`). The Zod/Ajv
fixture suite proves contract parity. Typed fill input is represented only by
variable/secret references; secret examples and fill literals are rejected.

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

Run `pnpm --filter @stepdoc/schema test` for Ajv/Zod privacy and migration checks.
The original shared text/selector regressions now run in `@stepdoc/core`.

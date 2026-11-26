# @stepdoc/schema

## 0.1.0 — Initial guide@1 implementation

Wire identifier: `stepdoc/guide@1`. Guide `version` is its optimistic-concurrency
revision, not the schema version.

M11's E06 popup reuses existing capture preferences, clocks, review drafts and
guide@1 saves. Its private review-open command checks the current session and
review phase, adding no persisted fields, public endpoints or defaults. No
guide-data migration, identifier change or version bump is needed.

M11's recording pill adds bounded private control/view DTOs and an optional
extension review-state clock (`elapsedMs`, `runningSince`). It records active
segments at state transitions only, excluding pause, startup and queue draining.
Older in-progress captures without a clock display an unavailable time until a
new segment starts. This metadata is never part of guide@1 or its exports.
No guide fields/defaults, identifier, public API or database layout changes;
no guide-data migration or version bump is needed.

M11 Guide Me adds the private `@stepdoc/schema/guide-me` message projection and
populates the existing `verification` object with runner `guide-me`. New local
captures retain their sanitized parent URL in the existing `preconditions`
array, so a first action inside a frame still opens its parent page. Existing
guides remain valid and use their root-step/app/first-step URL as a fallback.
No guide fields, defaults, schema identifier, database layout or public endpoint
change; no persisted-data migration or version bump is needed.

M11's private capture transport adds strict bounded review commands and capture
preferences. The review produces the existing guide@1 variable declarations,
notes, manual steps, source-pixel masks and original/rendered image references.
Local capture import atomically writes that same document, history and client-
processed blobs. No guide fields/defaults, public endpoints, schema identifier
or database layout change; no persisted-data migration or version bump is needed.

M11 adds the isolated `@stepdoc/schema/capture` entry point for ephemeral
`stepdoc/capture@1` extension messages: bounded local events, frame geometry and
nonce-only probes. It rejects extra value/text fields and unknown input types.
Only the existing guide@1 Step projection is persisted; applied mask rectangles
use the existing source-image-pixel `redactions` fields. Guide JSON Schema,
Storage API, identifiers and defaults are unchanged. No guide-data version bump
or migration is needed for this private transport.

The Smart Blur producer populates existing auto/policy/manual redaction fields;
matched text is never part of a guide or transport DTO. Manual-change messages
carry only the session/document UUIDs and a bounded count so the recorder can
invalidate older cached pixels. This adds no guide fields/defaults, Storage API
endpoint or schema identifier and requires no persisted-data migration.

M10 completes the renderer for the existing optional `rectangle.text`: a nonempty
value adds a rounded caption to the outlined target. Existing optional `toX`/`toY`
place that caption, defaulting to below the rectangle; arrow endpoints retain
their meaning. Numeric geometry stays in image pixels. No fields, defaults,
validation constraints or identifiers change, so no persisted-data migration is
needed. Rectangles use token-rounded outlines; plain text annotations stay plain.

M9 consolidation adds the isolated `@stepdoc/schema/legacy-v1` entry point for the
unchanged v1 API/capture schemas moved from `packages/shared`. Root guide@1 exports,
wire formats, defaults and migration output are unchanged; no version bump or
persisted-data migration is needed for this source/package relocation.

This first implementation tightens the previously documentation-only contract:
fill steps require a named variable or secret; literals are limited to select
options and key names; tagged values require their matching payload; secret
definitions reject examples; annotation, edit and click objects reject unknown
properties. JSON Schema and Zod enforce the same constraints. Defaults normalize
Zod output without mutating the input; JSON Schema defaults remain annotations.

`migrations/v1-to-guide1.ts` upgrades shipped v1 database rows to this contract.
It preserves IDs, ordering, instructions, dates, click geometry, edit layers and
public IDs; maps metadata to replay targets and blur layers to manual redactions;
declares fill variables without reading typed values; removes URL credentials,
queries, fragments and signed image URLs. Screenshot dimensions must be supplied
from the client, and edited images must already have a flattened blob. Missing
image metadata fails explicitly rather than guessing dimensions or losing images.

No guide@1 implementation or persisted guide@1 data shipped before this version,
so there is no earlier guide@1 data migration. Future incompatible wire changes
must introduce a new schema identifier and migration.

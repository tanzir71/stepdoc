# @stepdoc/schema

## 0.1.0 — Initial guide@1 implementation

Wire identifier: `stepdoc/guide@1`. Guide `version` is its optimistic-concurrency
revision, not the schema version.

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

# Portable editing bundle v1

`.stepdoc` is a ZIP with media type `application/vnd.stepdoc+zip`. Its wrapper
identifier is `stepdoc/bundle@1`; the document inside remains `stepdoc/guide@1`.
This adds no guide fields and requires no guide migration.

The archive contains:

- `manifest.json`: exactly `{ "format": "stepdoc/bundle@1", "files": { ... } }`.
  `files` maps every other archive path to its lowercase hexadecimal SHA-256.
  The manifest does not hash itself.
- `guide.json`: a validated guide with sequential step indices, portable image
  paths, variable/secret references and authored edit/redaction metadata.
- `img/step-N.png` or `.webp`: the flattened rendered screenshot for step N.
- Optional `img/step-N-original.png` or `.webp`: the full-size, **already
  redacted** source needed to edit crop/annotations. A declared source must be
  present. Removing a blur cannot restore its pixels.

Only those paths are accepted. Every referenced image must exist exactly once,
and unreferenced files, duplicate entries, traversal, remote paths and SVGs are
rejected. The guide uses the same privacy validation as public exports: captured
fill/upload inputs are runtime references; HTTP credentials, queries and fragments
are stripped. Bundles retain private editing metadata and redacted sources;
ordinary HTML, Word, Markdown, JSON and skill exports omit source-image references.
Neither format contains native version history, access tokens or workspace keys.

The client verifies the complete ZIP directory before inflation: local/central
metadata, contiguous non-overlapping records, names, declared sizes and CRC-32.
STORE and DEFLATE are supported, including ordinary data descriptors. Encrypted,
multi-disk and ZIP64 archives are unsupported. Actual inflated bytes are bounded
even when size headers lie. SHA-256 verifies each payload against the manifest;
these checks detect corruption, **not publisher authenticity**.

Limits are 256 MiB for the archive and total expanded content, 64 MiB per image,
8 MiB per JSON file and 1002 entries. Raster signatures/dimensions must match PNG
or WebP, with at most 16,384 pixels per edge and 64 million pixels per image.
Import then performs native decoding and applies all non-kept redactions again
in the browser worker before storing any pixels. Unsupported or damaged images
fail without creating a guide.

Import writes through `IndexedDbAdapter` with fresh owner-scoped blob keys.
An existing guide ID offers a separate copy; it is never overwritten. Copies get
fresh guide identity and private publishing state. Cancellation or a write error
triggers cleanup of only the newly created record; existing guides remain intact. This
is not a crash-atomic transaction across every blob write: terminated writes can
leave unreachable files for the M15 storage-maintenance work. Import does not
restore the source workspace's version history.

Exports/import parsing run in a cancellable module worker with a 60-second job
timeout. No server receives or processes pixels, and no URL from a bundle is
fetched. Core tests exercise corruption, dishonest compression headers, privacy
violations with valid hashes and invalid paths; native Chromium tests exercise
editable round-trip, duplicate copies and cancellation.

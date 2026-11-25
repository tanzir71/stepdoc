# @stepdoc/core

Pure guide logic shared by the extension, SPA, exporters and replay tools.

- `describeStep(metadata)` keeps the v1 capture wording. `describeGuideStep(step)`
  generates instructions from guide@1 actions and accessible names. Fill/upload
  value payloads are never read; legacy input/textarea innerText is ignored.
  Missing labels/options/keys are flagged.
- `buildSelector(element)` supplies an escaped CSS fallback within the element's
  document or shadow root. IDs/test IDs must identify that exact element uniquely;
  duplicate names get sibling positions. It never reads input values.
- `rankLocators(candidates, countMatches?)` returns normalized, deduplicated copies.
  It prefers unique, exact matches, then role+name, test ID and accessible labels,
  with CSS/XPath as fallbacks. A local resolver supplies counts within the target's
  frame/shadow root: zero matches are removed, one is unique, multiple are ambiguous.
  Without a resolver, absent uniqueness stays unverified. Syntax errors discard the
  affected locator; unrelated resolver errors propagate. Ties retain capture order.
- `isFragileLocator(locator)` identifies structural, partial, unnamed, ambiguous or
  unverified locators for the inspector's review badge.
- `createRedactionDetector(options)` compiles client-side rules and returns a visible-text
  scanner. Its results contain only category, rule/source and UTF-16 offsets, for mapping
  to DOM `Range` rectangles; matched strings are never returned or logged. Categories:
  Unicode email, phones, Luhn-checked 13–19 digit cards, country-length/mod-97 IBANs,
  prefixed/JWT/high-entropy tokens, and IPv4/IPv6/MAC (grouped as `ip` in guide@1).
  Phone parsing defaults to US national dialing and supports an explicit country override
  and international numbers. Entropy is a heuristic; the default is 3.5 bits/character
  on mixed-class strings of at least 32 characters. Strong token prefixes do not require
  high entropy. Overlapping detector/policy spans remain visible for review.
- `redactSensitiveText(text, spans)` masks the union of those ranges with `[REDACTED]`,
  without changing source spans. The scanner has no DOM/storage/network dependencies:
  callers must supply visible text, never form values. DOM collection, field masks,
  rectangle mapping and capture integration remain part of M11.
- `prepareCapture(blob, options)` creates a masked original and a separate cropped,
  annotated render with `OffscreenCanvas`; `flattenImage(blob, options)` returns just
  the render when an original is already stored. Both accept raster PNG/JPEG/WebP
  blobs and encode fresh PNG or WebP blobs with their actual pixel dimensions. No
  raw source blob is returned, and mask state is snapshotted before async decoding.
  All supplied `redactions` are image-pixel rectangles; capture `sensitiveRects` alone
  use CSS pixels scaled by `devicePixelRatio`. Masks are clipped/rounded outward and
  burned into the full original before cropping, annotations or click markers.
  The caller's review/policy layer selects which mask rectangles to supply.
  Pixelation defaults to 14-pixel cells; opaque masks use `redactionMode: 'solid'`.
  Crop/rectangle/arrow/text/pin/click geometry uses original image coordinates.
  Accent, mask and pin colors come from the design tokens (light default/dark);
  annotation colors can override the accent. Text uses the token font stack or
  `fontFamily`; the caller loads self-hosted fonts into its worker FontFaceSet.

Canvas processing has no document, image URL loader, server or image-library path.
It closes decoded bitmaps and releases temporary canvases on success/failure.
Limits: 64 MB encoded input, 16,384 pixels per edge, 64 million decoded/output pixels,
1000 mask/annotation layers and 5000 characters per text layer. Invalid geometry,
unavailable capabilities and decode/render/encode failures throw a sanitized
`CanvasImageError`; no partially processed image is returned. Unsupported input
formats, empty/outside crops and invalid colors are rejected. The extension's v1
image adapter now uses this shared path and accepts only local raster data URLs.

Custom rules use [RE2JS](https://github.com/le0pard/re2js), with RE2 syntax and `i`, `m`,
`s` flags (`g`/`u` are accepted for global Unicode scanning). Backreferences and lookarounds
are rejected; the opt-in lookbehind extension is disabled. Rules are bounded to 32 rules,
512 source characters each, 2048 compiled instructions each and 10,000 total instructions.
Each scan accepts at most 250,000 UTF-16 units and 10,000 findings. Invalid/zero-width
rules, excessive input/matches and dependency failures throw a sanitized
`RedactionDetectionError`; callers must block capture/upload on failure, rather than
continue with partial redaction. Error messages/causes never forward rule source or input.
IBAN lengths come from the pinned [IBANTools](https://github.com/Simplify/ibantools) data;
phone metadata/search use the pinned [libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js)
`min` build. Checksum/format detection does not assert that an account or number exists.

The v1 shared package forwards its text/selector imports to this implementation
until the remaining shared schemas are folded into `@stepdoc/schema` during M9.
The complete guide@1 capture pipeline, frame chain and accessible-name collection
are scheduled for M11; callers supply semantic locator candidates and counts here.

Run `pnpm --filter @stepdoc/core test` for rules, privacy and DOM regressions plus
`test:browser`, which bundles the detector and compositor in memory and verifies
masking, real decoded pixels, offsets, image-layer behavior, the extension adapter,
failure paths and zero HTTP requests in real Chromium module workers.

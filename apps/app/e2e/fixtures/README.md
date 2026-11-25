# Fictional screenshot fixtures

The PNGs are screenshots of the fictional Ledgerly mock within the owner-supplied StepDoc Figma file `lTCFRrrKJb415s0nSxKE3B`, not a Ledgerly implementation or real captured customer data. They were downloaded through the Figma MCP screenshot tool with `contentsOnly: true` from nodes `16:1167`, `16:1315`, `16:1463`, `16:1611`, `16:1756`, `16:1901`, `16:2049`, `16:2197` respectively. Clipped/empty source nodes are preserved, including the 1×1 transparent images. No full application-frame screenshot is used as an implementation asset.

The test seeder writes these rendered PNGs to the native adapter and references the returned blob keys in actual guide@1 records. The files and seeder are excluded from the static production bundle.

`editor-original.png` is the 1280×800 mock screenshot at node `13:407` in the same file. The editor seeder passes it through the actual client worker with two masks before storing source/rendered blobs, creates nine actionable steps and twelve native versions, then opens step 3. Its annotations and targets are editable guide@1 data, not a full-frame UI image. This input also exercises worker image upload against the production bundle; it is never packaged in that bundle.

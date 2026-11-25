# Browser SPA

The extension builds this same source as its private `app.html` page. Native
extension links encode the logical route in `?route=...`, preserving reloads,
new tabs, copied URLs, back/forward and dirty-edit guards without a server rewrite.
Web-hosted paths retain `/g/:id/edit?step=...` and the existing route behavior.

Run `pnpm dev` from the repository root, then open http://127.0.0.1:3200. No environment file or service is needed. `pnpm dev:legacy` still runs the v1 Next app separately.

Implemented routes:

| Route | Behavior |
| --- | --- |
| `/` | Native browser library; search title, app, tags and authored step text |
| `/?status=draft` | Status filters, including `published`, `archived`, `needs-review`, `replay-passed` |
| `/?collections=1`, `/?collection=finance-ops` | Derived collection overview/filter |
| `/?view=list&sort=title&limit=all` | Deterministic layout, ordering and show-all state |
| `/?create=1` | Native manual-guide creation dialog |
| `/g/:id` | Private saved-guide preview and validated guide.json download |
| `/g/:id/edit?step=3&panel=target` | Local guide editor with Step, Target, Redact and History inspector panels |
| `/g/:id/edit?step=3&layer=annotation-0&tool=rectangle&zoom=100` | Selected layer, annotation tool and image scale |
| `/g/:id/edit?step=3&view=preview`, `?step=3&view=agent` | Semantic preview and portable agent text |
| `/g/:id/export?step=3&formats=html,docx,bundle` | W05 native export dialog; selected formats persist in the URL |
| `/settings/general` | Light (default), Dark, System and browser-storage information |

Guides use `IndexedDbAdapter`; rendered images load only through its blob API. Imported JSON never triggers a request to a screenshot URL. JSON import/download contains guide metadata; images are separate and missing images have an explicit fallback. JSON and `.stepdoc` imports offer a separate copy for duplicate IDs and keep the saved record. Bundle imports verify bounded ZIP metadata, CRCs, manifest hashes and guide/image contracts before decoding/re-masking pixels locally and assigning fresh native blob keys. Import can be cancelled; ordinary failures remove only the new partial guide. See the [bundle format and limits](../../docs/v2/bundle-format.md).

**Export & publish** saves the editor's pending changes before opening W05. Download choices are self-contained HTML (embedded PNGs and Geist fonts), Markdown with images, editable DOCX, `.stepdoc`, guide JSON, Playwright and a SKILL folder. Multiple files share one ZIP; JSON/Playwright-only exports work without image reads. PDF uses a separate **Print PDF** action with A4 print CSS and native browser printing. Copy text offers Markdown, rich HTML with images, and HTML source. These operations run locally, expose cancellation/errors and mirror feedback to the activity log. Public formats use freshly flattened/redacted pixels; the private bundle can also retain an already-redacted full-size source and editing metadata.

Browser mode's sharing card copies a **local** link and shows Private. GitHub/Cloudflare cards select actual downloadable files; they do not connect an account or publish a site. The publisher and published-site shell belong to M16. The editor route and Word generator load in separate chunks; missing route chunks offer a reload control.

The editor saves after 600 ms or Ctrl/Cmd+S through one serialized, optimistic writer. It preserves edits arriving during a save, invalidates outdated replay results, and writes immutable native history. Concurrent tabs can merge independent changes, keep a separate guide with copied blobs, reload explicitly or download working-copy JSON. Storage failures retain the working copy and offer Retry. Link and browser-back navigation ask before leaving unsaved work. Undo/Redo applies to the current session; saved-version restore belongs to M15.

All steps remain in the DOM with search, drag reordering and Alt+Up/Down. Screenshot tools work through an OffscreenCanvas module worker with the local Geist font. Selected redactions burn into the full-size source before either source or flattened image is stored; removing a saved blur cannot recover pixels. Every layer has keyboard selection and numeric geometry fields. Uploaded images are processed locally, and replacing an image can recover from a missing source. A selected step's locator order and generated line share the core replay generator; clipboard export includes the executable fallback helpers. Fill/upload actions reference variables or secrets without value fields. Page URLs always strip credentials, query and fragment. Local title cleanup uses deterministic rules; provider AI, extension highlighting/Guide Me, publishing and history restore remain later milestones.

Rectangles can have an optional caption. Its **Label x/y** fields place the caption
in source-image pixels, with a default below the outlined target. Clear its text
to keep only the outline. Pointer dragging and Alt+arrow layer nudges move the
rectangle and caption together. The image worker loads Geist's full variable-weight
range; the same client compositor generates editor, export and portable-bundle pixels.

The initial library page shows eight records, with an ordinary **Show all** button. No guides are virtualized. Collection shortcuts show the three largest collections; the Collections route lists all. Ctrl/Cmd+K focuses search, arrow/Home/End keys select status/theme tabs, Escape closes native dialogs, and route changes move focus to main. Notifications also appear in the live region and session activity log. A loaded page continues using its native store while offline; this unit does not supply a service worker or promise offline page reloads.

`pnpm --filter @stepdoc/app test` runs model/controller/privacy checks and Chromium flows/a11y snapshots. `pnpm test:a11y` runs the route accessibility gate. `pnpm --filter @stepdoc/app build` builds the static assets and automatically serves that actual bundle on an ephemeral local port to verify creation, native persistence, editor saves, worker image upload, deep-link reload, compiled-worker DOCX/bundle export, bundle re-import as a separate copy, fonts and local-only resource requests. Hosts must serve `index.html` for app routes; server targets add that routing in later milestones.

The `e2e/` HTML/modules and fictional guide/image fixtures are Vite development test inputs, excluded from production. They seed the real adapter, rather than replacing it with an in-memory fake. See [visual evidence](../../docs/v2/screens/README.md).

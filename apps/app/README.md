# Browser SPA (M10 in progress)

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
| `/settings/general` | Light (default), Dark, System and browser-storage information |

Guides use `IndexedDbAdapter`; rendered images load only through its blob API. Imported JSON never triggers a request to a screenshot URL. JSON import/download contains guide metadata; images are separate and missing images have an explicit fallback. Duplicate imports offer a new copy and keep the saved record. `.stepdoc` bundles, image import, the editor and the full export dialog are subsequent M10 units.

The initial library page shows eight records, with an ordinary **Show all** button. No guides are virtualized. Collection shortcuts show the three largest collections; the Collections route lists all. Ctrl/Cmd+K focuses search, arrow/Home/End keys select status/theme tabs, Escape closes native dialogs, and route changes move focus to main. Notifications also appear in the live region and session activity log. A loaded page continues using its native store while offline; this unit does not supply a service worker or promise offline page reloads.

`pnpm --filter @stepdoc/app test` runs model/privacy checks and Chromium flows/a11y snapshots. `pnpm test:a11y` runs the route accessibility gate. `pnpm --filter @stepdoc/app build` builds the static assets and automatically serves that actual bundle on an ephemeral local port to verify creation, native persistence, deep-link reload, fonts and local-only resource requests. Hosts must serve `index.html` for app routes; server targets add that routing in later milestones.

The `e2e/` HTML/modules and fictional guide/image fixtures are Vite development test inputs, excluded from production. They seed the real adapter, rather than replacing it with an in-memory fake. See [visual evidence](../../docs/v2/screens/README.md).

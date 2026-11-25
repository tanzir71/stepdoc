# StepDoc extension

WXT builds one MV3 codebase for Chrome/Edge (side panel) and Firefox (popup).
The existing capture controls are retained during the M11 migration; the E01–E06
designs, v2 event metadata, review/local capture saving, pairing and Guide Me are
the next units. The local library and editor already run the actual shared SPA,
with native `IndexedDbAdapter` storage, at the private extension `app.html` page.
The **Open library** link opens it in a full tab.

```powershell
pnpm --filter @stepdoc/extension build -b chrome
pnpm --filter @stepdoc/extension build -b edge
pnpm --filter @stepdoc/extension build -b firefox
pnpm --filter @stepdoc/extension test:browser
```

Builds live under `.output/<browser>-mv3/` (ignored). `test:browser` builds all
three targets, runs `web-ext lint` against Firefox, then loads the real Chrome
extension in Playwright's bundled Chromium persistent context. Install that
test browser with `pnpm --filter @stepdoc/extension exec playwright install chromium`.
The test owns its temporary profile and local HTTP stub and closes both.
No owner browser, store upload, signing or deployment is involved.

The automated check verifies native local persistence, deep links/reload/new tab,
back/forward and dirty-navigation guards, original SVG/font resources, compiled
image/export workers under the default MV3 CSP, two-theme editor axe, and the
injected content script → screenshot queue → client compositor → v1 session
upload. It also tests failed-upload retention, recovery download, retry and cancel.
`pnpm verify` includes this check. Firefox lint currently reports two upstream
React DOM `innerHTML` implementation warnings; it has no errors or eval warnings.
StepDoc does not supply `dangerouslySetInnerHTML` or relax extension CSP.

The retained v1 destination is configured through **Settings → Web app URL**;
it still posts to `/api/sessions` and opens `/guides/:id/edit`. Its retry payload
stays in extension storage. The recovery JSON download uses a data URL because
MV3 service workers have no `URL.createObjectURL` API. V2 paired/local capture
destinations will replace the controls after their complete recording/review flow.

WXT entrypoints call explicit initializers, so build-time Node imports do not
touch browser globals. The pure capture queue lives at
`@stepdoc/core/capture-queue`; capture and settings use WXT's cross-browser API.
The app shares normal web routes; extension links encode that route in
`/app.html?route=...` so full reloads and native new tabs resolve real files.
Asset `?url` imports and worker constructors use Vite's explicit imports, avoiding
WXT's `import.meta.url` rewrite and keeping every resource in the bundle.

The original [v1 manual checklist](MANUAL_TEST.md) is historical only and is
superseded by automated local verification in `CODEX_HANDOFF_V2.md §0`.

# StepDoc extension

WXT builds one MV3 codebase for Chrome/Edge (side panel) and Firefox (popup).
The existing capture controls are retained during the M11 migration; the E01–E06
designs, review/local capture saving, pairing and Guide Me are the next units.
The recorder now also retains guide@1 event metadata. The local library and editor run the actual shared SPA,
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
`pnpm verify` includes this check. Firefox lint currently reports four upstream
React DOM `innerHTML` implementation warnings (two in the SPA bundle and two in
the shared-control content bundle); it has no errors or eval warnings.
StepDoc does not supply `dangerouslySetInnerHTML` or relax extension CSP.

The retained v1 destination is configured through **Settings → Web app URL**;
it still posts to `/api/sessions` and opens `/guides/:id/edit`. Its retry payload
stays in extension storage. The recovery JSON download uses a data URL because
MV3 service workers have no `URL.createObjectURL` API. V2 paired/local capture
destinations will replace the controls after their complete recording/review flow.
The v1 projection preserves static input types, uses a password hint for secret
references on ordinary controls, and retains the authoritative guide@1 caption;
the existing v1 migration can therefore keep those fields classified as secrets.

WXT entrypoints call explicit initializers, so build-time Node imports do not
touch browser globals. The pure capture queue lives at
`@stepdoc/core/capture-queue`; capture and settings use WXT's cross-browser API.
The app shares normal web routes; extension links encode that route in
`/app.html?route=...` so full reloads and native new tabs resolve real files.
Asset `?url` imports and worker constructors use Vite's explicit imports, avoiding
WXT's `import.meta.url` rewrite and keeping every resource in the bundle.

The original [v1 manual checklist](MANUAL_TEST.md) is historical only and is
superseded by automated local verification in `CODEX_HANDOFF_V2.md §0`.

Capture uses `@stepdoc/core/capture`: a bounded inert DOM mirror provides
`dom-accessibility-api` with labels/roles while omitting every control value and
editable descendant. Uniqueness is measured in the actual document/shadow root.
Steps use secret/variable references, select labels or key names; page URLs omit
credentials, queries and fragments. Cross-origin frame and open-shadow paths,
source-pixel click coordinates and scoped dialog/heading/SPA expectations are
retained in `capturedSteps`. The current server upload stays in the v1 format.

Only the selected recording tab can enqueue trusted actions. Fresh mandatory
field/frame masks (including opaque custom hosts) are collected before and after each native screenshot, and
only client-composited pixels enter storage or the queue's reusable-frame cache.
Activation epochs and post-capture tab/document checks discard ambiguous frames
even if tab selection changes away and back before the API returns.
Clearing a capture invalidates that cache, including in-flight work. Session
guards and a serialized writer protect restart/cancel and late expectations.
Document identity plus stripped URL deduplicates overlapping SPA notifications
while retaining a real reload at the same URL.
Metadata or mask limits stop capture and block upload, with a data-free live
status and badge. Tests exercise actual committed inputs, native keyboard
selection/Enter, shadow/frame clicks, SPA state, stored references, field pixels
and failure gating. A separate native core test installs throwing value-getter
proxies in the collector's execution world.

The frame broker uses `webNavigation` frame/document IDs and isolated-world
snapshots, including frames in open shadow roots. Same-origin children report
their unique parent selector; unresolved cross-origin children receive short-lived
nonce/token probes from their actual parent WindowProxy. Children consume these
before page listeners and identify themselves only through authenticated extension
runtime senders. No guide data, URL, text or page-supplied frame ID travels through
window messages. Identical-src siblings and redirects are never matched by URL.
`match_about_blank` and `match_origin_as_fallback` include inherited/opaque frames;
document.open/write listener removal is repaired with idempotent registration.

Masks map through border/scale offsets and clip at every ancestor viewport.
Unresolved receivers, unsupported transforms and animation/paint uncertainty
stay opaque; explicit collector errors/limits stop capture and block upload.
Snapshot geometry, mutations and document identities must remain stable across
the screenshot. A changing scene discards raw pixels and can reuse only an
already-processed image with its original applied source-pixel mask provenance.
Prewarming that cache before recording preserves the first immediate action;
unavailable event context stops instead of guessing selectors/click geometry.

The second loaded-extension suite owns two local HTTP origins and verifies
identical-src siblings, cross-origin shadow/nested frames, blank/srcdoc/sandbox
inheritance, hidden contexts, scale/borders/scroll clipping, private probes,
redaction pixels/provenance, deterministic camera races and missing/error cases.
Smart Blur now adds visible-text patterns through the same client compositor.
Inline-split/wrapped text, open roots, slots, SVG text and scrolling clips retain
native Range geometry. No matched characters leave the content collector.
Editable/form/hidden/off-screen content is omitted before text reads; detector,
geometry and resource errors stop capture and block upload.

While recording, **Alt+B** or **Choose element to blur** starts a picker across
all frames, including newly loaded ones. Click an element, or focus it and press
Enter/Space, to add a manual mask. The target's page action is suppressed.
**Esc** or **Done** exits the picker; chosen masks follow their elements until
the capture ends. The open-shadow toolbar uses shared Button/tokens and bundled
Geist bytes with its own font family, preserving page CSS/CSP and private app
resources. Controls/preview are omitted from metadata and hidden for native
screenshots. Status is live and reflected in the side panel/popup.

A new manual choice invalidates the processed-frame cache immediately. In-flight
work retries with current masks; the serialized writer rejects stale privacy
generations. A fresh camera failure cannot fall back to an image missing that
choice. Native tests hold the real camera while adding a mask to prove retry/order,
then force failure to prove upload blocking. A third loaded-extension suite also
checks strict page CSP, keyboard/pointer/cross-frame picking, no target activation,
stored text/manual pixels, wide/narrow axe and an exact aria snapshot, session
reset and actual text-collector limits. The complete E01–E06 recording/review,
pairing and reviewed local saving flows remain open.

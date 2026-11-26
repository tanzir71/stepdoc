# StepDoc extension

WXT builds one MV3 codebase for Chrome/Edge (side panel) and Firefox (popup).
The local E01/E02/E04 capture/review path and E03 Guide Me use shared React,
tokens, original Figma vectors and bundled Geist. E02 includes its recording
pill/timer, and E06 has its native local popup flow. Pairing, voice and cleanup
remain M11 work.
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
destinations share the reviewed local flow; paired hosts remain M11 work.
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
reset and actual text-collector limits. Local recording/review/saving, Guide Me
and popup flows are covered below; paired destinations remain M11 work.

## Guide Me (E03)

The extension-origin editor's **Guide Me** action flushes pending edits and opens
one live tab. New captures retain their sanitized parent URL in the existing
preconditions array, including frame-first workflows. Role/name lookup comes
first, followed by ranked locators. The inert metadata mirror handles labels,
text and XPath without editable text or control values. CSS fallback traverses
open roots; authenticated frame identities supply cross-origin projection. A
missing, ambiguous or unsupported context offers manual confirmation or Skip.

Trusted target clicks, double clicks, hover, check/uncheck, committed fill,
select-label changes, upload changes and named control keys advance the run.
Fill matching observes only that an input event was committed; it never reads,
stores or compares its value. Printable key contents are not observed. Manual,
wait/assert or otherwise unsupported interactions use **I did it** or **Skip**.
Back clears later outcomes; Escape/end or closing the live tab records pending
steps as failed. A pass can include explicitly manual confirmations, which both
surfaces count; it is an interaction walkthrough rather than assertion replay.

The local guide receives the existing verification object with runner
`guide-me`. A stable report intent survives save retry, and optimistic version
checks preserve newer editor changes. A clean editor refreshes after the native
commit; dirty edits remain intact. Server/HttpAdapter write-back stays in M15.
Capture and walkthrough runs cannot overlap. Only the current step description
is rendered on the live page; screenshots and full guide data stay private.

`verify-guide.mjs` drives the actual imported-guide editor bridge and loaded
extension against two local origins with strict CSP. It covers trusted input,
select/key/click, open roots, same/cross-origin frame geometry, stale/forged
matches, missing/manual/skip/back, local report failure/retry, editor conflicts,
frame-first starts, Escape, narrow geometry, aria/axe and original-icon pixels.
The tooltip's two original SVG files use the public glyph allowlist; app pages, chunks,
fonts and stored guides remain private. WXT keeps their source names/hashes in
content bundles; no inline vector reconstruction or relaxed CSP is used.

Alt+B arms source-page privacy synchronously. Pending mode changes keep selection
active across older state broadcasts, and turning it off waits for the background
acknowledgement. The native blur test holds both a real camera result and the
background mode write, selects a new mask before that write completes, and proves
that the accepted screenshot is retried with the added mask.

## Recording pill and timer (E02)

The open-shadow in-page pill uses the original E02 dot/pause/stop vectors and
shared controls, fonts and tokens. Live counts reflect accepted processed steps.
Pause/Resume uses the same producer/queue transitions as the panel. Stop opens
the native review controls in a private extension tab (the popup entrypoint for
Firefox); a failed tab launch retains the draft and offers Open review retry.
Only trusted control clicks and the selected top-frame/session can issue pill
commands. Alt+Shift+S also works with keyboard focus inside the pill.

The panel header shows active recording time. A parallel labelled timer in the
pill's accessibility tree exposes the same duration without changing the E02
visual layout or announcing every tick. The clock persists active segments at
start/pause/resume/stop/error transitions, including background restarts and page
reloads; there are no per-second storage writes. Pauses and camera/queue draining
do not count. Old in-progress captures with no clock show `--:--` rather than a
fabricated history. Neither clock metadata nor pill commands enter guide JSON.

Both in-page control hosts are privately marked before insertion and hidden
before native camera collection, then restored on release. Their DOM and timer
mutations do not change capture metadata or privacy geometry. Alt+B temporarily
replaces the recorder pill with the picker, preserving room for each toolbar.
The public asset list contains just the two Guide Me and three recording glyphs;
private app resources, fonts and guide data remain private.

`verify-recording.mjs` exercises trusted source-page controls, counts, clock ticks
without writes, pause/reload/resume/reset, rejected forged controls, keyboard and
narrow layouts, strict-CSP original glyph pixels, omission of UI from stored
pixels and retained review launch/retry. Native capture uses an actual 1040×856
window; responsive emulation runs after camera checks. The reference timer uses
a fixed Date.now only inside the private renderer, leaving source and background
clocks real. Every loaded-extension script activates its newly announced service
worker through an actual private-page message, then waits for real Chrome API
bindings before accessing it. Private panel/editor proxy tabs are brought to the
foreground for their controls, matching the visibility of the actual side panel.

## Popup fallback (E06)

The 360×560 popup uses the compact E06 header, 44px record control, two preference
switches, two actual recent guides and 28px library/pair actions. It retains the
original record/file/grid/link vectors, logo, toggle images and badge dot at their
native dimensions. Pair server opens E05 in a private full tab. The activity log
and status remain accessible.
Capture panels use the shared app's saved Light/Dark/System preference and react
to changes from another native workspace tab or the system theme.

Recording lives in the background, so closing the popup does not stop capture.
Reopening reflects the same session, processed steps, clock and pause state.
Stop opens `/popup.html?surface=tab&view=review` in a full tab; review launch failure
retains the draft with an Open review action. The private open command requires
the current session and review phase. Source pages cannot invoke it. Editing and
saving use the existing native review/import flow and open the shared editor.

The private fallback page ships in all three builds. Chrome/Edge still have no
default action popup and retain their side panel; Firefox's manifest selects the
popup. `verify-popup.mjs` assigns that unchanged private page to the action only
inside its isolated Chromium test profile, then opens a real native action popup.
Those targets are outside Playwright's tab inventory, so the fixture attaches with
CDP and drives native input. It checks actual painted pixels, AX trees/axe,
keyboard preferences, close/reopen during capture, library/editor links, rejected
source/stale/phase commands, failed review launch/retry, Escape and native saving.
The same renderer supplies light/dark reference captures and narrow axe coverage.
Firefox remains build plus `web-ext lint`; no owner testing or signing is required.

## Private server pairing (E05)

`?view=pair` implements the original 400×900 E05 form with six labelled code
fields, whole-code paste, keyboard navigation, cancellation and local-mode exit.
E01 opens it in the panel; E06 opens `/popup.html?surface=tab&view=pair`.
It checks anonymous Storage API health, claims the one-use code for the actual
extension origin and accepts exactly `capture:write, guides:read`.

The background stores one schema-validated credential in extension-origin
IndexedDB (`stepdoc-connections-v1`, record version 1). Tokens never enter
`chrome.storage`, control/content state, guide data, exports, URLs or logs.
Content scripts' IndexedDB belongs to the host page, as described in the
[Chrome storage documentation](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies).
The native fixture proves that boundary with the actual content execution world.
Public connection metadata is explicitly projected; private commands require an
extension-page sender, and UI broadcasts reject content-page senders. This is
browser origin isolation, not client-side encryption or forensic erasure.

Reload retains the connection. Check connection uses a fresh private bearer and
retains credentials on revoked/unavailable errors so the user can pair again.
Forget removes the local credential after a native confirmation; revocation is
performed on the server's Devices & tokens page. It leaves local guides intact.
Generation checks prevent stale windows from replacing/forgetting a newer record;
cancellation aborts HTTP and guards the final transaction against late responses.
Pairing and capture/review/walkthrough transitions exclude each other. Corrupt
records can be forgotten without allowing recovery to overwrite a valid record.

`verify-pairing.mjs` loads the real production extension against a local HTTP
fixture. It checks geometry/original painted vectors, light/dark/narrow/dialog
aria and axe, paste/keyboard, private persistence, content-world authorization,
cookie/referrer-free requests, cancellation, stale generations, recovery and
popup/full-tab navigation. Captures still save locally: scoped server capture
upload, destination selection and paired editor integration remain M11 work.

## Frame graph transitions

A browser document/iframe replacement during metadata collection has a private
typed error. Capture retries up to three entire before/image/after attempts and
discards the failed candidate each time. The first attempt's activation identity
is retained across retries. Missing or invalid masks and repeated changes still
stop capture; no partial scene or raw image is reused. The native frame suite
forces a post-camera graph change with an undecodable first candidate and proves
that a second fresh native result is processed with the correct masked pixels.

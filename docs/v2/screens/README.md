# M10 app visual evidence

`W02-library-light.png` and `W02-library-dark.png` are actual Chromium screenshots of the SPA at 1440×900, compared by the coding agent with Figma W02 (`16:944`) and W12 (`25:4924`). The test checks the reference's sidebar (248px), header (104px), filter area (56px), grid origin (280,160), four 270px cards and 152px thumbnails. Local Geist/Geist Mono and original Figma SVG assets are used. The saved guides, badge counts, collection totals and screenshot blobs come from 48 real adapter records in an isolated test browser.

Browser mode intentionally says “This browser”, “Local storage” and “New guide”, provides Drafts/Published/Archived navigation and describes current JSON agent exports. It has no team identity, shared inbox, connected MCP clients or passkey account to claim. The native Show all and Activity controls are functional additions. Collection names fit with ellipsis while their complete text remains in the accessibility tree. Status text/overlay labels use the AA adjustments documented in `packages/ui/README.md`.

`W03-editor-light.png` and `W03-editor-dark.png` show the local editor at the same 1440×900 viewport, compared with the full W03 context (`16:2340`). Geometry checks cover the 56px topbar, 320px steps pane, 340px inspector and 680×425 screenshot. The toolbar, original SVG icons, fonts, token surfaces, selected StepRow, locator list and layers follow that reference. The image is the fictional Ledgerly screenshot input, processed by the real worker and stored through the native adapter; it is not a rendered application frame. Step thumbnails use the actual rendered blob for each step. Section eyebrows appear for actual `section` steps; this nine-action fixture does not invent section records.

Current browser-mode controls read “Read guide”, “Copy link” and “Export & publish”. They perform local navigation/link copying and open the functional W05 export dialog; extension replay and real publishing remain later milestones. Clean up describes local text rules; Open live page opens a sanitized URL without claiming extension highlighting. Query stripping is a locked browser policy. Only floating layers receive shadows.

The final audit completes the “Owners only” treatment: one rectangle layer owns
the outlined target and rounded caption, using existing guide@1 `text` and
`toX`/`toY` fields. The real compositor produces the token-rounded outline and
an approximately 86×24px caption at (846,272) in the 680×425 screenshot. A native
pixel-bounds assertion checks its image coordinates/size, and the full variable
Geist weight range is loaded in the image worker. Numeric Label x/y fields and
Alt+arrow nudging keep the caption operable without dragging. Optional add/replace
controls below the layer list provide the required agent path. No new guide field
or migration is needed; ordinary text stays a separate, plain-text tool.

`W05-export-light.png` and `W05-export-dark.png` show the actual dialog over W03,
compared with full Figma W05 context (`22:2562`). At 1440×900 the dialog is
920×576 at (260,96), with a 90px header, 418px body and 68px footer; download
cards are 212px, and the right column is 380px. Seven additional unmodified source
SVGs retain their 14/16/18px roots. Agent badges omit the dot as in the reference;
their text has the documented AA adjustment on selected cards. The native dialog's
initial focus ring is visible on Close. Layout stacks on narrow viewports.

Local capabilities replace the reference's fictional connected repository/public
state: Local link says “This browser only”, its public toggle is disabled, and
Private remains visible. Copy text opens a keyboard-operable Markdown/rich/HTML
menu. Hosting cards select real downloadable documents/replay/skill/HTML files and
explain that downloads do not publish. The footer counts file downloads and offers
native PDF printing separately, rather than claiming a live publish action. Format
selection is URL state; feedback and cancellation use real workers and the activity
log. All images flatten/redact locally.

## Final M10 comparison

The six committed captures were inspected against the linked Figma frames on
26 Nov 2026. W02/W12 source context was expanded into both sidebars, headers,
filters and every visible guide card; W03 and W05 used their full source context.
The dark editor/export apply the W12 palette and shared tokens to the same layout.

| Screen | Measured match | Native evidence |
| --- | --- | --- |
| W02 / W12 | Sidebar/header/filter/grid/card geometry; original vectors, fonts and themed surfaces | Both 1440×900 captures, local data/thumbnail reads, every visible SVG callsite and dimension |
| W03 | Pane/image/toolbar geometry, grouped outline/caption, step/layer components and target inspector | Both captures, caption pixel bounds, numeric edit/clear persistence, whole-layer keyboard movement and caption selection |
| W05 | Dialog/card/column/header/footer geometry, original vectors, format and target controls | Both captures, URL format state, native downloads/clipboard/printing and recoverable error states |

All 76 source SVG references across those contexts are retained locally within
the 95-asset inventory. Four W12 color variants are proven by native PNG comparison
to have exactly the same intrinsic silhouettes as the shared recolorable masks.
Component checks verify nonempty files/root dimensions; screen checks attach a
per-theme JSON record of source files, callsites and effective geometry. Original
SVGs remain unmodified. Native guide imagery, section records and capability copy
stay data-driven as described above. Browser-mode copy and interactions reflect
those native capabilities. The M10 comparison has no remaining visual item;
the complete app/publisher/extension scope continues in later milestones.

Recreate evidence using PowerShell:

```powershell
$env:STEPDOC_UPDATE_SCREENS = '1'
pnpm --filter @stepdoc/app exec playwright test e2e/visual.spec.ts
Remove-Item Env:STEPDOC_UPDATE_SCREENS
```

Normal verification writes screenshots only under ignored test results. No deployment or owner sign-off is involved.

## M11 Alt+B privacy state

Reference: [E02 recording controls](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=26-6696),
expanded from E02 `26:6061` on 26 Nov 2026. This additional picker state is absent
from the reference; it reuses the in-page pill's 16px top inset, 48px minimum
height, full radius, dark surface, floating shadow and 12/16 medium Geist label.
Shared `Button(kind=ghost,size=s)` supplies Done. Its longer instructions wrap at
390px with 16px margins. It contains no static icons/images, replacing no Figma
asset. The actual E02 recording/pause/review controls remain a later M11 unit.

`m11-blur-mode.png` and `m11-blur-mode-narrow.png` are cropped native captures of
this control on an empty fixture surface, with no third-party page content. Its explicit dark surface
matches the reference while the host page keeps its own theme. Geist loads from
bundled bytes under an isolated family; native tests verify it under `font-src
'none'` without network requests or public extension resources. The exact
`m11-blur-mode.aria.yml` and axe cover the open shadow tree; numeric assertions
verify inset/height/radius/surface/font/shadow and narrow containment. Pointer and
keyboard selection, Done/Esc (including focus inside the toolbar), side-panel
activation and newly loaded cross-origin frames use real browser events.

The capture pipeline hides the controls/preview for native screenshots and omits
their DOM, mutations and animation state. Pixel checks prove stored images contain
only the processed page. Recreate the two committed crops after a Chrome build:

```powershell
$env:STEPDOC_UPDATE_SCREENS = '1'
pnpm --filter @stepdoc/extension exec node scripts/verify-blur.mjs
Remove-Item Env:STEPDOC_UPDATE_SCREENS
```

Normal runs put these crops under ignored `test-results/screens`.

## M11 local capture and review

`m11-capture-idle.png`, `m11-capture-recording.png`, `m11-capture-paused.png`,
`m11-capture-review.png` and `m11-capture-empty-review.png` show the real extension
at 400×900. References read on 26 Nov 2026: E01 `26:5543`, E02 `26:6061`,
E04 `27:6690`, and the compact E06 `27:6897` in the same Figma file above. This
unit implements the complete local capture-to-editor path; it does not complete
all E01–E06 parity. The header is 52px, main inset 16px, record control 72px;
shared Button/Input/Toggle/Badge/Logo, Geist and ten additional original Figma
vectors supply the controls. Native assertions check panel geometry/font, exact
aria trees, light/dark axe, no horizontal overflow, keyboard reorder and dialogs.

Local mode displays “This browser” and real native recent guides. It suggests a
title from the sanitized page origin, without reading an account-specific page
title. Live thumbnails are the actual client-redacted captures of a local test
fixture. The screenshot content is not a built Ledgerly application. Review
counts come from stored masks/steps, and adjacent merge explicitly produces a
flagged manual instruction with the first screenshot. Keep local and Save & open
editor both commit the actual native workspace; the latter opens its SPA editor.
The native suite tests failures before the atomic commit and after commit before
editor launch, proving recoverable review and no duplicate version on retry.

Text on raised/dark surfaces uses the existing secondary-text token for AA
contrast; the Smart Blur notice keeps a green shield and a readable text token.
Main lists scroll inside the panel while all rows remain in the accessibility
tree. Footer status, activity log, native confirmations and discard are functional
additions. Paired destinations/E05, voice narration, cleanup suggestions, the
complete fallback evidence remain open in M11; the E02 pill/timer is documented below;
no fictional host, voice switch or cleanup result is presented as connected.

After a Chrome build, regenerate the five evidence captures and aria snapshots:

```powershell
$env:STEPDOC_UPDATE_SCREENS = '1'
pnpm --filter @stepdoc/extension exec node scripts/verify-review.mjs
Remove-Item Env:STEPDOC_UPDATE_SCREENS
```

Normal verification compares committed snapshots and writes only ignored PNGs.
The isolated Chromium profile uses a native 600×900 window and a 400px private
panel container, with no per-tab viewport emulation for captureVisibleTab to
reset. Native DevTools captures that 400×900 region; dimension and surface/header
pixel checks reject blank or incorrectly sized images. All real extension,
capture, storage and accessibility checks remain active. The saved-review
failure state locks draft edits after commit and offers the saved native editor.

## E03 Guide Me

Reference: Figma `26:6712`, third-party page 1040×856 and private panel 400×856.
`m11-guide-page.png`, `m11-guide-overlay.png` and `m11-guide-panel.png` capture the
real loaded extension against a local generic fixture, using E03's spacing,
330px tooltip, 24px pin, shared button sizes and original 16px/14px close/check
vectors. The fixture remains generic; Ledgerly is not implemented. The mask is
live measured geometry (not a redrawn fixed mock illustration), with an 8px
padding around the target and rounded accent ring. The full-page evidence and independent
frame-coordinate assertions verify its placement. Panel contents reflect the
actual imported ten-step guide; manual controls, status and activity are functional
additions. Narrow overlays scroll internally when their content exceeds the viewport.

The screenshot harness hosts the unchanged private panel entrypoint inside a
400×856 same-extension iframe, then captures that region through native DevTools.
The live page is captured at the reference's 1040×856 size. PNG dimensions and
per-icon painted pixels reject blank captures and CSP-blocked glyphs. The isolated
software-rendered window has enough native surface for the reference viewport;
bottom-mask and clear-cutout pixel assertions reject compositor clipping. Only the
two tooltip vectors belong to the small public glyph allowlist; original bytes are checked in all three
browser builds. Light/dark panel, narrow overlay and missing-target aria/axe run
alongside trusted interaction, privacy and real local write-back tests.

After a Chrome build, set `STEPDOC_UPDATE_SCREENS=1` and run
`pnpm --filter @stepdoc/extension exec node scripts/verify-guide.mjs` to regenerate
these captures and the committed `tests/guide/*.aria.txt` snapshots. Normal
verification writes only ignored evidence PNGs and compares the committed trees.

## E02 recording pill and timer

Reference: Figma E02 `26:6061`, pill `26:6696`. The real native pill is 48px tall,
with 14px/8px horizontal padding, 10px gaps, Geist Label/S, the original 8px red
dot and two original 16px glyphs in shared 32px IconButtons. It floats at 16px,
centred within the available live page; this adapts the mock's fixed x=370 to
variable viewport/count widths. Original glyphs use their native dimensions.
The dark surface uses tokens. Icon colours use the existing dark secondary-text
token for readable controls; the dot retains the light recording-red token.
Resume text and the retained Open review error action are functional additions.

`m11-recording-pill.png` captures the accepted three-step state;
`m11-recording-timer.png` captures the actual 400px header at `REC 00:41`. The
private renderer's clock is fixed only for that header reference. Background
clock transitions and the live page remain real, and tests assert ticking,
paused-time exclusion, reload, resume and new-session reset without per-second
storage writes. The existing recording/paused panel references and aria trees
include the new timer. Aria snapshots canonicalize its elapsed text after checking
its numeric format; focused native assertions test the actual changing value.

The loaded recording suite checks aria/axe for recording, paused, narrow and
review-launch-error states, exact glyph geometry and painted pixels under strict
page CSP, and clear fixture pixels beneath where the pill would have appeared in
the stored screenshot. Use `STEPDOC_UPDATE_SCREENS=1` with
`node apps/extension/scripts/verify-recording.mjs` after a Chrome build to regenerate
its reference PNGs/trees; normal runs write only ignored evidence PNGs.

## E06 popup fallback

Reference: Figma `27:6897`, the 360×560 popup itself. Its Figma screenshot includes
40px of presentation space around the frame; that surrounding background is not
product UI. `m11-popup-light.png` and `m11-popup-dark.png` render the real private
popup entrypoint at the frame dimensions. Native geometry asserts the 48px
header, start card at (14,62) sized 332×72, 44px record control at (28,76), Recent
at y=210 and library action at y=330. Switches stay 32×18; the original logo,
record/file/grid/link glyphs and badge dot retain their intrinsic dimensions.
Native popup screenshots independently prove every visible asset paints.

The recent titles come from guides created through the actual local app. The
fixture uses a generic integration-key title in place of the fictional Ledgerly
example. Pair server now opens the private full-tab E05 pairing flow. The
accessible activity log is a functional addition; secondary text tokens provide
AA contrast. The browser supplies the popup's external floating frame/shadow.

`verify-popup.mjs` opens a real Chromium extension-action popup using this common
production page. Native popups are not ordinary Playwright tabs: CDP attaches to
the announced target for trusted input, full accessibility trees, axe, geometry
and asset pixels. The OS/browser may constrain the native viewport below 560px;
the popup remains scrollable. Reference captures use the same renderer in a
360×560 private tab, followed by 320px overflow/axe checks. Light/Dark/System are
read from the real shared preference store, including native media changes.

Four committed native AX trees cover idle, recording, paused and retained review.
Only the numeric timer text is canonicalized. Run `STEPDOC_UPDATE_SCREENS=1` with
`node apps/extension/scripts/verify-popup.mjs` after a Chrome build to regenerate
the PNGs/trees. Normal verification compares trees and writes ignored PNGs.
The fixture also proves capture across popup closure/reopen and the full-tab
review → native save → editor reload path; Firefox is build/lint only, per §0.

## M11 E05 pairing

`m11-pair-light.png` and `m11-pair-dark.png` are native extension-page captures at
400×900, compared with E05 (`27:6826`). The fresh full Figma context supplies the
unchanged original pair/monitor/lock vectors; logo/settings reuse exact existing
assets. Tests assert the 52px header, heading at (16,76), 44×52 code cells at y268,
36px action at y338, 368×132 local card at (16,430) and 368×64 notice at (16,580).
All six visible asset instances have original dimensions and painted pixels.

The native focus ring, AA secondary notice text, Back/activity footer, connected
status/check/repair actions and Forget dialog are functional adaptations. E05
keeps its original form copy. Connection status accurately says captures remain
local until the scoped upload/destination unit is implemented. No fictional
third-party app is built. Five committed aria trees cover form, narrow, connected,
revoked and dialog states (form is shared across themes); axe runs in both themes
and at 320px. Dynamic local server origins are canonicalized in trees only.
Regenerate with `STEPDOC_UPDATE_SCREENS=1 node apps/extension/scripts/verify-pairing.mjs`
after a Chrome build. Ordinary verification compares trees and writes ignored
screenshots. The real HTTP/vault/source-world checks run in both modes.

## M11 full-tab capture source

`m11-capture-source-light.png` and `m11-capture-source-dark.png` show the private
full-tab return flow at 400×900. The fresh E01 context (`26:5543`) supplies the
existing logo, sliders, record glyph and tokens. The original 52px header, 16px
content gutters, Geist text, 30px record glyph and 16px settings glyph remain;
the native selector composes the shared Input's label and 36px field styles.
The source card and Refresh/Show actions are functional additions for full tabs.
E01's side panel and E06's compact popup retain their existing geometry. On wide
screens, the existing 640px full-tab maximum remains. No Ledgerly UI is built.

Five committed aria trees cover empty, ready, dark, narrow and invalid selections.
Local origins/tab numbers are canonicalized in trees; real command tests use
their actual browser identities. Axe and overflow checks run at 400px and 320px.
Regenerate with `STEPDOC_UPDATE_SCREENS=1 node apps/extension/scripts/verify-targets.mjs`
after a Chrome build. Normal runs compare trees and write ignored evidence PNGs.


## M17 L01/L02 public landing

`m17-landing-desktop.png` and `m17-landing-mobile.png` are native Chromium
captures at 1440×900 and 390×900 (full page), compared with L01 (`32:7455`)
and L02 (`33:7805`). Full high-fidelity context was read for every desktop
section and the mobile frame. The implemented page is native HTML/CSS/JS.
Shared Button, Badge, StepPin and Logo CSS, semantic tokens, and licensed
Geist/Geist Mono are reused. The 40px/44px mobile display style was added
to the central token source; core HTML snapshots gain only that token.

Desktop assertions cover all eleven section origins/heights: 72px navigation,
516px hero, 572px preview, 292px hosting, 672px workflow, 568px agent section,
380px privacy, 780px comparison, 288px FAQ, 312px CTA and 80px footer. Content
is 1200px wide at x120. The hero uses 68px/72px type; the original billing
mock sits at (148,770), 540×330, with the original 36px click marker.
Mobile has 20px gutters and exactly the reference section heights:
60/424/511/534/320/340/508/328/186/136px. Workflow is hidden as in L02.
Checks also cover 320/768/1024px layouts.

`site/assets/provenance.json` records unchanged Figma file/node slots,
intrinsic dimensions and SHA-256 for all 41 downloads (40 SVGs and the
1280×800 Ledgerly mock). The unused warning-Badge dot is an exported
component variant; the visible Live badge uses its original success dot.
Every visible asset callsite is checked for a nonempty local file, original
effective geometry and painted pixels. The shared Logo keeps its original
32px SVG transformed into its established 24px slot. Separate original
18px mobile and 20px desktop icons retain their root dimensions.

Functional adaptations: native keyboard dialog/FAQ and visible focus,
canonical guide@1 title/locator fields in the code example, real core-exported
HTML/JSON/Markdown/Playwright/SKILL downloads, source-install documentation
instead of an unavailable store listing, and explicit planned MCP/passkey
labels. The code sample is labelled an integration preview. The screenshot
is fictional content, not a rebuilt Ledgerly app or a verified live replay.
Navigation/cards retain the surface separation rule; reference preview
shadows are omitted because repository tokens permit shadows only on
floating layers. Shared accessible accent/status text and brighter code-panel
badge/comments satisfy AA; colours otherwise use the original semantic
tokens. A mobile-only line break preserves the CTA's reference wrapping.

The generated root landing avoids the former redirect while the earlier
`/site/` entry remains available. Asset links remain inside `/stepdoc/`.
Four committed aria trees cover desktop/mobile/menu/expanded FAQ; axe also
checks intermediate widths and mobile docs. Native keyboard tests cover
Enter, Escape, focus return and actual export navigation. JS-disabled reading
and all local resources/internal links pass without failed/external requests.

Run `STEPDOC_UPDATE_SITE=1 pnpm website:browser` to regenerate the aria
trees and the OG image from the actual local page. Normal checks compare
trees and write ignored PNG/layout/asset evidence under
`test-results/website/`. `pnpm website:verify` checks generated entries,
shared CSS/tokens/fonts/schema and byte-for-byte production demo output.
Local Lighthouse uses gzip text transport, verified against the existing
Pages response, and requires 95+ performance/accessibility on both mobile
and desktop. No workflow, deployment, repo setting or owner test is used.

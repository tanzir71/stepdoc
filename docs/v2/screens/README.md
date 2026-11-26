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

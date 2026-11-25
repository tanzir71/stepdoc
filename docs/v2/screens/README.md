# M10 app visual evidence

`W02-library-light.png` and `W02-library-dark.png` are actual Chromium screenshots of the SPA at 1440×900, compared by the coding agent with Figma W02 (`16:944`) and W12 (`25:4924`). The test checks the reference's sidebar (248px), header (104px), filter area (56px), grid origin (280,160), four 270px cards and 152px thumbnails. Local Geist/Geist Mono and original Figma SVG assets are used. The saved guides, badge counts, collection totals and screenshot blobs come from 48 real adapter records in an isolated test browser.

Browser mode intentionally says “This browser”, “Local storage” and “New guide”, provides Drafts/Published/Archived navigation and describes current JSON agent exports. It has no team identity, shared inbox, connected MCP clients or passkey account to claim. The native Show all and Activity controls are functional additions. Collection names fit with ellipsis while their complete text remains in the accessibility tree. Status text/overlay labels use the AA adjustments documented in `packages/ui/README.md`. The complete milestone parity audit remains open.

`W03-editor-light.png` and `W03-editor-dark.png` show the local editor at the same 1440×900 viewport, compared with the full W03 context (`16:2340`). Geometry checks cover the 56px topbar, 320px steps pane, 340px inspector and 680×425 screenshot. The toolbar, original SVG icons, fonts, token surfaces, selected StepRow, locator list and layers follow that reference. The image is the fictional Ledgerly screenshot input, processed by the real worker and stored through the native adapter; it is not a rendered application frame. Step thumbnails use the actual rendered blob for each step. Section eyebrows appear for actual `section` steps; this nine-action fixture does not invent section records.

Current browser-mode controls read “Read guide”, “Copy link” and “Export & publish”. They perform local navigation/link copying and open the functional W05 export dialog; extension replay and real publishing remain later milestones. Clean up describes local text rules; Open live page opens a sanitized URL without claiming extension highlighting. Query stripping is a locked browser policy. Only floating layers receive shadows. The plain text “Owners only” annotation uses the existing guide@1 canvas text primitive, rather than the reference's orange pill; matching that annotation treatment remains in the final parity audit.

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
log. All images flatten/redact locally. W05 evidence is complete; the overall M10
visual gate stays open for the annotation-pill treatment and final audit.

Recreate evidence using PowerShell:

```powershell
$env:STEPDOC_UPDATE_SCREENS = '1'
pnpm --filter @stepdoc/app exec playwright test e2e/visual.spec.ts
Remove-Item Env:STEPDOC_UPDATE_SCREENS
```

Normal verification writes screenshots only under ignored test results. No deployment or owner sign-off is involved.

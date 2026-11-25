# M10 library visual evidence

`W02-library-light.png` and `W02-library-dark.png` are actual Chromium screenshots of the SPA at 1440×900, compared by the coding agent with Figma W02 (`16:944`) and W12 (`25:4924`). The test checks the reference's sidebar (248px), header (104px), filter area (56px), grid origin (280,160), four 270px cards and 152px thumbnails. Local Geist/Geist Mono and original Figma SVG assets are used. The saved guides, badge counts, collection totals and screenshot blobs come from 48 real adapter records in an isolated test browser.

Browser mode intentionally says “This browser”, “Local storage” and “New guide”, provides Drafts/Published/Archived navigation and describes current JSON agent exports. It has no team identity, shared inbox, connected MCP clients or passkey account to claim. The native Show all and Activity controls are functional additions. Collection names fit with ellipsis while their complete text remains in the accessibility tree. Status text/overlay labels use the AA adjustments documented in `packages/ui/README.md`. The full W03/W05 parity gate remains open.

Recreate evidence using PowerShell:

```powershell
$env:STEPDOC_UPDATE_SCREENS = '1'
pnpm --filter @stepdoc/app exec playwright test e2e/visual.spec.ts
Remove-Item Env:STEPDOC_UPDATE_SCREENS
```

Normal verification writes screenshots only under ignored test results. No deployment or owner sign-off is involved.

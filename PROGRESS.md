# StepDoc progress

## Milestones

- [x] M0 — monorepo scaffold, strict tooling, migration, setup docs
- [x] M1 — capture MVP, screenshot queue, privacy blur, local recovery, shared tests
- [x] M2 — session persistence, guide list/viewer, automatic handoff
- [x] M3 — autosaving editor, reorder/delete/manual/section/share controls
- [x] M4 — non-destructive blur/crop/annotation layers and server rendering
- [x] M5 — Markdown ZIP, standalone HTML, print/PDF and clipboard-ready sharing
- [x] M6 — revocable UUID public route, embed snippet, non-public 404
- [x] M7 — responsive dark UI, keyboard entry, loading/error/empty states, validation
- [ ] M8 — ongoing refinements

## Backlog

- Add direct canvas handles for resizing every annotation and marker in both axes.
- Add a Playwright browser suite against a disposable local Supabase project.
- Add Shadow DOM and iframe capture adapters.
- Add automated Lighthouse CI once a seeded Supabase test project is available.

## Deviations

- PDF uses the browser's print-quality print path rather than a server-launched browser, avoiding deployment-specific Chromium binaries while preserving no-split screenshot CSS.
- The migration filename was created directly because the Supabase CLI is not installed/configured in this empty workspace; setup instructions apply it through the SQL editor.

## Run log

- 2026-07-10 — Built the complete initial StepDoc monorepo from the handoff: shared contracts, MV3 capture, Supabase APIs/storage, viewer/editor/image rendering, exports, sharing, responsive states, tests and documentation. `pnpm verify` passes (22 tests plus both production builds). Next: burn down the refinement backlog.

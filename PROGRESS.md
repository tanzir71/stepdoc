# StepDoc progress

> **Historical v1 progress.** Active work is tracked in `PROGRESS_V2.md`. The v1 live Supabase and system-Chrome checks below moved to its "Owner later (non-blocking)" list. They do not block v2 milestones; automated local checks replace all human-run acceptance checks under `CODEX_HANDOFF_V2.md` §0.

## M0 - Scaffold

- [x] pnpm monorepo, strict tooling, web and extension production builds
- [x] shared package consumed by both applications
- [x] Supabase migration and complete setup README

## M1 - Capture MVP

- [x] popup start/stop/cancel/retry, badge, same-tab navigation continuity
- [x] click/input/select/Enter metadata, screenshots, rule text, click marker
- [x] capture queue preserves rapid events and reuses a frame on throttling
- [x] sensitive DOM field pixelation before screenshot persistence
- [x] failed upload session persistence, retry, and local JSON download
- [x] 20+ selector cases and comprehensive pure capture/queue/privacy tests
- [ ] live unpacked-Chrome manual checklist executed

## M2 - Persistence and viewer

- [x] validated session API, database rows and private Storage upload pathing
- [x] searchable guide cards and lazy read-only viewer
- [x] extension opens the new guide editor
- [x] Playwright API/list/viewer test with a 30-step guide
- [ ] live Supabase integration executed

## M3 - Editor

- [x] inline title/description/step editing, drag reorder, deletion, manual and section steps
- [x] debounced autosave with status and refresh persistence
- [x] manual image upload
- [x] complete click-indicator move/resize/remove controls
- [x] low-confidence visual flag stored and rendered correctly
- [x] complete editor keyboard shortcuts and 10-reorder regression test

## M4 - Image tools

- [x] non-destructive server flattening keeps the original
- [x] interactive canvas blur, crop, rectangle, arrow and text tools
- [x] selection/move/resize/remove controls for click markers
- [x] undo/redo for at least 20 operations
- [x] persistence and rendered-path regression tests

## M5 - Exports

- [x] Markdown ZIP and self-contained HTML routes
- [x] print CSS avoids splitting steps/screenshots
- [x] headless Playwright PDF route
- [x] rich-text and Markdown clipboard actions
- [x] automated tests for all export formats

## M6 - Sharing

- [x] public toggle, UUID route, iframe snippet, noindex metadata
- [x] revoked/non-public share resolves to 404 by query construction
- [x] automated public/revoke test

## M7 - Polish and hardening

- [x] responsive dark theme, loading/empty/error views, shared API schemas
- [x] consistent mutation status/toasts and route-level validation audit
- [x] full Playwright regression suite
- [x] Lighthouse performance/accessibility >= 90 and 50-step <1.5s evidence

## M8 - Refinement

- [ ] Historical v1 refinement loop; superseded by the ordered v2 milestones and M18+ refinement loop in `PROGRESS_V2.md` (no live verification prerequisite).

## Backlog

- Live Supabase checklist: moved to `PROGRESS_V2.md` → Owner later (non-blocking).
- System-Chrome checklist: moved to `PROGRESS_V2.md` → Owner later (non-blocking).
- Consider replacing remaining raw `<img>` tags with a custom loader or `next/image` if deployment economics allow it.
- Shadow DOM, iframe, SPA history and infinite-scroll capture adapters.
- Full Tailwind + shadcn/ui refactor if design-system compliance becomes more important than preserving the current small custom CSS surface.

## Deviations

- Supabase CLI migration creation was not possible because no Supabase CLI/project credentials are available; the migration file is checked in and documented for manual application.
- Live Supabase and unpacked-system-Chrome checks are not marked complete. Automated test-store, Playwright Chromium, and pure extension tests are the local workaround evidence.
- The UI currently uses a compact custom CSS design surface rather than a full Tailwind + shadcn/ui component refactor. The functional milestones are implemented and verified; the refactor is tracked as backlog.

## Verification evidence

- `pnpm verify` passed on 2026-07-10.
- Unit tests: shared 40 tests, extension 7 tests, web 8 Vitest tests.
- Playwright: 8 e2e tests passed, including 30-step viewer, editor autosave, share/revoke, export formats, 10 reorder mutations, image edit persistence/render path, 50-step viewer, and clipboard copy.
- 50-step viewer local reload: 881 ms in Playwright, below the 1.5s target.
- Lighthouse on warmed production viewer using Playwright Chromium with provided throttling: performance 100, accessibility 100.

## Run log

- 2026-07-10 - Initial monorepo implementation; `pnpm verify` passed 22 unit tests and both builds.
- 2026-07-10 - Corrected the milestone audit after identifying missing editor, export, E2E and performance acceptance evidence.
- 2026-07-10 - Completed capture queue/retry hardening, selector coverage, editor/image tooling, render-on-save, exports/PDF/clipboard, public sharing, API validation, route-handler tests, image flatten tests, Playwright regression coverage, Lighthouse evidence, README updates, and root `pnpm verify`.

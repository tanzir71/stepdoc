# AGENTS.md — rules for coding agents in this repo

Read this before touching code. The build plan is `CODEX_HANDOFF_V2.md` (v2, current) on top of `CODEX_HANDOFF.md` (v1, shipped). Progress lives in `PROGRESS_V2.md`.

## Repo map (target v2 layout)

```
apps/
  app/          Static SPA (Vite + React + TS). The whole product UI: library, editor, settings, published viewer.
  extension/    Browser extension (WXT). Chrome/Edge side panel; Firefox/Safari popup + full-tab editor.
  web/          v1 Next.js + Supabase app → becomes the "node-postgres" server target (serves apps/app build + Storage API v1).
servers/
  php/          PHP 8.1+ front controller + SQLite. Ships as stepdoc-php.zip for shared hosting.
  worker/       Cloudflare Worker (Hono) + D1 + R2.
packages/
  schema/       guide@1 JSON Schema + zod + migrations (source of truth: docs/v2/guide.schema.json).
  core/         step text rules, redaction detectors, canvas flattening, exporters, locator ranking.
  storage/      StorageAdapter + IndexedDbAdapter, HttpAdapter, StaticAdapter.
  publish/      static site builder (guide.html/json/md, replay.spec.ts, SKILL.md, llms.txt, sitemap).
  mcp/          MCP server (stdio CLI + HTTP handler shared by every server target).
  ui/           React components mirroring Figma components (Button, Badge, StepRow, …).
  shared/       v1 package; fold into schema/core during M9 and delete.
tests/contract/ One HTTP suite run against every server target.
site/           Marketing site + docs (GitHub Pages).
docs/v2/        guide.schema.json, storage-api.openapi.yaml, design-tokens.json, RESEARCH.md
```

## Commands

- `pnpm verify` — lint, typecheck, unit, e2e, builds. Must pass before every commit.
- `pnpm test:contract --target=php|worker|node` — Storage API contract suite.
- `pnpm test:a11y` — Playwright `toMatchAriaSnapshot` + axe on every route in the screen map.
- `pnpm --filter @stepdoc/extension build -b chrome|firefox`

## Git, pushing and CI (details in CODEX_HANDOFF_V2.md §0)

- Repo: **`tanzir71/stepdoc`**; remote `https://github.com/tanzir71/stepdoc.git`. The v2 setup renamed the repository; update any old reference you find.
- Work on **`main`** and commit/push directly there. **No pull requests**, per the owner's 2026-11-25 instruction, which supersedes the original `v2` branch rule. Never push to `master`, `gh-pages` or `ci/add-workflow`; never force-push or merge.
- Commit every completed unit (`feat(mN): …`); `git push origin main` at the end of every run; at each completed milestone tag `v2-mN` and `git push origin main --follow-tags`, then update the Milestones table in PROGRESS_V2.md.
- **No GitHub Actions**: no `.github/workflows/*`, no `gh workflow` / `gh run`, no releases, no Pages deployments, no repo-settings changes (except the rename).
- **No manual or owner-involved testing.** Only automated local checks count (Playwright Chromium with the extension loaded, virtual WebAuthn, `php -S`, `wrangler dev --local`, local Postgres or the test-store, mocked GitHub/AI/SMTP). Never deploy anywhere. Owner-only items go under "Owner later (non-blocking)" in PROGRESS_V2.md; never wait or ask.

## Non-negotiables

1. **Typed values are never recorded, stored, exported or logged.** Fill steps reference `{ kind: "variable" | "secret" }`. Literal values only for select options and key names.
2. **Redaction happens in the client before upload.** Servers never receive un-redacted pixels and never process images (no sharp, Imagick, headless Chrome in server code paths).
3. **One API contract.** If you change an endpoint, change `docs/v2/storage-api.openapi.yaml`, all three server targets and the contract tests in the same PR.
4. **Schema first.** Changes to guide data go through `packages/schema` with a migration and a version bump note.
5. **No secrets in client bundles.** Tokens are scoped, revocable, stored hashed server-side.

## Agent-operable UI (every screen)

Agents drive this app through the accessibility tree. Treat these as acceptance criteria, not polish.

- Native elements first: `<button>`, `<a href>`, `<input>`, `<select>`, `<dialog>`. Icon-only buttons need `aria-label`.
- Landmarks on every page: `header` (banner), `nav`, `main`, `aside` (complementary, labelled when repeated), `footer`.
- **Stable hooks:** `data-sd="<area>-<action>"`, kebab-case, never generated. Steps: `id="step-<n>"` + `data-sd-step="<n>"`. Examples used in Figma layer names: `capture-start`, `library-import`, `export-open`, `publish-confirm`, `ai-cleanup`, `guide-me`, `setup-continue`, `redaction-continue`, `pair-submit`, `capture-save`. Add new ones to the table in CODEX_HANDOFF_V2.md §10.
- Deterministic URLs for every state: `/g/:id/edit?step=4`, `/g/:id/export`, `/settings/devices`.
- Keyboard-complete: reorder with Alt+Up/Down, menus open on click/Enter (never hover-only), Esc closes overlays, visible focus ring.
- Canvas editor keeps a parallel DOM layer list (role=listbox) with numeric x/y/w/h fields, so agents can add or move a blur box without dragging.
- No agent traps: no virtualised list without search/"show all", toasts mirrored to an `aria-live` region and an activity log, no closed shadow DOM, real `role="dialog"` with labelled buttons.
- WebMCP: feature-detect `document.modelContext ?? navigator.modelContext`; register the same tools as packages/mcp. Never required for the UI to work.

## Design rules (from Figma "StepDoc - Scribe", page "StepDoc v2")

- Tokens only (`docs/v2/design-tokens.json` → CSS custom properties `--sd-*`). No raw hex in components.
- **Light is the default theme**; dark is `[data-theme="dark"]` (and "System").
- **No glow effects. No italics. No strokes on navigation bars.** Separation by surface tint; shadows only for floating layers.
- One accent (ember) for primary actions, the click marker and focus. `agent/*` colours only for agent-facing affordances.
- Geist + Geist Mono, self-hosted woff2.
- Match Figma components 1:1 by name and props (Button kind/size/icon, Badge tone, StepRow state, NavItem active, Segment selected, Input state, Toggle on).
- Ledgerly in the mocks is a fictional third-party app used as screenshot content. Do not build it.

## Working style

- Follow the loop protocol in CODEX_HANDOFF_V2.md §15: one unit of work per run, verify, record in PROGRESS_V2.md, commit, push `main` directly without a PR.
- Conventional commits. No `any`, no unexplained `@ts-ignore`.
- When something needs credentials, a live service or a decision, use the defaults in CODEX_HANDOFF_V2.md §16, log it under "Owner later", and take the largest unblocked task.

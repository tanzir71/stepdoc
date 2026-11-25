# StepDoc v2 progress

## Milestones

| Milestone | Status | Date | Summary | Commit |
|---|---|---|---|---|
| M9 | In progress | 2026-11-25 | Repository setup and guide@1 schema/migration complete; core next | — |
| M10 | Not started | — | SPA + browser-only mode | — |
| M11 | Not started | — | Extension v2 | — |
| M12 | Not started | — | PHP + SQLite target | — |
| M13 | Not started | — | Cloudflare target | — |
| M14 | Not started | — | Node target + v1 migration | — |
| M15 | Not started | — | Collaboration and parity | — |
| M16 | Not started | — | Publishing + agent surface | — |
| M17 | Not started | — | Landing + docs | — |

## M9 — Repo setup, schema and core

- [x] Repository renamed to `tanzir71/stepdoc` with admin access; `origin` updated; `v2` created from `master` and first push completed. Old references updated, root repository metadata and MIT licence added.
- [x] `@stepdoc/schema`: guide@1 types + zod mirroring `docs/v2/guide.schema.json`; Ajv validation test against fixtures; v1→guide@1 migration with tests on the v1 Playwright fixtures.
  - [x] guide@1 types, zod and Ajv fixture validation.
  - [x] v1→guide@1 migration and v1 Playwright fixture tests, with a schema version note.
- [ ] `@stepdoc/core`: describe-step (from shared), locator ranking, redaction detectors (unit tests incl. Luhn, mod-97, token entropy), flatten via OffscreenCanvas (worker-safe), exporters MD/HTML/guide.json/Playwright/SKILL.md/JSON-LD with snapshot tests.
  - [ ] Step text and locator ranking.
  - [ ] Redaction detectors including Luhn, mod-97 and token entropy.
  - [ ] Worker-safe client flattening via OffscreenCanvas.
  - [ ] MD, HTML, guide.json, Playwright, SKILL.md and JSON-LD exporters with snapshots.
  - [ ] Fold v1 shared code into schema/core, update consumers and delete `packages/shared`.

## M10 — SPA + browser-only mode

- [ ] `apps/app` (Vite + React + TS + `packages/ui` from tokens). Routes W02, W03, W05, W11, W12 working on IndexedDbAdapter (IndexedDB + OPFS).
- [ ] Visual parity with Figma for W02/W03/W05 at 1440×900, light + dark: compare automated Playwright screenshots against the linked frames and commit screenshots under `docs/v2/screens/`.
- [ ] Client-side PDF (print CSS), DOCX, `.stepdoc` import/export round-trip test.
- [ ] a11y gate: aria snapshots + axe for these routes.

## M11 — Extension v2

- [ ] WXT build for Chrome/Edge (side panel) and Firefox (popup + tab). E01–E06 implemented.
- [ ] Automated e2e only: load the built Chrome extension in Playwright Chromium against local fixture pages; Firefox build passes `web-ext lint`. No store uploads, signing or manual checklist.
- [ ] Capture contract (§7) with unit tests on fixture pages (buttons, links, labelled inputs, iframes, open shadow DOM, SPA navigation).
- [ ] Smart Blur v2 + click-to-blur; secrets never read (test asserts no `.value` access via proxy).
- [ ] Local mode opens the SPA from the extension origin; v1 upload path still works.

## M12 — PHP + SQLite target

- [ ] `servers/php` implementing Storage API v1, migrations, auth (passkey, codes, recovery), pairing, tokens, CORS, blobs outside webroot, `/health` checks, audit log.
- [ ] `stepdoc-php.zip` built by a local script (`pnpm build:php`, git-ignored unless the owner requests it committed) + `install.php` (W01 host check) + docs. Contract tests green against `php -S` (Apache container only if Docker is already available). Passkeys tested with the virtual authenticator; email codes with the SMTP capture stub.

## M13 — Cloudflare target

- [ ] `servers/worker` (Hono, D1, R2), `wrangler.toml`, Deploy-button markup in docs; contract tests green against `wrangler dev --local`. Never deploy.

## M14 — Node target + v1 migration

- [ ] `apps/web` serves the SPA and implements Storage API v1 on Supabase; migration script for existing v1 data, tested on fixtures; contract tests green against the test-store or a local Postgres. No live Supabase project. Remove superseded Next pages.

## M15 — Collaboration and parity

- [ ] W01, W06–W10 implemented; roles enforced server-side; collections; unlimited versions + restore; redaction review gate (W04) + enforced policy (423 path tested); BYO-key AI clean-up via `/ai/rewrite` (provider mocked in tests; never call a real AI API); branding; aggregate views; Guide Me (E03) with verification write-back.
- [ ] Comments on steps (P11), last in M15.

## M16 — Publishing + agent surface

- [ ] `@stepdoc/publish` static builder (P01–P05) with validation of every Checklist A item in `pnpm verify`.
- [ ] GitHub Pages publisher (single Git Data API commit, tested against a mocked GitHub API) + "Download site (.zip)". No workflow files.
- [ ] `@stepdoc/mcp`: stdio CLI + HTTP endpoint on all targets; WebMCP registration; `npx stepdoc replay <guide>` writing `verification` (tested against local fixtures).

## M17 — Landing + docs

- [ ] Rebuild `site/` from L01/L02; docs per target (browser, PHP, Cloudflare, Node, Pages); `site/llms.txt` updated; local Lighthouse ≥ 95 perf/a11y. Commit and push only; do not deploy.

## Owner later (non-blocking)

- Merge `v2` into `master` when ready.
- Install in the owner's browser; Chrome/Edge stores and Firefox signing/AMO submission.
- Live Supabase migrations/integration (carried from v1 `PROGRESS.md`) and deployments to PHP, Cloudflare or Node hosts.
- Real GitHub publishing and Pages configuration; real email delivery and hardware passkeys. Automated local stand-ins are the milestone criteria.
- Re-check competitor prices before launch; publish the marketing site.
- Alternative logo selection if desired; Mark A "Stepline" remains the default.

## Backlog

- M18+: audit one area per run against §10 and Figma, fix the worst gap and add a regression test.
- Safari build, OIDC/SAML add-on, BYO-key translation, analytics dashboard, BookStack/Wiki.js/Docmost export.
- Keep v1 operational until each replacement reaches parity; remove server image processing when client flattening replaces those paths.

## Deviations

- None in v2 setup. Historical v1 manual checks and its post-M7 live-verification prerequisite are superseded by §0; owner-only work is listed above.
- The first schema implementation enforces privacy rules that were previously only prose in the supplied JSON Schema: no secret examples, no literals on fill steps, matching tagged value payloads, and no unknown properties in click/edit/annotation objects. These corrections ship as package version `0.1.0` under the initial guide@1 identifier; no guide@1 data existed before this implementation. The v1 migration and version note live in `packages/schema`.

## Run log

- 2026-11-25 — M9 setup: read both handoffs and the v1 progress log; created `v2` from `master` at `05b432c`; confirmed admin permission and renamed the GitHub repository; updated `origin` and completed the first `v2` push. Recorded the supplied v2 contracts, instructions and milestone checklist, added MIT licensing/repository metadata, updated old source links and moved v1 external checks to Owner later. The first verification exposed a cold-start E2E race: PATCH returned 200, but initial dev compilation exceeded the save-indicator wait. The existing autosave regression now waits for the successful PATCH response before checking the indicator; persistence and keyboard assertions are retained. Next unit: guide@1 types/zod and Ajv fixtures in `@stepdoc/schema`.
- Verification: `pnpm install --frozen-lockfile` and `pnpm verify` passed (lint: zero errors, two existing image warnings; strict typecheck; 56 unit tests; 8 Playwright Chromium e2e tests against the local test-store; shared, extension and Next production builds). `pnpm website:verify`, repository metadata/JSON parse checks and `git diff --check` passed. No old repository URLs or workflow files found. M9 remains in progress; no milestone tag yet.
- 2026-11-25 — M9 schema: added `@stepdoc/schema` version `0.1.0`, guide@1 Zod schemas and inferred types, the source JSON Schema export, minimal/full fixtures and Ajv 2020-12 parity tests. Both validators enforce the privacy rules above, and agree on RFC formats, Unicode text limits and integer semantics. Added a deterministic v1 row migration that preserves IDs, order, instructions, timestamps, public IDs, click geometry and image edit layers; maps targets and manual redactions; declares fill variables/secrets without reading `.value`; strips URL credentials/query/fragment and discards signed image URLs. Image migrations require client-supplied dimensions and existing flattened blobs for edited screenshots. Extracted the existing onboarding fixture so browser tests and migration tests share the same v1 input. Next unit: core step text and locator ranking.
- Verification: final `pnpm verify` passed (169 unit tests, including 113 schema/migration tests; 8 Playwright Chromium e2e tests; strict typecheck; all workspace builds; zero lint errors and the same two existing image warnings). Migration checks cover 1/2/3/10/30/50-step v1 fixtures, manual images/layers, ordering, public identity, unsafe URLs, malformed rows and a throwing `.value` access guard. `git diff --check` passed. M9 remains open for core work; no milestone tag yet.

## Defaults in use

- Repo: **`tanzir71/stepdoc`** (renamed during v2 setup, §0). Work branch: **`v2`**; the owner merges into `master`.
- Logo: **A "Stepline"** / B "Marker" / C "Fold" (Foundations board).
- Licence: **MIT** — added in M9.
- Name: **StepDoc**.
- Comments (P11) in v2: **yes, last in M15**.
- Hosted SaaS: **none** in v2.
- GitHub Actions: **none**, ever, unless the owner adds them.
- Owner-later (never blocking): GitHub-side rename if `gh` lacks rights, merging `v2`, browser/store installs, live deployments, real publishing, re-checking competitor prices before launch.

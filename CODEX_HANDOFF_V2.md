# StepDoc v2 — Codex Build Handoff (delta on v1)

**Status of v1:** shipped (M0–M7 in `PROGRESS.md`): Chrome MV3 capture, Next.js + Supabase single-user app, editor with non-destructive image layers, MD/HTML/PDF exports, public links, GitHub Pages marketing site.
**Goal of v2:** maximum feature parity with Scribe-class tools, a premium UI, and five ways to run the same product — **browser-only (extension), PHP shared hosting, Cloudflare, Node + Postgres, and read-only GitHub Pages** — plus guides and app screens that browser agents can read and replay.

This file is the single source of truth for v2. `CODEX_HANDOFF.md` (v1) still applies where v2 does not override it; §0 below overrides v1's loop protocol, its `MANUAL_TEST.md` upkeep and every human-run check. Read `AGENTS.md` first, then this file, then `PROGRESS_V2.md` (create it on your first run, see §15).

Companion files:
- `docs/v2/guide.schema.json` — guide@1 data contract (source of truth for every adapter and exporter)
- `docs/v2/storage-api.openapi.yaml` — Storage API v1, implemented by every server target
- `docs/v2/design-tokens.json` — colours (light default / dark), space, radius, type, rules
- `docs/v2/RESEARCH.md` — competitor pricing, parity priorities, architecture and agent findings, sources

Figma: **StepDoc - Scribe**, page **StepDoc v2** — https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=0-1
Start at frame **00 Read me** (index, route map, decisions). Every frame is linked by node ID in §12.

---

## 0. Repo, branch, commits, pushes — mandatory, read before any code

**Rename the repo to `tanzir71/stepdoc`.** This is the first task of M9 (completed during v2 setup):
1. Check `gh auth status` and the current repository's admin permission. If its name is not already `stepdoc` and admin access is available, run `gh repo rename stepdoc --yes` against the current repository. If not, skip the GitHub-side rename, add "Rename the GitHub repo to stepdoc" to the *Owner later* list in PROGRESS_V2.md and carry on (GitHub redirects old URLs either way).
2. `git remote set-url origin https://github.com/tanzir71/stepdoc.git`.
3. Replace every old repository reference with `tanzir71/stepdoc` / `github.com/tanzir71/stepdoc` (including `site/index.html`, `site/llms.txt`, this file; also add `"repository"` to the root `package.json`). Package scope stays `@stepdoc/*`.

**Branch (owner update, 25 Nov 2026).** Work on `main`; commit and push directly, with **no pull requests**. This supersedes the original `v2`-only rule and owner-merge step. Initial M9 work was completed on `v2`; `main` is created from that history so it retains the completed work. Never push to `master`, `gh-pages` or `ci/add-workflow`; never force-push; never merge, rebase or delete other branches. No repository default-branch setting change is required.

**Commit** after every completed unit of work, conventional format with the milestone scope: `feat(m10): library grid on IndexedDbAdapter`. `pnpm verify` must be green before each commit.

**Push** so progress is visible in the repo:
- `git push origin main` at the end of every run; no PR.
- When a milestone's checklist is complete: commit `chore(mN): milestone complete`, create an annotated tag `v2-mN` (message = one-line summary), then `git push origin main --follow-tags`, and update the **Milestones** table at the top of PROGRESS_V2.md (milestone · status · date · summary · commit hash).
- If a push fails (auth, network), keep committing locally, note it in the Run log, retry on the next run. Never stop working because of it.

**No GitHub Actions.** Do not add `.github/workflows/*` (in this repo or in anything StepDoc generates for users), do not run `gh workflow …` / `gh run …`, do not create GitHub releases or Pages deployments, and do not change repository settings other than the rename above. Every check runs locally via `pnpm verify`.

**No manual or owner-involved testing.** Every acceptance criterion in this file must be provable by an automated local command. Anything that needs the owner is out of scope for v2 milestones: installing in their own browser, store or AMO submission/signing, the v1 `apps/extension/MANUAL_TEST.md` checklist, live Supabase / Cloudflare / shared-host deployments, real GitHub publishing, real email delivery, hardware passkeys, approvals or sign-offs. Use local stand-ins instead:
| Real thing | Local stand-in |
|---|---|
| Browser with the extension | Playwright bundled Chromium, `launchPersistentContext` with `--load-extension` (Firefox build: `web-ext lint` only) |
| Passkeys | CDP virtual WebAuthn authenticator in Playwright |
| Shared hosting | `php -S` + SQLite (plus an Apache container only if Docker is already available; skip otherwise) |
| Cloudflare | `wrangler dev --local` (Miniflare); never `wrangler deploy` |
| Supabase / Postgres | v1 test-store or a local Postgres if present; never a live project |
| GitHub API | msw/nock mocks |
| Email codes | in-process SMTP capture stub |
Record owner-only checks under **Owner later (non-blocking)** in PROGRESS_V2.md. They are never milestone criteria and you never wait on them. The v1 "External verification still needed" items in PROGRESS.md move to that list. Never ask the owner a question; use the defaults in §16.

---

## 1. Positioning (drives scope and copy)

"The step-by-step guide tool you own, and that your agents can follow."

- Ownership: runs on storage you already have (your browser, your PHP host, your Cloudflare account, your Postgres). No StepDoc cloud in the loop.
- Agent contract: every guide is also `guide.json` (guide@1), `guide.md`, `replay.spec.ts` and `SKILL.md`; every published site has `llms.txt`, JSON-LD and Markdown alternates; every server target exposes an MCP endpoint.
- Parity without Enterprise: roles, strong sign-in (passkeys), enforced redaction, unlimited history, MCP — all in the open core.
- Open source is proof, not the headline (Mimik and Showsteps already claim "free + open + local"; see RESEARCH.md).

## 2. Scope

### 2.1 Parity features (build these)
| # | Feature | Design | Notes |
|---|---|---|---|
| P1 | Members, roles (owner/editor/viewer), passkeys, email codes, recovery codes, optional OIDC/SAML add-on | W09 | No third-party IdP required |
| P2 | Collections ("Pages"/playbooks) with sections, ordering, access | W06 | Library grid + list views (W02) |
| P3 | AI clean-up and rewrite (BYO key: Anthropic, OpenAI, OpenAI-compatible, local endpoint) | W03, E04, W10 | Off by default; sends DOM context only, never screenshots |
| P4 | Smart Blur v2: pattern detectors (email, phone, card+Luhn, IBAN+mod97, tokens via prefixes+entropy, IP/MAC), custom regex rules, click-to-blur during capture, enforced policy, pre-publish review gate | W04, W10, E02 | Runs in the extension before storage; re-checked before publish |
| P5 | Unlimited version history + restore | W03 (Inspector → History) | Every PUT writes a version row |
| P6 | Exports: PDF, HTML, Markdown (zip), **DOCX**, **.stepdoc bundle (re-importable)**, guide.json, Playwright, SKILL.md | W05 | All client-side |
| P7 | Guide Me live replay in the extension | E03 | Matches role+name first, then locators |
| P8 | Branding kit (logo, accent, fonts, custom domain on published sites) | Settings → Branding (no frame; reuse settings shell) | |
| P9 | Privacy-friendly view analytics (aggregate views, step completion) | Collection rail | No third-party tracker; opt-in |
| P10 | Firefox build | E06 | Unsigned build + `web-ext lint`; signing/AMO is owner-later. Safari deferred |
| P11 | Comments on steps | Inspector (follow W03 patterns) | Lowest priority of the parity set |

### 2.2 Differentiators
D1 guide@1 replay contract + exports for free · D2 run anywhere (5 modes) · D3 publish to GitHub Pages with llms.txt/JSON-LD/.md alternates · D4 agent-operable app (a11y tree, `data-sd`, WebMCP) · D5 enforced redaction + audit log in the open core · D6 free unlimited viewers.

### 2.3 Non-goals for v2
Native desktop capture · process-mining analytics · sales-demo features (HTML capture, sandboxes) · AI avatars / voice cloning · autonomous agent execution inside StepDoc (export the contract; users' agents run it) · Safari build · hosted SaaS tier.

## 3. Architecture

```
            ┌───────────────── apps/app (static SPA, Vite + React) ─────────────────┐
            │ library · editor · settings · publish · /p/:publicId viewer            │
            │ @stepdoc/core: flatten (OffscreenCanvas) · redaction · exporters · PDF │
            └──────────────┬───────────────────────┬────────────────────┬───────────┘
                           │ StorageAdapter        │                    │
          IndexedDbAdapter │            HttpAdapter│ (Storage API v1)   │ StaticAdapter (read-only)
          (IndexedDB+OPFS) │                       ▼                    ▼
   browser-only mode ◄─────┘   servers/php · servers/worker · apps/web   GitHub Pages / any static host
   (extension pages)            (SQLite)    (D1 + R2)       (Postgres)    guides/index.json + per-guide files
```

Principles:
1. **Static client, thin backend.** The server persists JSON + blobs, enforces auth/roles/policy, and nothing else. All image work (redaction compositing, crop, annotation flattening, thumbnails), PDF (print CSS; optional pdf-lib), DOCX (`docx` npm), ZIP bundles run in the browser or extension.
2. **One contract.** `docs/v2/storage-api.openapi.yaml`; contract tests in `tests/contract` run against php, worker and node.
3. **v1 migration, not rewrite.** `apps/web` (Next.js + Supabase) becomes the node-postgres target: it serves the `apps/app` build and implements Storage API v1 against Supabase. Move editor/viewer UI into `apps/app`; delete Next pages once parity is reached. v1 rows migrate to guide@1 via `packages/schema/migrations/v1-to-guide1.ts` (`steps.element_meta` → `target`, `text` → `title`, `edits.blur[]` → `redactions[]` with `source: manual`, `click` unchanged).
4. **Extension modes.** *Local*: the extension hosts the full app at `chrome-extension://<id>/app.html` with IndexedDbAdapter. *Paired*: HttpAdapter to a server using a scoped token from pairing (§6).
5. **Progressive agent surface.** MCP server package shared by every server target (HTTP at `/api/v1/mcp`) plus `npx stepdoc mcp` (stdio, reads a local folder or a server). WebMCP registration in the SPA when available.

### 3.1 Target matrix
| Mode | Frontend | API | Data | Blobs | Auth | Ships as |
|---|---|---|---|---|---|---|
| Browser-only | extension pages | none | IndexedDB | OPFS | device | extension |
| Shared hosting | `public_html/` static | `api/index.php` (PHP 8.1+, PDO) | SQLite file **outside webroot** (MySQL optional) | `storage/` outside webroot, served via PHP after access check | passkeys (lbuchs/WebAuthn or equivalent, vendored), email codes via SMTP (PHPMailer, vendored) or `mail()`, recovery codes | `stepdoc-php.zip` + `install.php` host check (W01) |
| Cloudflare | Workers static assets | Worker (Hono) | D1 | R2 | same | `wrangler deploy` + Deploy button |
| Node + Postgres | served by `apps/web` | Next route handlers | Supabase/Postgres | Supabase Storage | same (no Supabase Auth dependency) | Docker image + v1 path |
| GitHub Pages | static viewer | none | `guides/index.json` + per-guide folders | images in repo | public | publisher (§8): one API commit to a branch the user picks; **no GitHub Actions** |

Shared-hosting rules: no daemons, no cron required (backups run lazily on first request after midnight), `php.ini` upload limit reported by `/health`, `.htaccess` denies `storage/` and `data/` if they must live under webroot, CSP and HSTS headers set by PHP.

## 4. Data model

Source of truth: `docs/v2/guide.schema.json` (guide@1). Key ideas:
- `target` holds role + accessible name + ordered `locators[]` (role, testId, label, placeholder, text, css, xpath) with `unique` flags, plus `frame[]` and `shadowPath[]`.
- `value.kind` is `none | literal | variable | secret`. Typed text is never stored; `variables[]` on the guide declare names (`seats`, `invoice_email` as secret).
- `expect` per step (urlMatches / visible / hidden / text).
- `redactions[]` with `kind`, `source` (auto/manual/policy), `rect`, `status` (applied/kept/open). Open items block public publishing when the policy is enforced.
- `verification` (passed/failed/not-replayable/never-run, runner, failedStep).

Relational layout for SQLite / D1 / Postgres (same columns, JSON as TEXT in SQLite/D1):
```
workspaces(id, name, settings_json, created_at)
members(id, workspace_id, email, name, role, created_at, last_seen_at)
passkeys(id, member_id, credential_id, public_key, sign_count, transports, created_at)
login_codes(email, code_hash, expires_at, attempts)            -- single use
recovery_codes(member_id, code_hash, used_at)
sessions(id_hash, member_id, expires_at, user_agent)
tokens(id, workspace_id, name, kind, token_hash, scopes, extension_id, last_seen_at, revoked_at)
pairing_codes(code_hash, workspace_id, created_by, expires_at, used_at)
collections(id, workspace_id, name, description, sections_json, is_public, position)
guides(id, workspace_id, slug, title, status, collection_id, public_id, is_public, version, doc_json, updated_at, created_at, deleted_at)
guide_versions(guide_id, version, doc_json, member_id, summary, created_at)   -- unlimited
blobs(key, guide_id, step_id, kind, mime, bytes, sha256, created_at)
comments(id, guide_id, step_id, member_id, body, resolved_at, created_at)
audit_log(id, workspace_id, member_id, action, subject, meta_json, created_at)
views(guide_id, day, views, completions)                         -- aggregate only
```

## 5. Storage API v1
See `docs/v2/storage-api.openapi.yaml`. Rules: JSON errors `{error:{code,message}}`; `PUT /guides/{id}` requires `If-Match: <version>` (409 on conflict, the editor shows a merge prompt); `POST /guides/{id}/publish` returns 423 `redaction_open` while items are open; `/public/{publicId}` content-negotiates `text/markdown` and `application/json`; `/health` drives the W01 host check and W07 capability table.

## 6. Auth, devices and tokens (W08, W09)
- Sign-in order: passkey → email code (6 digits, 10 min, single use, rate-limited) → recovery code. First run (W01 → step 2) registers the owner passkey and shows 10 recovery codes once.
- Sessions: httpOnly, Secure, SameSite=Lax cookie `sd_session`, rotated on privilege change.
- Pairing: owner/editor creates a code in W08 (format `XXX-XXX`, 5 min, one use) → extension `POST /pairing/claim {code, deviceName, extensionId}` → token with `capture:write guides:read`. Server CORS allows only `chrome-extension://<registered id>` / `moz-extension://<registered uuid>`. Devices list with revoke.
- API tokens for MCP/CI with explicit scopes; stored as SHA-256; shown once.
- Optional OIDC/SAML is an add-on interface (`AuthProvider`), off by default, never required.

## 7. Extension v2 (E01–E06)
Build with **WXT** (one codebase → Chrome/Edge MV3 side panel, Firefox MV3 popup + full-tab editor). Keep v1 pure modules (queue, selector, describe-step) and move them into `@stepdoc/core`.
- **Side panel** (Chrome/Edge): idle E01 (destination segmented control: This browser / paired server; big Start; toggles Smart blur, Agent context, Voice narration [beta]; recent captures), recording E02 (live step list, smart-blur notice, Pause, Stop & review; in-page recording pill rendered in an **open** shadow root with `aria-live`), review E04 (title suggestion, AI clean-up suggestions, checkbox list, merge/delete, Save to destination, Keep local), pairing E05.
- **Popup fallback** E06 for Firefox/Safari: start/stop, toggles, recent, open library; the editor opens in a tab.
- **Capture contract:** per event compute role (implicit + explicit), accessible name (`dom-accessibility-api`), locators ranked by uniqueness (check `document.querySelectorAll` count at capture time), frame chain, open shadow path, rect, URL with query/fragment stripped (allow-list per workspace), and an `expect` guess (next navigation → `urlMatches`; newly visible dialog/heading → `visible`). Inputs produce `value.kind = variable|secret` (password/email/payment/autocomplete=cc-* → secret); never read `.value`.
- **Smart Blur v2:** v1 field-type pixelation + text-pattern detectors over visible text nodes (rects via Range.getClientRects) + click-to-blur mode (Alt+B, click an element) — all composited before the screenshot is stored.
- **Guide Me** E03: dim page with cut-out around the target, tooltip with Back / Skip / I did it; advance on matching interaction; fallback to locators; report `verification` with runner `guide-me`.
- Shortcut: Alt+Shift+S start/stop. Throttle queue unchanged (≈2 captureVisibleTab/s).

## 8. Publishing (W05, P01–P05)
- **Public link** `/p/:publicId` (noindex by default, revocable) and **embed** iframe snippet (v1 behaviour, now served by the SPA viewer).
- **Static builder** `@stepdoc/publish` emits per guide: `/<collection>/<slug>/index.html` (P01 human view), `?view=text|json|md|playwright` client-side tabs (P02, P03), `guide.json`, `guide.md`, `replay.spec.ts`, `SKILL.md`, `img/*.webp`; per site: `index.html` (P04), `llms.txt` (<10k tokens), `llms-full.txt` only for small libraries, `sitemap.xml`, `robots.txt` (agents allowed), `guides/index.json`.
- **GitHub Pages publisher:** fine-grained PAT scoped to one repo (stored server-side, encrypted with a workspace key). `@stepdoc/publish` renders the whole static site in the app, then commits it to the chosen branch/folder in **one Git Data API commit** per publish. GitHub serves that branch with its normal Pages setting. **No GitHub Actions anywhere**: no workflow files in this repo and none generated into users' repos. Also offer "Download site (.zip)" for any static host. Tests use a mocked GitHub API only.
- **Replay:** `npx stepdoc replay <guide|collection>` runs guides with local Playwright and writes `verification` back through a `replay:write` token (W06 "Replay check" card, W08 "CLI · replay runner" row). StepDoc ships no CI config; users schedule it however they like.
- **Redaction gate** (W04) runs before any public target; enforced policy blocks with 423.
- Exporters are pure functions in `@stepdoc/core/export/*` with snapshot tests.

## 9. Editor and app screens
Port v1 editor behaviour into `apps/app` and restyle to Figma. Notable v2 additions:
- Topbar: breadcrumb, status badge, `Saved · vN` (history), segmented Edit / Preview / Agent view, Guide Me, Share, Export & publish.
- Step list (320px): section eyebrows, StepRow states Default / Active / Flagged (low confidence or open redaction), Clean up (AI), add step, capture more.
- Canvas: floating annotation toolbar (select, blur, crop, arrow, rectangle, text, pin, undo, redo, zoom), screenshot with click marker, step title/description editor, **Layers list** with numeric editing (agent/a11y fallback).
- Inspector (340px) tabs Step / **Target** / Redact / History. Target tab: action select, ordered locator list with Unique/Fragile badges, page URL + strip-query toggle, expected result, "Test on live page" (opens tab and highlights via extension) and "Copy Playwright", generated line preview.
- Agent view (segmented): renders the P02 text view inside the editor.

## 10. Agent-readability spec (acceptance criteria)

**A. Every published guide**
- [ ] One `h1`, steps as `ol > li#step-n[data-sd-step=n]`, each with `h2`, instruction, `figure` + `img alt` generated from the target ("The Change plan button on the Current plan card")
- [ ] `<link rel="alternate" type="application/json" href="guide.json">` and `type="text/markdown" href="guide.md"`; PHP/Worker also honour `Accept: text/markdown`
- [ ] JSON-LD `HowTo` + `HowToStep` (name, text, image, url `#step-n`), `dateModified`
- [ ] guide.json validates against guide@1; secrets never present; query secrets stripped
- [ ] replay.spec.ts uses `getByRole(role,{name})` first, then `getByTestId`, then CSS; secrets from env
- [ ] SKILL.md: purpose, preconditions, variables, numbered steps with targets and expectations
- [ ] Text view (`?view=text`): one page, no images, no motion, nothing lazy or hover-only
- [ ] Site: llms.txt (<10k tokens), sitemap.xml, robots.txt not blocking agents
- [ ] Metadata: app name, captured, verified, schema id

**B. Every app screen** (see AGENTS.md for conventions)
- [ ] Landmarks, native controls, labelled icon buttons, visible focus
- [ ] `data-sd` hooks on primary actions (table below), deterministic URLs per state
- [ ] Keyboard-complete (reorder Alt+Up/Down, Esc closes, no hover-only menus)
- [ ] Canvas has DOM layer list with numeric fields
- [ ] Toasts mirrored to `aria-live` + activity log; real `role=dialog`
- [ ] WebMCP tools registered when `document.modelContext ?? navigator.modelContext` exists: `list_guides`, `get_guide`, `create_guide`, `add_step`, `update_step`, `export_guide`, `publish_guide` (schemas from @stepdoc/schema)
- [ ] Local gate (`pnpm test:a11y`, part of `pnpm verify`): `toMatchAriaSnapshot` for every route in §12 + axe (no serious/critical)

`data-sd` registry (extend as you add actions):
| Hook | Where |
|---|---|
| `landing-install`, `landing-deploy`, `landing-docs`, `landing-demo` | L01/L02 source installation, self-host documentation and real generated guide |
| `landing-menu-open`, `landing-menu-close`, `landing-faq-1`–`landing-faq-4` | L02 native dialog (`?menu=open`) and native FAQ details/summary |
| `landing-guide-json`, `landing-replay`, `landing-skill`, `landing-host-<browser\|php\|cloudflare\|node\|pages>` | Real guide companion files and target documentation anchors |
| `capture-start` | W02 New capture, E01 record button |
| `capture-activity` | Labelled complementary landmark containing the capture activity log |
| `capture-smart-blur`, `capture-agent-context`, `capture-settings`, `capture-recent`, `capture-library` | Local capture preferences, settings, recent guides and native library |
| `capture-pause`, `capture-review`, `capture-title`, `capture-select-step` | Pause/resume, Stop & review, review title and step selection; Alt+Up/Down reorders selected-focus rows |
| `capture-pill`, `capture-pill-pause`, `capture-pill-resume`, `capture-pill-stop`, `capture-pill-open-review`, `capture-time` | E02 open-shadow recorder controls, retained review retry and active-time clock; no source-page URL changes |
| `capture-open-review`, `capture-pair` | E06 retained review → `/popup.html?surface=tab&view=review`; E01 Pair server opens `?view=pair`, E06 opens `/popup.html?surface=tab&view=pair` |
| `capture-source`, `capture-source-refresh`, `capture-source-open` | Full-tab controls: native web-page selector, Refresh pages and Show page. `source`, `origin` and `browser-session` query parameters retain an explicit selection through pairing/reload; `source=none` retains an empty choice. Start focuses that exact page and closes the controls tab after success. |
| `capture-merge`, `capture-delete`, `capture-discard`, `capture-confirm`, `capture-confirm-cancel`, `capture-keep-local`, `capture-retry` | Adjacent manual merge, delete, discard confirmation, local-only save and retained v1 upload retry |
| `capture-library` | Extension side panel / popup: open the local SPA in a full tab |
| `capture-blur`, `capture-blur-controls`, `capture-blur-done` | Side panel/popup Alt+B picker, open-shadow privacy toolbar and Done; focus + Enter/Space adds an element, Esc exits |
| `library-import` | W02 Import |
| `library-create`, `library-create-empty`, `guide-create-title`, `guide-create-instruction`, `guide-create-submit`, `guide-create-cancel` | Browser manual-guide creation (`/?create=1`) |
| `library-search`, `library-search-focus`, `library-status-<filter>`, `library-sort`, `library-view-grid`, `library-view-list`, `library-show-all`, `library-clear`, `library-retry`, `library-results` | Local library search, status, layout, pagination and states |
| `library-guide-open`, `library-collection-open`, `library-import-file`, `library-import-copy`, `library-import-cancel`, `library-import-stop` | Library navigation, JSON/bundle import conflict handling and cancellation |
| `nav-home`, `nav-collapse`, `nav-library`, `nav-collections`, `nav-drafts`, `nav-published`, `nav-archived`, `nav-collection` | Browser workspace navigation |
| `settings-open`, `settings-storage-details`, `theme-light`, `theme-dark`, `theme-system`, `storage-info`, `storage-info-close` | Browser appearance and storage settings |
| `nav-settings`, `settings-nav-general`, `settings-nav-devices`, `settings-devices` | W08 settings navigation and existing general preferences; unavailable workspace sections are disabled native buttons |
| `devices-refresh`, `device-row`, `device-revoke`, `device-revoke-confirm`, `device-dialog-close`, `devices-feedback`, `device-dialog-feedback` | W08 real list/revoke, URL-backed dialogs, cancellation and accessible retry feedback |
| `pairing-create`, `pairing-code`, `pairing-copy`, `pairing-new` | W08 explicit one-use five-minute pairing codes; no code in URLs or persistence |
| `token-create`, `token-name`, `token-scope-<capture-write\|guides-read\|guides-write\|publish-write\|replay-write\|admin>`, `token-submit`, `token-value`, `token-copy`, `token-done` | W08 scoped token creation and shown-once in-memory result |
| `guide-library`, `guide-download-json`, `not-found-home`, `activity-open`, `activity-close`, `activity-dismiss`, `activity-live` | Private saved-guide preview, navigation and accessible feedback |
| `guide-edit`, `editor-library`, `editor-collection`, `editor-guide-details`, `editor-guide-details-close`, `editor-guide-title`, `editor-guide-description`, `editor-read-guide`, `editor-copy-link`, `editor-save-status` | Local editor navigation, metadata and save/history indicator |
| `editor-mode-edit`, `editor-mode-preview`, `editor-mode-agent`, `inspector-step`, `inspector-target`, `inspector-redact`, `inspector-history` | Editor mode and inspector tabs (URL state) |
| `editor-step-select`, `editor-search-open`, `editor-search`, `editor-add-step`, `editor-add-step-footer`, `editor-add-image`, `editor-image-file`, `editor-undo`, `editor-redo`, `editor-retry-load`, `editor-retry-save` | Step selection/search, local image input, history commands and recovery |
| `step-add-type`, `step-add-title`, `step-add-save`, `step-add-cancel`, `step-title`, `step-description`, `inspector-step-title`, `inspector-step-description`, `step-type`, `step-image-alt`, `step-notes`, `step-move-up`, `step-move-down`, `step-delete`, `step-delete-confirm`, `step-delete-cancel`, `step-image-upload`, `step-image-upload-empty` | Native step fields, add/delete dialogs and keyboard reordering |
| `canvas-tool-<select\|blur\|crop\|arrow\|rectangle\|text\|pin>`, `canvas-image`, `canvas-zoom`, `canvas-layer-select`, `canvas-add-selected-tool`, `canvas-replace-image`, `canvas-layer-<x\|y\|width\|height\|radius\|tox\|toy\|text>`, `canvas-layer-delete` | Worker image editor, parallel DOM layer list and numeric geometry; `tox`/`toy` also place optional rectangle captions |
| `target-action`, `target-variable`, `target-variable-add`, `target-option`, `target-key`, `target-url`, `target-strip-query`, `target-role`, `target-name`, `target-details-open`, `target-locator-add`, `target-locator-edit`, `target-open-live`, `target-copy-playwright`, `target-expect-open`, `target-expect-<kind\|role\|name\|text\|url>` | Target inspector, runtime references, locator ordering, sanitized URLs and expectations |
| `locator-strategy`, `locator-value`, `locator-name`, `locator-exact`, `locator-save`, `locator-delete`, `locator-cancel`, `variable-name`, `variable-kind`, `variable-save`, `variable-cancel` | Locator and variable dialogs; no fill/upload value input |
| `redaction-add`, `redaction-select`, `redaction-apply`, `history-download`, `cleanup-select`, `cleanup-apply`, `cleanup-cancel` | Local redaction, version download and rule-based title review |
| `editor-conflict-merge`, `editor-conflict-copy`, `editor-conflict-reload`, `editor-conflict-close`, `editor-conflict-download`, `editor-leave-save`, `editor-leave-discard`, `editor-leave-stay` | Optimistic-write and unsaved-navigation recovery dialogs |
| `export-open` / `publish-confirm` | W03 topbar / W05 footer |
| `export-close`, `export-format-<pdf\|html\|markdown\|docx\|bundle\|json\|playwright\|skill>`, `export-download`, `export-print`, `export-cancel-job`, `export-feedback` | W05 local format selection, native downloads/printing, cancellation and accessible feedback |
| `export-link-private`, `export-copy-link`, `export-copy-menu`, `export-copy-markdown`, `export-copy-rich`, `export-copy-html`, `export-host-documents`, `export-host-replay`, `export-host-skill`, `export-host-html` | Browser-mode local link/clipboard and actual hosting-file selections; no publishing claim |
| `route-library`, `route-reload` | Editor chunk loading/error recovery |
| `ai-cleanup` | W03 step list header |
| `guide-me` | Extension-origin W03 topbar; starts the native E03 walkthrough after saving edits |
| `guide-me-overlay`, `guide-me-back`, `guide-me-skip`, `guide-me-confirm`, `guide-me-close`, `guide-me-retry`, `guide-me-editor` | E03 live page dialog and private panel; step navigation, manual confirmation, safe report retry and editor link |
| `setup-continue` | W01 |
| `storage-check`, `storage-export`, `storage-export-confirm`, `storage-export-cancel`, `storage-feedback`, `storage-migrate-browser`, `storage-migrate-cloudflare`, `storage-migrate-node`, `settings-nav-storage` | W07 health refresh, portable workspace backup/cancellation/status, archive-based migration, and settings navigation; unfinished server destinations remain disabled |
| `docs-download-chrome`, `docs-download-edge`, `docs-download-firefox` | Compiled extension ZIP downloads; local PDF/HTML/other exports need no backend |
| `setup-storage-browser`, `setup-storage-php`, `setup-storage-cloudflare`, `setup-storage-node`, `setup-host-retry`, `setup-static-exports` | W01 storage selection, live host checks and informational static exports; unfinished server targets disabled |
| `setup-key`, `setup-unlock`, `setup-key-cancel`, `setup-workspace`, `setup-owner-name`, `setup-owner-email` | W01 installation authorization and first-owner details |
| `setup-recovery-codes`, `setup-recovery-saved`, `setup-back`, `setup-cancel`, `setup-feedback` | W01 shown-once recovery acknowledgement, navigation and safe live status |
| `setup-extension-install`, `setup-api-address`, `setup-pair-create`, `setup-pair-code`, `setup-signin` | W01 extension instructions and real server pairing |
| `auth-method-passkey`, `auth-method-email`, `auth-method-recovery`, `auth-email`, `auth-code`, `auth-submit`, `auth-cancel`, `auth-retry` | Hosted app sign-in, cancellation and unavailable-session recovery; the requested library/editor URL is retained. |
| `auth-enroll`, `auth-recovery-codes`, `auth-recovery-saved`, `auth-continue`, `auth-logout` | Native passkey enrollment, shown-once recovery acknowledgment, workspace entry and server-session sign-out. |
| `redaction-continue` | W04 |
| `pair-submit` / `capture-save` | E05 / E04 |
| `capture-destination`, `capture-destination-browser`, `capture-destination-server`, `capture-destination-reset` | E01/E06 paired destination segments, E04 native Save to select and invalid-preference recovery |
| `capture-voice-narration`, `capture-voice-language`, `capture-voice-cancel`, `capture-voice-toggle`, `capture-step-notes` | E01 opt-in local speech, language/setup cancellation, active microphone control and final redacted notes in E02/E04 |
| `capture-cleanup-open`, `capture-cleanup-select`, `capture-cleanup-apply`, `capture-cleanup-cancel`, `capture-cleanup-status` | E04 offline proposals, reviewed application and dialog-local retry feedback; `?view=review&cleanup=review` reopens the native dialog against the current retained capture |
| `pair-server`, `pair-code-1` … `pair-code-6`, `pair-form` | E05 server address, six labelled code fields with paste/keyboard navigation and claim form |
| `pair-cancel`, `pair-status`, `pair-test`, `pair-another` | Cancel request, live safe status, check stored connection and repair pairing |
| `pair-local`, `pair-back`, `pair-devices`, `pair-retry` | Local capture navigation, server Devices & tokens link and private-store retry |
| `pair-forget`, `pair-forget-cancel`, `pair-forget-confirm` | Native local-credential removal dialog; server revocation remains on the server |
| `step-<n>-text`, `step-<n>-target`, `export-<format>`, `publish-<target>` | patterns |

## 11. Design system
- Tokens: `docs/v2/design-tokens.json` → `packages/ui/tokens.css` (`--sd-*`). **Light is `:root`**, dark is `[data-theme=dark]`; Settings → General → Theme (Light / Dark / System). W12 is the dark reference.
- **No glows, no italics, no strokes on nav bars.** Shadows only for floating layers (`float`, `dialog` in tokens). One ember accent; text on accent uses `text/on-accent` (dark).
- Type: Geist / Geist Mono self-hosted; styles in tokens (`display-xl` … `mono-eyebrow`).
- Components (Figma → `packages/ui`): Button (kind primary/secondary/ghost/danger × size m/s, icon), IconButton (ghost/secondary, aria-label required), Badge (neutral/accent/success/warning/danger/agent, dot), Kbd, Input (default/focus), Toggle (role=switch), Checkbox, Segment (+ sunken track = tablist), NavItem (active, count), StepRow (default/active/flagged), ClickMarker, StepPin, Avatar, Logo (Mark A + Lockup + App tile). Icons: lucide-compatible names from the Icons board.
- Logo: **Mark A "Stepline"** is the working default; B and C are alternatives pending the owner's pick (§16).
- Foundations board: https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=21-5

## 12. Screen map (route → Figma frame)
Base: `https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=`

| Code | Screen | Route / surface | Node |
|---|---|---|---|
| 00 | Read me (index, decisions) | — | [34-7994](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=34-7994) |
| F | Logo options · Components · Icons · Color · Type · Mock capture | — | [10-359](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=10-359) · [12-428](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=12-428) · [10-5](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=10-5) · [13-665](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=13-665) · [13-854](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=13-854) · [13-407](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=13-407) |
| W01 | Onboarding · choose storage + host check | `/setup` | [22-1523](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=22-1523) |
| W02 | Library (grid; list toggle) | `/` | [16-944](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=16-944) |
| W03 | Guide editor (Target tab) | `/g/:id/edit?step=n` | [16-2340](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=16-2340) |
| W04 | Redaction review gate | `/g/:id/review` | [22-1656](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=22-1656) |
| W05 | Export & publish dialog | `/g/:id/export` | [22-2562](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=22-2562) |
| W06 | Collection / playbook | `/c/:id` | [24-2757](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=24-2757) |
| W07 | Settings · Storage & deploy | `/settings/storage` | [24-3930](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=24-3930) |
| W08 | Settings · Devices & tokens (pairing) | `/settings/devices` | [24-4357](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=24-4357) |
| W09 | Settings · Members & sign-in | `/settings/members` | [25-4030](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=25-4030) |
| W10 | Settings · Redaction policy + AI provider | `/settings/redaction` (+ `/settings/ai`) | [25-4431](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=25-4431) |
| W11 | States: empty, offline, server error, loading | all data views | [25-4819](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=25-4819) |
| W12 | Library · dark mode reference | theme | [25-4924](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=25-4924) |
| E01 | Side panel · idle | extension | [26-5543](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=26-5543) |
| E02 | Side panel · recording (+ in-page pill) | extension | [26-6061](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=26-6061) |
| E03 | Guide Me overlay | extension | [26-6712](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=26-6712) |
| E04 | Review before save | extension | [27-6690](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=27-6690) |
| E05 | Pair with server | extension | [27-6826](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=27-6826) |
| E06 | Popup fallback (Firefox/Safari) | extension | [27-6897](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=27-6897) |
| P01 | Published guide · human view | `/p/:publicId`, Pages guide | [27-6955](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=27-6955) |
| P02 | Text view + accessibility snapshot | `?view=text` | [29-7096](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=29-7096) |
| P03 | JSON + Playwright views | `?view=json` / `playwright` | [29-7187](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=29-7187) |
| P04 | GitHub Pages library index + llms.txt | Pages root | [29-7295](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=29-7295) |
| P05 | Published guide · mobile | responsive | [29-7438](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=29-7438) |
| L01 | Landing · desktop | `site/index.html` | [32-7455](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=32-7455) |
| L02 | Landing · mobile | `site/index.html` | [33-7805](https://www.figma.com/design/lTCFRrrKJb415s0nSxKE3B/StepDoc---Scribe?node-id=33-7805) |

Not drawn (reuse the shells): Settings → General / Publishing / AI providers (same layout as W10 right column) / Branding / Agent access / Audit log; Collections index; Trash; Captures inbox (Library filtered to unsaved extension captures). Build them with the same components and spacing.

Layer names in Figma carry intent: `(nav landmark)`, `(listbox)`, `(role=dialog)`, `[data-sd=…]`, `[aria-label=…]`. Treat them as implementation notes.

## 13. Landing page (site/, GitHub Pages)
Rebuild `site/` from L01/L02 (static HTML/CSS, no framework; keep `site/llms.txt` and `site/demo/` generated by the real exporter). Sections in order: nav (no stroke) → hero (centered; "Record it once. People read it. Agents run it.") → **signature split** (same guide: human view vs agent view) → install-anywhere strip (5 modes with one-line commands) → workflow (capture, edit, redact, publish with real UI crops) → built for agents (checklist + WebMCP snippet) → privacy (3 cards) → compare table vs Scribe/Tango (**date-stamped "checked 25 Nov 2026"**, values from RESEARCH.md; re-verify before publishing) → FAQ → CTA → footer ("Built by tanziro.com").
Copy rules: only claim agent compatibility the automated suite tests; no enterprise-quote numbers; no italics; light theme. Use the RESEARCH.md prices with the "checked 25 Nov 2026" stamp; re-checking them before launch is owner-later. Do not deploy the site; the owner publishes it.

## 14. Milestones (v2)
Work strictly in order; a milestone is done when every criterion passes and its automated tests are green. **Every milestone ends with: commit → tag `v2-mN` → `git push origin main --follow-tags` → Milestones table updated (§0).** No PR is created. No criterion may require the owner, a live service or a GitHub Action.

**M9 — Repo setup, schema and core**
- Initial repo rename and `v2` branch setup; references updated; first push of `v2` (completed). Subsequent work goes directly to `main` per the owner update in §0.
- `@stepdoc/schema`: guide@1 types + zod mirroring `docs/v2/guide.schema.json`; Ajv validation test against fixtures; v1→guide@1 migration with tests on the v1 Playwright fixtures.
- `@stepdoc/core`: describe-step (from shared), locator ranking, redaction detectors (unit tests incl. Luhn, mod-97, token entropy), flatten via OffscreenCanvas (worker-safe), exporters MD/HTML/guide.json/Playwright/SKILL.md/JSON-LD with snapshot tests.

**M10 — SPA + browser-only mode**
- `apps/app` (Vite + React + TS + `packages/ui` from tokens). Routes W02, W03, W05, W11, W12 working on IndexedDbAdapter (IndexedDB + OPFS).
- Visual parity with Figma for W02/W03/W05 at 1440×900, light + dark: Codex compares its own Playwright screenshots against the linked frames (no owner sign-off) and commits the screenshots under `docs/v2/screens/`.
- Client-side PDF (print CSS), DOCX, `.stepdoc` import/export round-trip test.
- a11y gate: aria snapshots + axe for these routes.

**M11 — Extension v2**
- WXT build for Chrome/Edge (side panel) and Firefox (popup + tab). E01–E06 implemented.
- Automated e2e only: load the built Chrome extension in Playwright Chromium against local fixture pages; Firefox build passes `web-ext lint`. No store uploads, no signing, no manual checklist.
- Capture contract (§7) with unit tests on fixture pages (buttons, links, labelled inputs, iframes, open shadow DOM, SPA navigation).
- Smart Blur v2 + click-to-blur; secrets never read (test asserts no `.value` access via proxy).
- Local mode opens the SPA from the extension origin; v1 upload path still works.

**M12 — PHP + SQLite target**
- `servers/php` implementing Storage API v1, migrations, auth (passkey, codes, recovery), pairing, tokens, CORS, blobs outside webroot, `/health` checks, audit log.
- `stepdoc-php.zip` built by a local script (`pnpm build:php`, committed under `dist/` only if the owner asks; otherwise git-ignored) + `install.php` (W01 host check) + docs. Contract tests green against `php -S` (Apache container only if Docker is already available). Passkeys tested with the virtual authenticator; email codes with the SMTP capture stub.

**M13 — Cloudflare target**
- `servers/worker` (Hono, D1, R2), `wrangler.toml`, Deploy-button markup in docs; contract tests green against `wrangler dev --local`. Never deploy.

**M14 — Node target + v1 migration**
- `apps/web` serves the SPA and implements Storage API v1 on Supabase; migration script for existing v1 data, tested on fixtures; contract tests green against the test-store or a local Postgres. No live Supabase project. Remove superseded Next pages.

**M15 — Collaboration and parity**
- W01, W06–W10 implemented; roles enforced server-side; collections; unlimited versions + restore; comments; redaction review gate (W04) + enforced policy (423 path tested); BYO-key AI clean-up via `/ai/rewrite` (provider mocked in tests; never call a real AI API); branding; aggregate views; Guide Me (E03) with verification write-back.

**M16 — Publishing + agent surface**
- `@stepdoc/publish` static builder (P01–P05) with validation of every Checklist A item in `pnpm verify`.
- GitHub Pages publisher (single Git Data API commit, tested against a mocked GitHub API) + "Download site (.zip)". No workflow files.
- `@stepdoc/mcp`: stdio CLI + HTTP endpoint on all targets; WebMCP registration; `npx stepdoc replay <guide>` writing `verification` (tested against local fixtures).

**M17 — Landing + docs**
- Rebuild `site/` from L01/L02; docs per target (browser, PHP, Cloudflare, Node, Pages); `site/llms.txt` updated; local Lighthouse ≥ 95 perf/a11y. Commit and push only; do not deploy.

**M18+ — Refinement loop** (as v1 §6 M8): audit one area per run against §10 and Figma, fix the worst gap, add a regression test. Backlog seeds: Safari build, OIDC/SAML add-on, translation (BYO key), analytics dashboard, BookStack/Wiki.js/Docmost export.

## 15. Loop protocol (every run)
1. Read `AGENTS.md`, this file, then `PROGRESS_V2.md`. Use branch `main` per §0 (initial `v2` setup and rename are already complete). On a first run without progress tracking, create `PROGRESS_V2.md` with, in this order: a **Milestones** table (M9–M17: status · date · summary · commit), the M9–M17 checklist from §14, `## Owner later (non-blocking)`, `## Backlog`, `## Deviations`, `## Run log`, and `## Defaults in use` copied from §16.
2. Pick the first unchecked criterion in the earliest incomplete milestone (split big ones into sub-boxes first).
3. Implement fully — no stubs. Keep the contract, schema and tokens files in sync with code.
4. Verify locally: `pnpm verify` (+ `pnpm test:contract` for server work, `pnpm test:a11y` for UI work). For UI, compare against the Figma frame in §12 at the same size. No GitHub Actions, no live services, no manual steps.
5. Record and publish progress: check boxes, append a Run log entry (date, change, next, new backlog items), commit, `git push origin main` directly; no PR. If this finished a milestone: tag `v2-mN`, push with `--follow-tags`, update the Milestones table.
6. Stop clean: working tree clean, verify green, branch pushed.
Never delete requirements; record deviations with rationale. If something needs the owner (credentials, a live host, a store, a decision), add it to *Owner later* and continue with the largest unblocked task. Never pause to ask.

## 16. Defaults (in bold; use them, never ask — the owner changes them by editing this file)
- Repo: **`tanzir71/stepdoc`** (renamed during v2 setup, §0). Work branch: **`main`**; commit/push directly, **no PR**, per the owner update.
- Logo: **A "Stepline"** / B "Marker" / C "Fold" (Foundations board).
- Licence: **MIT** — add `LICENSE` in M9.
- Name: **StepDoc**.
- Comments (P11) in v2: **yes, last in M15**.
- Hosted SaaS: **none** in v2.
- GitHub Actions: **none**, ever, unless the owner adds them.
- Owner-later (never blocking): GitHub-side rename if `gh` lacks rights, browser/store installs, live deployments, real publishing, re-checking competitor prices before launch.

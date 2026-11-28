# StepDoc

[Source](https://github.com/tanzir71/stepdoc) · [MIT licence](LICENSE)

The `main` branch implements [CODEX_HANDOFF_V2.md](CODEX_HANDOFF_V2.md), with direct commits and no PRs per the owner's instruction. See [PROGRESS_V2.md](PROGRESS_V2.md) for the current milestone and local verification evidence.

Use the compiled extension: [Chrome ZIP](site/downloads/stepdoc-chrome.zip), [Edge ZIP](site/downloads/stepdoc-edge.zip), or [Firefox ZIP](site/downloads/stepdoc-firefox.zip). Unzip it and load the compiled manifest/folder as described in the [install guide](site/docs/index.html#browser). Node.js, build tools and a backend are not needed. These are unsigned local builds; store signing/listings remain separate.

The v2 extension includes the full local library and editor, capture, redaction and portable image bundles using IndexedDB/OPFS. Export **PDF** through native **Print / Save as PDF**, self-contained **HTML** with embedded fonts/images, Markdown, DOCX, `.stepdoc`, guide.json, Playwright and SKILL.md. These exports work on-device without a backend, including offline. [Version and SHA-256 metadata](site/downloads/extensions.json) accompanies each compiled ZIP.

The **0.2.1 offline extension** update protects active recordings from delayed state updates and keeps controls responsive when a page does not reply. When updating an unpacked extension, reload it in the browser's extension manager and refresh the pages you want to capture.

Back up a workspace from **Settings → Storage & deploy → Export everything (.stepdoc)**. Restore with **Import** in the destination library; guides become private copies and existing guides are kept. Workspace archives include up to 500 current guides and their redacted images, within 256 MB. Trash, version history and credentials are excluded. Export a backup before clearing browser data or removing an extension profile.

Contributors can run `pnpm install --frozen-lockfile` and `pnpm build:extension` to compile all three browser packages. ZIPs are written to `dist/` and `site/downloads/`. The browser SPA also runs with `pnpm dev` at <http://127.0.0.1:3200>; see [apps/app/README.md](apps/app/README.md). Remaining v2 parity work is tracked in the handoff and progress log.

## Legacy v1 reference

The setup and product documentation below describe the shipped v1 app, available with `pnpm dev:legacy`, until the v2 targets reach parity.

[Website](https://stepdoc-guides.vercel.app/) · [Generated HTML guide](https://stepdoc-guides.vercel.app/demo)

> Record a browser workflow once; get an editable, exportable step-by-step guide — like Scribe, but self-hosted in **your** Supabase project.

## What is this?

StepDoc is a Chrome extension + web app pair. Click **Start capture**, do the task (open a page, click buttons, fill forms), click **Stop & open** — and StepDoc turns the session into a numbered guide with annotated screenshots you can edit and export (Markdown, HTML, PDF).

It is deliberately a **single-user internal tool**: do not expose the main web app publicly. Only `/p/{publicId}` (read-only shared guides) is intended for public access.

## Privacy by design

- Typed values are **never** collected — inputs are recorded only as actions ("typed into the Email field").
- Password, email, and sensitive autocomplete fields are pixelated *before* the screenshot persists.
- All data and screenshots live in your own Supabase project.
- Editing is non-destructive: blur/crop/annotation layers are stored separately and flattened server-side for viewing, so originals stay untouched.

## Architecture

```
Chrome (any page you're documenting)
┌─────────────────────────────────┐
│  apps/extension (MV3)            │
│  records clicks/typing as        │
│  ACTIONS (never typed values),   │
│  screenshots each step,          │
│  pixelates sensitive fields      │
│  BEFORE anything persists        │
└──────────────┬──────────────────┘
               │ sends captured steps
               ▼
┌─────────────────────────────────┐        ┌──────────────────────────┐
│  apps/web (Next.js)              │  ────► │  your Supabase project    │
│  editor: text, reorder, markers, │        │  Postgres: guides, steps  │
│  blur/crop/annotate (layers) ────┼──────► │  Storage: screenshots     │
│  server-side flatten on save     │        │  (service-role key stays  │
│  viewer: /p/{publicId} read-only │        │   server-side only)       │
│  exports: MD ZIP · HTML · PDF ·  │        └──────────────────────────┘
│  rich text · iframe embed        │
└─────────────────────────────────┘
```

The security-critical line: the Supabase **service-role key** lives only in server-side env (`.env.local`, never `NEXT_PUBLIC_`), so the browser never holds credentials that could read your whole project.

## Getting started (from zero)

### Prerequisites

| Tool | Why | Get it |
|---|---|---|
| Node.js 20.9+ | Everything | <https://nodejs.org> |
| pnpm 10 | Monorepo manager | `npm install -g pnpm` |
| Supabase account (free) | Data + screenshot storage | <https://supabase.com> |

### 1. Install

```bash
pnpm install
```

### 2. Set up Supabase

1. Create a Supabase project (free tier is fine).
2. In its **SQL editor**, paste and run `apps/web/supabase/migrations/20260710190000_initial_stepdoc.sql`.
3. Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in the project URL and the **server-only service role key**. Never put that key in a `NEXT_PUBLIC_` variable.

### 3. Run the web app

```bash
pnpm dev:legacy
```

Open <http://localhost:3000>.

### 4. Build and verify the extension

```bash
pnpm --filter @stepdoc/extension build -b chrome
pnpm --filter @stepdoc/extension test:browser
```

WXT outputs `.output/chrome-mv3`, `.output/edge-mv3` and `.output/firefox-mv3`
under `apps/extension`. Automated verification loads the Chrome build in a
temporary Playwright Chromium profile and lints Firefox; no owner installation
is needed. The extension's **Open library** link runs the local SPA in a full
tab. The retained v1 capture controls use the web app URL configured in extension
settings (default `http://localhost:3000`). See [extension details](apps/extension/README.md).

## Usage

Click **Start capture**, complete a browser workflow, then **Stop & open**. In the editor: adjust guide text, reorder or delete steps, add section headers/manual steps, upload images, move/resize/remove click markers, and draw blur/crop/annotation layers. Saves regenerate flattened viewer images server-side.

Viewer actions: Markdown ZIP, standalone HTML, PDF export, Copy Markdown, Copy rich text, public UUID sharing, and iframe embed snippets.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | v2 browser SPA at 127.0.0.1:3200 |
| `pnpm dev:legacy` | v1 Next development server at localhost:3000 |
| `pnpm test:a11y` | v2 route accessibility snapshots and axe |
| `pnpm build` | Build all workspaces |
| `pnpm verify` | Lint, strict typecheck, unit tests, Playwright e2e, production builds |

Automated local verification: `pnpm verify` includes Playwright Chromium with the local test-store. The v1 manual checklist is historical; v2 acceptance uses automated checks only. Live installations and deployments are tracked under "Owner later (non-blocking)" in `PROGRESS_V2.md`.

## Troubleshooting

- **Extension captures nothing** → confirm the app URL in extension settings matches where the web app runs, and reload the extension after rebuilding.
- **Screenshots missing in guides** → check the Supabase Storage bucket exists (created by the migration) and the service key in `.env.local` is correct.
- **Public link works but editor doesn't** → by design; the editor is meant for you only, behind your network. Keep it unexposed.

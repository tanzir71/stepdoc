# StepDoc — Codex Build Handoff

**Working name:** StepDoc (rename freely; keep package names consistent once chosen)
**Goal:** A personal/internal alternative to Scribe (https://scribe.com/tools/documentation-generator) — capture a browser workflow once, get a polished step-by-step guide with screenshots, edit it, and export/share it. No paywalls, no data leaving your own Supabase project.

This document is the single source of truth. It is designed to be run **in a loop**: each Codex run reads this file, executes the Loop Protocol (§9), implements the next unit of work, verifies it, records progress, and stops at a clean commit.

---

## 1. Competitive Landscape (why this exists)

### 1.1 Scribe (the incumbent we're replacing)
- **How it works:** Chrome extension auto-captures every click/input while you work. Each action produces a screenshot + auto-generated step text ("Click *Save*"). Ends with an editable guide in their web app.
- **Key features:** auto-capture with click detection; AI-generated step descriptions and titles; Smart Blur (auto-redacts 7 categories — emails, numbers, names, long text, form fields, table rows, images — applied client-side *before* screenshots upload); manual blur/redact/annotate; export to PDF/HTML/Markdown; share links and embeds; desktop capture (Pro only).
- **Pricing (2026):** Free tier = unlimited guides but **no PDF export, no desktop capture, Scribe branding**. Pro Personal ≈ $23–25/seat/mo. Pro Teams ≈ $12–13/seat/mo with 5-seat minimum (~$720/yr entry). Enterprise custom — small teams have reported ~$18k/yr quotes.
- **Pain points to exploit:** export formats paywalled; screenshots stored on their servers (compliance concern); expensive for individuals; branding on free tier; requires account.

### 1.2 Other competitors
| Tool | Model | Strengths | Weaknesses |
|---|---|---|---|
| **Tango** | SaaS, Pro ~$16/mo | Interactive "Guide Me" in-app overlay walkthroughs; slightly cheaper than Scribe | Same paywall/hosted-data model |
| **Guidde** | SaaS | AI-narrated *video* guides with captions | Video-first, not doc-first; hosted |
| **Folge** | Desktop, one-time $70–$120 | One-time purchase, offline, captures any desktop app | No browser DOM awareness, dated UX, manual sharing |
| **Dubble** | SaaS freemium | Instant guide + share link, generous free tier | Thin editor, hosted only |
| **Supademo** | SaaS, free 5 demos, Pro ~$27/mo | Interactive clickable demos, analytics | Demo-focused, not SOP/doc-focused |
| **iorad** | SaaS, business from ~$200/mo | One recording → tutorial/guide/video/slides | Very expensive, dated UI |
| **Floik** | SaaS, affordable | Demos + guides + videos, AI assistant | Sales/CS-oriented, hosted |

### 1.3 Positioning of StepDoc
- **Own your data:** screenshots live in *your* Supabase project. Nothing touches third-party servers.
- **No paywalls:** PDF/HTML/Markdown export, unlimited guides, no branding — all free because it's yours.
- **Privacy by default:** typed values are never recorded; password/email fields auto-blurred at capture time (rules-based, no AI needed — we know the field type from the DOM, which Scribe's AI approach can't guarantee).
- **Non-goals (do NOT build):** AI/LLM features, auth/multi-tenancy, billing, desktop capture, video recording, analytics, team roles. Single-user/internal only.

---

## 2. Product Requirements

### 2.1 Capture (Chrome extension, Manifest V3)
- R1. Toolbar popup with **Start capture / Stop / Cancel**; badge shows recording state and step count.
- R2. While recording, a content script listens for: `mousedown` (clicks), committed text inputs (on blur/Enter — record *that* a field was filled, never the value), `change` on `<select>`, `Enter` key submits, and full-page navigations.
- R3. On each event, capture **before** the UI mutates: element metadata (tag, `innerText`/`aria-label`/`placeholder`/`alt`/associated `<label>`, a robust CSS selector, bounding rect, input `type`), click coordinates, `devicePixelRatio`, viewport size, page URL and title.
- R4. Background service worker takes a screenshot via `chrome.tabs.captureVisibleTab`. **Constraint:** Chrome throttles this (~2 calls/sec) — queue and debounce; if throttled, reuse the last frame rather than dropping the step.
- R5. Auto-blur at capture: before storing, pixelate the bounding rects of any on-screen `input[type=password]`, `input[type=email]`, and elements with `autocomplete` hinting at sensitive data (cc-number, etc.). Done in the extension via OffscreenCanvas — sensitive pixels never persist.
- R6. Click indicator: composite a highlight circle onto the screenshot at click coords (scale by devicePixelRatio).
- R7. Step text is **rules-based**, generated from metadata (see §5). Editable later.
- R8. On Stop: session (steps JSON + screenshot blobs) uploads to the web app via its API; extension opens the new guide in the editor. If upload fails, session persists in `chrome.storage.local` for retry.
- R9. Multi-page flows: navigations recorded as steps ("Navigate to …"); capture continues across same-tab navigations. (Cross-tab capture is a stretch goal, not v1.)

### 2.2 Web app (Next.js)
- R10. **Guide list:** cards with title, step count, created date, source domain, thumbnail; search by title; delete with confirm.
- R11. **Guide viewer:** clean article layout — title, description, numbered steps with screenshots. This layout is also the share/export layout.
- R12. **Editor:**
  - Edit title, description, and each step's text (inline).
  - Reorder steps via drag-and-drop; delete steps; add a manual step (text-only or with uploaded image); merge/split not required.
  - Move/resize/remove the click indicator per step.
  - Section headers as a step type (for grouping long guides).
- R13. **Image tools** (canvas-based, per screenshot, non-destructive — stored as edit layers, original kept):
  - Blur/pixelate rectangular regions.
  - Crop.
  - Annotations: rectangle outline, arrow, freeform text label.
  - Undo/redo within the image editor.
- R14. **Exports:**
  - Markdown (`.md` + relative image folder, zipped) — works pasted into Notion/GitHub.
  - Self-contained HTML (images inlined as base64, single file).
  - PDF (print-quality, via headless render of the viewer layout).
  - Copy-to-clipboard as rich text/markdown.
- R15. **Sharing:** toggle a guide "public" → unguessable UUID URL renders the read-only viewer; embed `<iframe>` snippet. Toggle off revokes.
- R16. Dark mode, responsive down to tablet, keyboard shortcuts in editor (arrow between steps, `e` to edit, `del` to delete with confirm).

### 2.3 Quality bar
- Fast: guide with 50 steps opens < 1.5s on localhost; images lazy-loaded.
- Empty states, loading skeletons, and error toasts everywhere data loads or mutates.
- No unhandled promise rejections; all API routes validate input (zod) and return typed errors.

---

## 3. Architecture & Stack

```
stepdoc/
├── apps/
│   ├── web/          # Next.js 14+ (App Router), TypeScript, Tailwind, shadcn/ui
│   └── extension/    # Chrome MV3, TypeScript, Vite (or CRXJS), React for popup
├── packages/
│   └── shared/       # step-text generator, types, selector builder, zod schemas
├── CODEX_HANDOFF.md  # this file
├── PROGRESS.md       # created by first run; the loop's memory
└── package.json      # pnpm workspaces
```

- **Runtime/data:** Supabase — Postgres for guides/steps, Storage bucket `screenshots` for images. All Supabase access goes through Next.js API routes using the **service role key** (server-side only). The browser and extension never hold Supabase credentials; the extension talks to `http://localhost:3000/api/*` (base URL configurable in extension options).
- **Single-user mode:** no auth. Do not enable RLS-dependent flows; document in README that the web app must not be exposed publicly as-is (share links are the only intended public surface — enforce read-only on those routes).
- **Env:** `apps/web/.env.local` → `NEXT_PUBLIC_APP_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Provide `.env.example`.
- **Image handling:** screenshots stored as captured (PNG or WebP). Edit layers stored as JSON on the step; a flattened WebP is generated server-side (sharp) on save for viewer/export use.
- Libraries: `@dnd-kit` (reorder), `zod`, `sharp`, `playwright` (tests + PDF render), `jszip` (md export). Avoid heavyweight state libs; React Query or plain server components are fine.

---

## 4. Data Model (Supabase migrations)

```sql
create table guides (
  id uuid primary key default gen_random_uuid(),
  title text not null default 'Untitled guide',
  description text default '',
  source_url text,
  is_public boolean not null default false,
  public_id uuid unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table steps (
  id uuid primary key default gen_random_uuid(),
  guide_id uuid not null references guides(id) on delete cascade,
  position integer not null,
  type text not null check (type in ('action','navigate','section','manual')),
  text text not null,
  page_url text,
  screenshot_path text,          -- storage path of original
  rendered_path text,            -- flattened image with edits applied
  click jsonb,                   -- {x,y,radius} in image px, nullable
  element_meta jsonb,            -- captured DOM metadata
  edits jsonb not null default '{"blur":[],"crop":null,"annotations":[]}',
  created_at timestamptz not null default now()
);
create index on steps (guide_id, position);
```

Storage: bucket `screenshots`, path `guides/{guide_id}/{step_id}/{original|rendered}.webp`.

---

## 5. Step-Text Generation Rules (packages/shared)

Pure function `describeStep(meta: ElementMeta): string` — fully unit-tested. Label resolution priority: associated `<label>` → `aria-label` → `innerText` (trimmed, ≤40 chars) → `placeholder` → `alt` → `title` attr → `name` attr → fallback to element role.

| Event | Template |
|---|---|
| Click on button/link/role=button | `Click "{label}"` |
| Click on checkbox/radio | `Select "{label}"` / `Check "{label}"` |
| Text input committed | `Fill in the "{label}" field` (never the value) |
| Select change | `Select "{optionLabel}" from the "{label}" dropdown` |
| Enter submit | `Press Enter to submit` |
| Navigation | `Go to {hostname}{shortened path}` |
| Click with no resolvable label | `Click here` (flag `lowConfidence: true` so editor highlights it for review) |

Sanitize labels: collapse whitespace, strip emoji-only noise, truncate with ellipsis.

---

## 6. Milestones & Acceptance Criteria

Work strictly in order. A milestone is **done** only when every criterion passes and its tests are green.

### M0 — Scaffold
- pnpm monorepo per §3; web app boots; extension builds and loads unpacked in Chrome; shared package imported by both.
- Tooling: TypeScript strict, ESLint + Prettier, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass from root.
- Supabase migration files in `apps/web/supabase/migrations/`; README with full setup steps (Supabase project creation → env → run).

### M1 — Capture MVP (extension)
- Start/stop from popup; clicks and inputs on any site produce steps with screenshots, metadata, click indicators, and rules-based text.
- Auto-blur of password/email fields verified on a test page.
- captureVisibleTab throttling handled (rapid 5-click burst loses no steps).
- On stop, a `session.json` + images can be downloaded locally (upload comes in M2). Unit tests for `describeStep` and selector builder (≥ 20 cases).

### M2 — Persistence + viewer (web)
- `POST /api/sessions` accepts extension payload, creates guide + steps, uploads images to Storage.
- Guide list and read-only viewer render correctly for a 30-step guide. Extension → web handoff opens the guide automatically.
- Playwright e2e: seed a guide via API, assert list + viewer.

### M3 — Editor
- All of R12. Reorder persists `position` correctly (test with 10 reorders). Low-confidence steps visually flagged.
- Autosave with debounce + "saved" indicator; no data loss on refresh mid-edit.

### M4 — Image tools
- All of R13. Edits persist as layers; `rendered_path` regenerated on save; original untouched. Undo/redo ≥ 20 levels.

### M5 — Exports
- All of R14. Acceptance: exported Markdown renders correctly on GitHub; HTML file opens standalone with all images; PDF paginates without splitting a screenshot across pages.

### M6 — Sharing
- Public toggle + UUID route (read-only, no editor affordances, noindex meta); embed snippet; revoke works immediately.
- Verify non-public guides return 404 on the public route (test).

### M7 — Polish & hardening
- R16 complete. Lighthouse (local) ≥ 90 performance/accessibility on viewer. Error boundaries; API input validation everywhere; empty/loading states audit.
- Full e2e regression suite green. README finalized with GIF-worthy usage walkthrough (text is fine).

### M8+ — Refinement loop (never "done")
Each run: self-audit one area against §2.3 and the acceptance criteria above; fix the worst gap found; add a regression test. Maintain a `## Backlog` section in PROGRESS.md with discovered improvements (a11y, perf, UX friction, capture edge cases — SPAs, iframes, shadow DOM, infinite scroll pages) and burn it down by impact.

---

## 7. Testing Policy
- `packages/shared`: Vitest, ~100% coverage on `describeStep` and selectors.
- `apps/web`: Playwright e2e for every user-facing flow (list, view, edit, reorder, image edit, each export, share). Vitest for API route handlers (mock Supabase).
- `apps/extension`: extract logic (event → meta, blur regions, queueing) into pure modules under test; keep Chrome-API glue thin. Maintain `apps/extension/MANUAL_TEST.md` checklist and update it per milestone.
- CI stand-in: `pnpm verify` = lint + typecheck + test + build. Must pass before every commit.

## 8. Conventions
- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`). Small, coherent commits — one per loop run minimum.
- No `any`, no `@ts-ignore` without a comment. Zod schemas in `packages/shared` are the single source of truth for API payloads.
- UI: Tailwind + shadcn/ui; neutral, documentation-tool aesthetic (think Linear/Notion, not dashboard-flashy).

---

## 9. Loop Protocol (execute this every run)

1. **Read state:** this file, then `PROGRESS.md` (create it on first run with the M0–M8 checklist copied from §6, plus empty `## Backlog` and `## Run log`).
2. **Pick work:** the first unchecked criterion in the earliest incomplete milestone. If all M0–M7 are checked, run an M8 refinement iteration.
3. **Implement fully** — no stubs, no TODO-and-move-on. If a criterion is too large for one run, split it into sub-checkboxes in PROGRESS.md first, then do the first one.
4. **Verify:** run `pnpm verify`. For UI work, add/extend the relevant Playwright test. Do not check a box on the strength of "it should work".
5. **Record:** check off completed boxes; append a Run log entry (date, what changed, what's next, any new Backlog items); commit.
6. **Stop cleanly** — working tree clean, verify green.

**Rules:** never skip milestones; never delete this file's requirements — if a requirement proves wrong, note the deviation and rationale in PROGRESS.md under `## Deviations`. If blocked (e.g., missing env/Supabase), write exact unblocking instructions for the human at the top of PROGRESS.md and do the largest unblocked task instead.

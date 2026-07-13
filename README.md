# StepDoc

[Website](https://stepdoc-guides.vercel.app/) · [Generated HTML guide](https://stepdoc-guides.vercel.app/demo)

StepDoc captures browser workflows with a Chrome extension and turns them into editable, exportable guides. Data and screenshots remain in your Supabase project. This is deliberately a single-user internal tool: **do not expose the main web app publicly**. Only `/p/{publicId}` is intended for read-only sharing.

## Setup

1. Install Node 20.9+ and pnpm 10, then run `pnpm install`.
2. Create a Supabase project. In its SQL editor, apply `apps/web/supabase/migrations/20260710190000_initial_stepdoc.sql`.
3. Copy `apps/web/.env.example` to `apps/web/.env.local`, fill in the project URL and server-only service role key. Never put that key in a `NEXT_PUBLIC_` variable.
4. Run `pnpm dev`, then open `http://localhost:3000`.
5. Run `pnpm --filter @stepdoc/extension build`. In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`.
6. Open the extension settings and leave the app URL at `http://localhost:3000` or enter your internal deployment URL.

## Usage

Click **Start capture**, complete a browser workflow, then click **Stop & open**. Inputs are recorded only as actions; typed values are never collected. Password, email, and sensitive autocomplete fields are pixelated before the screenshot persists.

In the editor, adjust guide text, reorder or delete steps, add section headers/manual steps, upload images, move/resize/remove click markers, and draw non-destructive blur/crop/annotation layers. Saves regenerate flattened viewer images server-side while keeping originals untouched.

Viewer actions include Markdown ZIP, standalone HTML, PDF export, Copy Markdown, Copy rich text, public UUID sharing, and iframe embed snippets.

## Commands

- `pnpm dev` - web development server
- `pnpm build` - build all workspaces
- `pnpm verify` - lint, strict typecheck, unit tests, Playwright e2e, and production builds

See `apps/extension/MANUAL_TEST.md` for capture verification.

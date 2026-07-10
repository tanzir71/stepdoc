# StepDoc

StepDoc captures browser workflows with a Chrome extension and turns them into editable, exportable guides. Data and screenshots remain in your Supabase project. This is deliberately a single-user internal tool: **do not expose the main web app publicly**. Only `/p/{publicId}` is intended for read-only sharing.

## Setup

1. Install Node 20.9+ and pnpm 10, then run `pnpm install`.
2. Create a Supabase project. In its SQL editor, apply `apps/web/supabase/migrations/20260710190000_initial_stepdoc.sql`.
3. Copy `apps/web/.env.example` to `apps/web/.env.local`, fill in the project URL and server-only service role key. Never put that key in a `NEXT_PUBLIC_` variable.
4. Run `pnpm dev`, then open `http://localhost:3000`.
5. Run `pnpm --filter @stepdoc/extension build`. In `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `apps/extension/dist`.
6. Open the extension settings and leave the app URL at `http://localhost:3000` (or enter your internal deployment URL).

## Usage

Click **Start capture**, complete a browser workflow, then click **Stop & open**. Inputs are recorded only as actions—typed values are never collected. Password, email, and sensitive autocomplete fields are pixelated before the screenshot persists. Edit text and order, add manual steps and image layers, render, share by UUID, or export Markdown/HTML. Use the viewer's print dialog for PDF.

## Commands

- `pnpm dev` — web development server
- `pnpm build` — build all workspaces
- `pnpm verify` — lint, strict typecheck, unit tests, and production builds

See `apps/extension/MANUAL_TEST.md` for capture verification.

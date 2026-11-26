# Figma landing on GitHub Pages

The existing Pages source is `main:/`. The generated root `index.html` serves
the landing directly at https://tanzir71.github.io/stepdoc/ with no redirect.
`site/index.html` preserves the earlier `/stepdoc/site/` URL. All resources stay
inside the project prefix; neither route requires JavaScript to read content.
The root `.nojekyll` marker keeps Markdown and SKILL.md downloads intact.
Generated stylesheet/script fingerprints prevent a cached v1 page bundle from
styling the new markup.

L01 (`32:7455`) and L02 (`33:7805`) in the StepDoc Figma file are the references.
The native HTML composes shared Button, Badge, StepPin and Logo CSS, shared
semantic tokens and local Geist fonts. Original downloaded assets and their
node/slot/dimension/hash records are in `assets/provenance.json`. The Ledgerly
image is fictional screenshot content, not a separately implemented app.
See `docs/v2/screens/README.md` for measurements and deliberate adaptations.

- `pnpm website:build` regenerates both entries, shared CSS/tokens and schema.
  Edit `scripts/landing-template.mjs`, not the generated entries.
- `pnpm website:guide` uses the actual schema and core exporters to generate
  `demo/` HTML, JSON, Markdown, Playwright, SKILL.md and portable images.
- `pnpm website:verify` detects generated-source, asset, font and export drift.
- `pnpm website:browser` serves the repository locally under `/stepdoc/`, checks
  Figma section geometry at 1440px and 390px, every visible original SVG's
  dimensions/painted pixels, aria snapshots, axe, keyboard menu/FAQ, downloads,
  docs, 320/768/1024px overflow and script-free reading. No remote font or other
  failed/external resource request is allowed. Set `STEPDOC_UPDATE_SITE=1` to
  regenerate the four aria snapshots and the locally rendered OG image.
- `pnpm website:lighthouse` runs local Lighthouse mobile and desktop against
  the project root, requiring performance and accessibility scores of 95+.

All three verification commands run inside `pnpm verify`. Reports/screenshots
go to ignored `test-results/website/`. `STEPDOC_SITE_URL` optionally points the
browser checks at the existing public Pages URL; Lighthouse stays local.
No workflow, deployment or Pages-setting command is involved.

The menu is a native dialog with Enter/Esc/focus return and a `?menu=open`
state. FAQ uses native details/summary. Install and Deploy actions lead to
real documentation; no store listing or unbuilt server is implied. Remaining
target implementation and full deployment documentation stay tracked in M17.

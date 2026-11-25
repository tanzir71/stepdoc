# Token components

`@stepdoc/ui` provides native React versions of Figma Button, IconButton, Badge, Kbd, Input, Toggle, Checkbox, Segment, NavItem, StepRow, ClickMarker, StepPin, Avatar and Logo. `SegmentGroup` adds tablist keyboard behavior. Interactive controls require a stable `data-sd`; icon-only buttons and form controls require accessible names. Components use the lower-case variant values in the handoff §11, with the corresponding Figma names/props. Buttons and badges accept either children or a `label`.

Import `@stepdoc/ui/styles.css` once. It includes generated `tokens.css` and local variable Geist/Geist Mono fonts. Run `node packages/ui/scripts/tokens.mjs` after editing `docs/v2/design-tokens.json`; lint/build reject stale generated CSS. Light is the default; the app explicitly resolves a System preference. Font files come from the pinned official `geist@1.9.2` package under the included SIL OFL.

`assets/provenance.json` maps the unmodified Figma SVG downloads to source nodes. `dimensions.json` records intrinsic root dimensions. Monochrome icons use CSS masks at those dimensions and current semantic color. Original SVG paths, root sizes and viewBoxes are preserved. The original 32px light logo is transformed inside the library's 24px slot; the dark mark is intrinsically 24px. The editor uses the reference's 32px slot through `Logo size="m"`. This avoids changing the asset roots. The component browser check verifies dimensions, keyboard/controlled states and both themes with axe. `Toggle` without an `onChange` is explicitly disabled, used for the editor's locked query-stripping policy.

Accessibility adjustments are centralized in the design tokens: deeper light-theme accent/status text, a dark image-label surface and white overlay text. Small metadata uses secondary text because tertiary text on these surfaces fails AA. The local user avatar uses neutral colors, reserving agent colors for agent affordances. No palette literals appear in component code.

W05 adds seven original SVGs at their intrinsic dimensions and measured dialog/card
tokens. Agent badge text uses `agent/text`: the light `agent/solid` text reached
only 4.01:1 over the combined selected-card and soft-badge surfaces. The deeper
text token passes AA there while preserving the solid accent and soft fill.

The final M10 audit retains four additional W12 color variants as source reference
assets. The component browser test proves that their unchanged intrinsic masks
render byte-identical PNGs to the existing shared chevron, grid, list and dot
silhouettes. CSS supplies the semantic theme color. Screen-level checks also
verify every visible icon's local source, callsite and effective dimensions.

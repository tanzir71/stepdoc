# Pages landing

GitHub Pages serves the repository root from `main` at
`https://tanzir71.github.io/stepdoc/`. The root `index.html` navigates to this
directory using a script-free relative refresh and a native fallback link.
`site/index.html` is the single landing source.

Keep asset and internal links relative to this directory. `/styles.css` targets
the account root and breaks a project site; `./styles.css` works at
`/stepdoc/site/` and in forks. Geist fonts and their OFL licence are bundled in
`fonts/`; the page requires no external font service. Its content remains visible
without JavaScript; the optional simulation uses only invented actions.

`pnpm website:verify` checks the entry, paths, fonts and generated export.
`pnpm website:browser` starts its own local static fixture, mounting the repository
at `/stepdoc/` exactly like Pages. It checks root navigation, loaded CSS/fonts,
all internal links/resources, simulation/reset, five embedded export images,
390/320px layouts and script-free reading without failed or external requests.
Both commands run at the end of `pnpm verify`.

This repairs the existing landing's serving paths. The L01/L02 redesign, target
documentation and Lighthouse milestone remain in M17.

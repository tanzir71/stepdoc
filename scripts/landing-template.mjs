import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const escape = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
export async function renderLanding() {
  // Stable fingerprints prevent cached v1 CSS/JS from styling the new markup.
  const [tokenStyle, sharedStyle, pageStyle, script] = await Promise.all(
    [
      ['./ui/tokens.css', '../packages/ui/tokens.css'],
      ['./ui/styles.css', '../packages/ui/styles.css'],
      ['./styles.css', '../site/styles.css'],
      ['./main.js', '../site/main.js'],
    ].map(async ([url, source]) => {
      const body = (
        await readFile(new URL(source, import.meta.url), 'utf8')
      ).replaceAll('\r\n', '\n')
      return `${url}?v=${createHash('sha256').update(body).digest('hex').slice(0, 12)}`
    }),
  )
  const tokens = JSON.parse(
    await readFile(
      new URL('../docs/v2/design-tokens.json', import.meta.url),
      'utf8',
    ),
  )
  const manifest = JSON.parse(
    await readFile(
      new URL('../site/assets/provenance.json', import.meta.url),
      'utf8',
    ),
  )
  const icon = (file, className = '', label = '') => {
    const asset = manifest.assets.find((asset) => asset.file === file)
    if (!asset) throw new Error(`Missing landing asset: ${file}`)
    return `<img class="asset ${className}" data-asset="${file}" src="./assets/${file}" width="${asset.width}" height="${asset.height}" alt="${escape(label)}"${label ? '' : ' aria-hidden="true"'}>`
  }
  const logo = () =>
    `<span class="sd-logo"><span class="sd-logo-symbol">${icon('fce33.svg', 'sd-logo-light')}</span><span>stepdoc</span></span>`
  const button = (
    label,
    href,
    file,
    kind = 'primary',
    size = 'm',
    hook = 'landing-install',
  ) =>
    `<a class="sd-button" data-kind="${kind}" data-size="${size}" data-sd="${hook}" href="${href}">${icon(file)}<span>${label}</span></a>`
  const badge = (label, tone, dot) =>
    `<span class="sd-badge" data-tone="${tone}">${dot ? icon(dot) : ''}${label}</span>`
  const links = () =>
    `<a href="#product">Product</a><a href="#agents">Agents</a><a href="#self-host">Self-host</a><a href="#compare">Compare</a><a href="./docs/">Docs</a><a class="github-link" href="https://github.com/tanzir71/stepdoc">${icon('0cb95.svg')}<span>GitHub</span></a>`
  const install = (size = 'm', label = 'Add to Chrome — free') =>
    button(
      label,
      './docs/#browser',
      size === 's' ? '06ea8.svg' : '9c11a.svg',
      size === 's' ? 'secondary' : 'primary',
      size,
    )
  const hosting = [
    [
      'This browser',
      'Extension only. Guides live in IndexedDB; export when you need to share.',
      'Load the extension',
      'browser',
      '43d42.svg',
      '9524a.svg',
    ],
    [
      'Shared hosting',
      'PHP 8.1 + SQLite. No daemons, no cron, no Node.',
      'upload /stepdoc → public_html',
      'php',
      '2671b.svg',
      '32c66.svg',
    ],
    [
      'Cloudflare',
      'Workers + D1 + R2 on the free tier.',
      'npx wrangler deploy',
      'cloudflare',
      '316d1.svg',
      'c4590.svg',
    ],
    [
      'Node + Postgres',
      'Docker image or the Supabase stack.',
      'docker compose up',
      'node',
      'aa14e.svg',
      '26b62.svg',
    ],
    [
      'GitHub Pages',
      'Read-only guide sites with llms.txt and JSON.',
      'Publish → repo',
      'pages',
      '04235.svg',
      'aad3f.svg',
    ],
  ]
  const checks = [
    [
      'Targets stored as role + accessible name first, selectors as fallback',
      'Role + accessible name targets, selectors as fallback',
    ],
    [
      'Expected result per step, so an agent knows it worked',
      'Expected result per step',
    ],
    [
      'Typed values become variables or secrets — never stored',
      'Secrets as variables, never stored',
    ],
    [
      'guide.json, guide.md, Playwright spec and SKILL.md on every guide',
      'guide.json · guide.md · Playwright · SKILL.md',
    ],
    [
      'llms.txt, JSON-LD and Markdown alternates on published sites',
      'llms.txt; MCP integration on the v2 roadmap',
    ],
    ['MCP + WebMCP integration on the v2 roadmap', null],
  ]
  const privacy = [
    [
      'Typed values never recorded',
      'Typed values never recorded',
      'Inputs are stored as actions: “Fill in the Invoice email field”. Passwords and secrets never touch disk.',
      'value: { kind: "secret" }',
      '16f64.svg',
      '50237.svg',
    ],
    [
      'Blur before upload',
      'Sensitive fields pixelated in the tab',
      'Pattern detectors run in the extension. The server only ever receives already-redacted pixels.',
      'redactions[] kept as layers',
      '6ccc5.svg',
      '98edf.svg',
    ],
    [
      'Your storage, your keys',
      'Your storage, your keys',
      'SQLite on your host, D1 + R2 on your account, or your browser. AI is optional and bring-your-own-key.',
      'no StepDoc cloud in the loop',
      '6d2aa.svg',
      '6cb16.svg',
    ],
  ]
  const rows = [
    ['Runs on your own storage', 'Your own storage', 'check', '—', '—'],
    ['Works with no server at all', 'No-server mode', 'check', '—', '—'],
    ['Publish to GitHub Pages', 'GitHub Pages', 'check', '—', '—'],
    [
      'Agent replay file (guide.json + Playwright)',
      null,
      'check',
      '—',
      'Enterprise (Agents)',
    ],
    ['MCP server', 'MCP server', 'planned', 'Enterprise', 'Enterprise'],
    [
      'Enforced redaction before upload',
      'Enforced redaction',
      'check',
      'Enterprise',
      'Enterprise',
    ],
    ['Version history', null, 'Unlimited', '1 week on Pro', '14 days on Pro'],
    [
      'Roles + strong sign-in without Enterprise',
      null,
      'Passkeys (planned)',
      '—',
      '—',
    ],
    [
      'Price for 20 creators, per year',
      '20 creators / yr',
      '$0 licence',
      '$3,120 (Pro Team)',
      '$3,600 (Pro)',
    ],
  ]
  const cell = (value, mobile) =>
    value === 'check' || value === 'planned'
      ? `${icon(mobile ? '6f259.svg' : '3e359.svg', '', value === 'planned' ? 'Planned for v2' : 'Included')}${value === 'planned' ? '<small class="planned">Planned</small>' : ''}`
      : escape(
          mobile
            ? value.replace(' licence', '').replace(' (Pro Team)', '')
            : value,
        )
  const comparison = (mobile) =>
    `<table class="comparison ${mobile ? 'mobile-only' : 'desktop-only'}"><caption class="sd-sr-only">StepDoc v2 feature comparison; planned features are marked. Public pricing checked 25 Nov 2026.</caption><colgroup><col class="feature-column"><col><col>${mobile ? '' : '<col>'}</colgroup><thead><tr><th scope="col"><span class="sd-sr-only">Feature</span></th><th scope="col">${mobile ? 'StepDoc' : logo()}</th><th scope="col"><a href="https://scribe.com/pricing">Scribe</a></th>${mobile ? '' : '<th scope="col"><a href="https://www.tango.ai/pricing">Tango</a></th>'}</tr></thead><tbody>${rows
      .filter((row) => !mobile || row[1])
      .map(
        (row) =>
          `<tr><th scope="row">${escape(mobile ? row[1] : row[0])}</th><td>${cell(row[2], mobile)}</td><td>${cell(row[3], mobile)}</td>${mobile ? '' : `<td>${cell(row[4], false)}</td>`}</tr>`,
      )
      .join('')}</tbody></table>`
  const faq = [
    [
      'Does it work without a server?',
      'Does it work without a server?',
      'Yes. Install the extension and choose “This browser”. Guides, screenshots and versions stay in IndexedDB; export a .stepdoc bundle or pair a server later.',
    ],
    [
      'What actually runs on shared hosting?',
      'What runs on shared hosting?',
      'A static app plus one PHP front controller and a SQLite file outside public_html. Image work happens in the browser, so no Imagick or headless Chrome is needed.',
    ],
    [
      'How does an agent use a guide?',
      'How does an agent use a guide?',
      'Point it at the guide URL or llms.txt. It gets role + name targets and expected results per step, or run the generated Playwright spec in CI.',
    ],
    [
      'Is anything sent to an AI provider?',
      'Is anything sent to an AI provider?',
      'Only if you add your own key, and only DOM context (no screenshots). Rules-based step text works with AI switched off.',
    ],
  ]
  const code = `<span>{</span>
<span class="code-key">  "index": 3,</span>
<span class="code-key">  "action": "click",</span>
<span class="code-key">  "title": "Click \\"Change plan\\"",</span>
<span class="code-key">  "url": "https://app.ledgerly.io/settings/billing",</span>
<span class="code-key">  "target": {</span>
<span class="code-key">    "role": "button",</span>
<span class="code-key">    "name": "Change plan",</span>
<span class="code-key">    "locators": [{ "strategy": "testId",</span>
<span class="code-key">      "value": "billing-change-plan" }]</span>
<span class="code-key">  },</span>
<span class="code-key">  "expect": {</span>
<span class="code-key">    "visible": { "role": "dialog", "name": "Choose a plan" }</span>
<span class="code-key">  }</span>
<span>}</span>

<span class="code-muted">// replay.spec.ts</span>
<span class="code-string">await page.getByRole('button', { name: 'Change plan' }).click();</span>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="${tokens.color['bg/canvas'].light}"><meta name="description" content="Record it once. People read it. Agents run it. StepDoc turns browser workflows into editable guides and replay files, on storage you own."><meta property="og:title" content="StepDoc — Record it once. People read it. Agents run it."><meta property="og:description" content="A step-by-step guide for your team and a replay file for a browser agent — from one capture."><meta property="og:image" content="https://tanzir71.github.io/stepdoc/site/og.png"><title>StepDoc — Record it once. People read it. Agents run it.</title><link rel="canonical" href="https://tanzir71.github.io/stepdoc/"><link rel="icon" href="./assets/fce33.svg" type="image/svg+xml"><link rel="preload" href="./fonts/GeistSans.woff2" as="font" type="font/woff2" crossorigin><link rel="stylesheet" href="${tokenStyle}"><link rel="stylesheet" href="${sharedStyle}"><link rel="stylesheet" href="${pageStyle}"><script src="${script}" defer></script></head>
<body><a class="skip-link" href="#main">Skip to content</a>
<header class="site-header shell" data-figma="32:7456"><a href="./" aria-label="StepDoc home">${logo()}</a><div class="nav-spacer"></div><nav class="site-links" aria-label="Main navigation">${links()}</nav>${install('s', 'Add to Chrome')}${button('Deploy', './docs/#self-host', '0f8c4.svg', 'primary', 's', 'landing-deploy')}<button class="sd-button sd-icon-button site-menu-button" data-kind="ghost" data-sd="landing-menu-open" aria-label="Open menu" aria-controls="site-menu" aria-expanded="false" hidden>${icon('34833.svg')}</button></header>
<main id="main">
<section class="hero shell" aria-labelledby="hero-title" data-figma="32:7486"><p class="eyebrow hero-eyebrow"><span class="desktop-only">Open source  ·  Self-hosted  ·  Agent-readable</span><span class="mobile-only">Open source · Self-hosted</span></p><h1 id="hero-title">Record it once. People read it. Agents run it.</h1><p class="hero-description"><span class="desktop-only">StepDoc turns a browser workflow into a step-by-step guide your team edits and publishes — plus a replay file any browser agent can follow. Run it in your browser, on shared hosting, on Cloudflare, or publish to GitHub Pages.</span><span class="mobile-only">A step-by-step guide for your team and a replay file for any browser agent — from one capture.</span></p><div class="hero-actions">${install()}${button('Deploy to your host', './docs/#self-host', 'aaac0.svg', 'secondary', 'm', 'landing-deploy')}</div><p class="hero-note desktop-only">No account needed in local mode · Chrome, Edge and Firefox</p></section>
<section id="product" class="signature shell" aria-label="Same guide, two readers" data-figma="32:7504"><div class="signature-caption desktop-only"><span>Same guide, two readers</span><a href="./demo/" data-sd="landing-demo">northwind.github.io/ops-guides/finance-ops/upgrade-workspace-team</a></div><div class="signature-panels"><article class="human-panel" aria-labelledby="human-step"><div>${badge('Human view', 'neutral', 'a08f2.svg')}</div><div class="human-title"><span class="sd-step-pin">3</span><h2 id="human-step">Click "Change plan"</h2></div><p class="human-description desktop-only">Opens the plan picker. Only workspace owners see this button.</p><a class="human-shot" href="./demo/" aria-label="Read the example guide" data-sd="landing-demo"><img class="mock-billing" fetchpriority="high" data-asset="ledgerly-billing.png" src="./assets/ledgerly-billing.png" width="1280" height="800" alt="Fictional Ledgerly billing screen, with invoice email and payment details blurred.">${icon('5ba71.svg', 'signature-click')}</a></article><section class="agent-panel" aria-label="Agent view"><div class="agent-panel-header">${badge('Agent view', 'agent', 'a0d91.svg')}<nav class="artifact-links desktop-only" aria-label="Example guide downloads"><a href="./demo/guide.json" data-sd="landing-guide-json">guide.json</a><a href="./demo/replay.spec.ts" data-sd="landing-replay">replay.spec.ts</a><a href="./demo/SKILL.md" data-sd="landing-skill">SKILL.md</a></nav></div><pre class="signature-code desktop-only" tabindex="0" aria-label="guide@1 step and generated Playwright example"><code>${code}</code></pre><pre class="mobile-code mobile-only" tabindex="0" aria-label="Agent step example"><code>"action": "click",
"target": { "role": "button",
  "name": "Change plan" },
"expect": { "visible":
  { "role": "dialog" } }</code></pre></section></div></section>
<section id="self-host" class="hosting shell" aria-labelledby="hosting-title" data-figma="32:7680"><div class="section-heading mobile-only"><p class="eyebrow">Self-host</p><h2 id="hosting-title">Runs where you already pay.</h2></div><h2 class="sd-sr-only desktop-only">Install anywhere</h2><div class="hosting-grid">${hosting.map(([title, description, command, id, desktopIcon, mobileIcon]) => `<a class="hosting-card" href="./docs/#${id}" data-sd="landing-host-${id}">${icon(desktopIcon, 'desktop-only')}${icon(mobileIcon, 'mobile-only')}<div class="hosting-copy"><h3>${title}</h3><p class="desktop-only">${description}</p><code>${escape(command)}</code></div></a>`).join('')}</div></section>
<section id="workflow" class="workflow shell desktop-only" aria-labelledby="workflow-title" data-figma="32:7721"><div class="section-heading"><p class="eyebrow">Workflow</p><h2 id="workflow-title">Capture, edit, redact, publish.</h2><p>Everything Scribe users expect, with the parts that usually cost extra built in.</p></div><div class="workflow-grid">
<article class="workflow-card"><p class="eyebrow">01</p><h3>Capture</h3><p>Clicks, selects and navigation become steps with screenshots. Typed values never do.</p><figure class="mini-capture" aria-label="Example captured steps">${[
    ['01', 'Go to app.ledgerly.io/settings', 'navigate'],
    ['02', 'Click "Billing" in the sidebar', 'click · link'],
    ['03', 'Click "Change plan"', 'click · button'],
  ]
    .map(
      ([n, title, meta]) =>
        `<div><span>${n}</span><div><p>${escape(title)}</p><code>${meta}</code></div></div>`,
    )
    .join('')}</figure></article>
<article class="workflow-card"><p class="eyebrow">02</p><h3>Edit</h3><p>Rewrite, reorder, merge. Each step keeps role, name and selectors for replay.</p><figure class="mini-edit" aria-label="Example ranked locators">${[
    ['role', 'button "Change plan"', 'Unique'],
    ['testId', 'billing-change-plan', 'Unique'],
    ['css', 'section.plan > button', 'Fragile'],
  ]
    .map(
      ([key, value, label]) =>
        `<div><code>${key}</code><code>${escape(value)}</code>${badge(label, label === 'Unique' ? 'success' : 'warning')}</div>`,
    )
    .join('')}</figure></article>
<article class="workflow-card"><p class="eyebrow">03</p><h3>Redact</h3><p>Emails, cards and tokens are pixelated before the screenshot leaves your tab.</p><figure class="mini-redact" aria-label="Example blurred email"><div class="redaction-crop"><img data-asset="ledgerly-billing.png" src="./assets/ledgerly-billing.png" width="1280" height="800" alt="Blurred invoice email"></div><div>${icon('52624.svg')}<span>Email · blurred before upload</span></div></figure></article>
<article class="workflow-card"><p class="eyebrow">04</p><h3>Publish</h3><p>PDF, HTML, Markdown, DOCX, public links, embeds and static sites.</p><figure class="mini-publish" aria-label="Publishing interface preview"><div>${icon('fac58.svg')}<span>Public link</span>${icon('c0302.svg', '', 'Enabled in this illustration')}</div><div>${icon('d3e42.svg')}<span>GitHub Pages</span>${badge('Live', 'success', '0343e.svg')}</div><div>${icon('7a702.svg')}<span>Embed</span>${icon('97bce.svg')}</div></figure></article>
</div></section>
<section id="agents" class="agents shell" aria-labelledby="agents-title" data-figma="32:7937"><div class="agents-copy"><div class="section-heading"><p class="eyebrow">Built for agents</p><h2 id="agents-title"><span class="desktop-only">Guides a browser agent can actually follow.</span><span class="mobile-only">Guides an agent can follow.</span></h2><p class="desktop-only">Agents read the accessibility tree, not pixels. Every StepDoc guide and every app screen is built around that.</p></div><ul class="agent-checks">${checks.map(([desktop, mobile]) => `<li${mobile ? '' : ' class="desktop-only"'}>${icon('97e56.svg')}<span class="desktop-only">${desktop}</span>${mobile ? `<span class="mobile-only">${mobile}</span>` : ''}</li>`).join('')}</ul></div><figure class="webmcp desktop-only" aria-label="Planned WebMCP integration example"><figcaption>${icon('5f370.svg')}<span>app.js</span></figcaption><pre tabindex="0"><code><span class="code-muted">// Integration preview; same tools as the planned MCP server</span>
const mc = document.modelContext ?? navigator.modelContext;
mc?.registerTool({
  <span class="code-string">name: 'export_guide',</span>
  <span class="code-string">description: 'Export a guide as pdf, html, md, json or playwright',</span>
  inputSchema: guideExportSchema, // from @stepdoc/schema
  execute: ({ id, format }) =&gt; stepdoc.export(id, format),
});

<span class="code-muted">// Also registered: list_guides · get_guide · create_guide
// add_step · update_step · publish_guide</span></code></pre></figure></section>
<section id="privacy" class="privacy shell" aria-labelledby="privacy-title" data-figma="32:7983"><div class="section-heading"><p class="eyebrow">Privacy</p><h2 id="privacy-title"><span class="desktop-only">Nothing leaves your storage unless you publish it.</span><span class="mobile-only">Blur happens before upload.</span></h2></div><div class="privacy-grid">${privacy.map(([title, mobile, description, note, desktopIcon, mobileIcon]) => `<article>${icon(desktopIcon, 'desktop-only')}${icon(mobileIcon, 'mobile-only')}<h3><span class="desktop-only">${title}</span><span class="mobile-only">${mobile}</span></h3><p class="desktop-only">${description}</p><code class="desktop-only">${escape(note)}</code></article>`).join('')}</div></section>
<section id="compare" class="compare shell" aria-labelledby="compare-title" data-figma="32:8010"><div class="section-heading"><p class="eyebrow">Compare</p><h2 id="compare-title"><span class="desktop-only">What you get without an Enterprise contract.</span><span class="mobile-only">Without an Enterprise contract.</span></h2></div>${comparison(false)}${comparison(true)}<p class="compare-note"><span class="desktop-only">From public pricing and plan pages, checked 25 Nov 2026. Prices change; re-check before quoting.</span><span class="mobile-only">Public pricing, checked 25 Nov 2026.</span></p></section>
<section id="faq" class="faq shell" aria-label="Frequently asked questions" data-figma="32:8107"><p class="eyebrow mobile-only">FAQ</p><div class="faq-grid">${faq.map(([desktop, mobile, answer], i) => `<details open data-sd="landing-faq-${i + 1}"><summary><span class="desktop-only">${desktop}</span><span class="mobile-only">${mobile}</span>${icon('0c440.svg', 'mobile-only')}</summary><p>${answer}</p></details>`).join('')}</div></section>
<section class="closing shell" aria-labelledby="closing-title" data-figma="32:8122"><div><h2 id="closing-title">Capture your first guide<br class="mobile-only"> in two minutes.</h2><div class="closing-actions">${install()}<span class="desktop-only">${button('Read the self-host guide', './docs/#self-host', 'b2714.svg', 'secondary', 'm', 'landing-docs')}</span></div></div></section>
</main><footer class="site-footer shell" data-figma="32:8137"><a href="./" aria-label="StepDoc home">${logo()}</a><a class="footer-source desktop-only" href="https://github.com/tanzir71/stepdoc">Open source on GitHub</a><div class="footer-spacer desktop-only"></div><nav aria-label="Footer"><a href="./docs/">Docs</a><a href="./docs/guide.schema.json">Schema</a><a href="./llms.txt">llms.txt</a><a class="desktop-only" href="https://github.com/tanzir71/stepdoc/commits/main/">Changelog</a><a class="mobile-only" href="https://github.com/tanzir71/stepdoc">GitHub</a></nav><a class="credit" href="https://tanziro.com">Built by tanziro.com</a></footer>
<dialog id="site-menu" aria-labelledby="menu-title"><div class="menu-heading"><h2 id="menu-title">Menu</h2><button class="sd-button" data-kind="ghost" data-size="s" data-sd="landing-menu-close">Close</button></div><nav aria-label="Mobile navigation">${links()}${install()}${button('Deploy to your host', './docs/#self-host', 'aaac0.svg', 'secondary', 'm', 'landing-deploy')}</nav></dialog>
</body></html>\n`
}

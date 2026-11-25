# StepDoc v2 — research summary (25 Nov 2026)

Condensed from the competitor, architecture and agent-readability research done before the v2 design. Use it for scope decisions and landing-page copy. **Re-check every price on the day you publish** — several moved during October–November 2026.

## Positioning

> The step-by-step guide tool you own, and that your agents can follow.

- Commercial tools (Scribe, Tango, Guidde, iorad, Dubble, Supademo, Arcade, Storylane) are cloud-only and push SSO, enforced redaction, translation, MCP/agent features and unlimited history into Enterprise plans.
- Open-source tools exist and are good: **Mimik** (MIT; Chrome/Firefox/Edge + desktop; smart blur, BYO-key AI, Guide Me replay, PDF/DOCX/HTML/MD/GIF/MP4) and **Showsteps** (MIT; Chrome; IndexedDB; exports an agent skill bundle with SKILL.md + steps.json + replay.spec.ts). Both are extension-only and single-user.
- StepDoc's lane: **multi-target self-hosting** (browser, PHP shared hosting, Cloudflare, Node), **team features without Enterprise**, **published guide sites** (GitHub Pages), and a **documented, versioned agent contract** (guide@1). "Free and open" alone is not a differentiator.

## Pricing snapshot (USD, public pages / third parties, Nov 2026)

| Product | Free | Entry paid | Team | Notes |
|---|---|---|---|---|
| Scribe | Basic: web capture, share link/embed, up to 10 guides | Pro Personal $25/seat/mo yearly ($35 monthly) | Pro Team $13/seat/mo yearly ($17 monthly), 5-seat minimum | scribe.com showed $13/$17 on 25 Nov; third parties showed $23/$29 in late Oct — volatile |
| Tango | Up to 10 users, few shared workflows | Pro $22/user/mo yearly (1–2 users) | Pro $15/user/mo yearly (3+), every member upgraded | Guide Me/Pins, PII redaction, SSO, MCP on Enterprise; Agents from $12.5k/yr |
| Guidde | 25 videos, watermark | Pro $19/creator/mo yearly | Business $39 (max 5 creators) | repriced 29 Sep 2026 |
| iorad | public tutorials only | Individual $200/mo | Team $500/mo | |
| Dubble | unlimited guides + seats | Pro $18/mo yearly (3 creators) | — | |
| Folge | 5 local guides | $89 one-time | $155/seat one-time | desktop, offline |
| Supademo / Storylane / Arcade | 1–5 demos | ~$38–42/seat/mo | $350–625/mo | interactive demos — different buyer |

Landing comparison math (keep the date stamp): 20 creators on Scribe Pro Team = 20 × $13 × 12 = **$3,120/yr**; on Tango Pro = 20 × $15 × 12 = **$3,600/yr**; a 3-person team on Scribe still pays for 5 seats (**$780/yr**). Enterprise quotes (~$18k/yr for 5 users with SSO) are user reports — do not put them on the landing page.

## Scribe gating (scribe.com/pricing, 25 Nov 2026)

Basic: web capture only. Pro Personal: desktop capture, unlimited guides, Pages, branding, screenshot editing, PDF/HTML/MD/Word export, Smart Blur. Pro Team: + comments, request guides. Enterprise only: enforced/custom auto-redaction, translation, unlimited version history (Pro gets 1 week), MCP server, enterprise search API, SAML SSO, SCIM, RBAC, approvals, verification. Scribe's 2026 changelog added Magic Edit (AI rewrite + merge duplicates), video-to-guide, Autocapture and comments on Pages.

## What users praise / complain about

- Praised: fast auto-capture, auto-written step text, clean screenshots, easy link/embed sharing, Guide Me-style in-app replay.
- Complaints: cleanup after capture (extra steps), export limits, desktop paywall, 5-seat minimum, SSO only on Enterprise, per-seat pricing for viewer-heavy teams, watermarks, every member needing a paid seat.

## Ranked v2 scope

**Must-have for parity (build order):** auth + workspaces + roles → collections/Pages + list view + search → AI clean-up (BYO key, DOM context only) → Smart Blur v2 (patterns + click-to-blur) → unlimited versions + comments → DOCX + `.stepdoc` bundle → Guide Me replay → branding kit → privacy-friendly view analytics → Firefox.

**Differentiators:** guide@1 replay contract + Playwright/SKILL.md/MCP exports for free; run anywhere (browser / PHP / Cloudflare / Node / Pages); publish-to-GitHub-Pages with llms.txt + JSON-LD + .md alternates; agent-operable app UI (a11y tree, data-sd hooks, WebMCP); enforced redaction + audit log in the open core; free unlimited viewers.

**Skip for now:** native desktop capture, process-mining "Optimize" analytics, sales-demo features (HTML capture, sandboxes), AI avatars/voice cloning, autonomous agent execution inside StepDoc.

## Architecture findings

- One static SPA + a small fixed REST contract; client does all image flattening, redaction compositing and PDF (print CSS; pdf-lib optional) — required because free Cloudflare Workers have a 10 ms CPU limit and shared hosts often lack Imagick/headless Chrome. It also makes "the server never sees un-redacted pixels" provable.
- Cloudflare free tier: 100k requests/day; D1 5M rows read + 100k written/day, 5 GB; R2 10 GB, zero egress.
- Chrome throttles `captureVisibleTab` (~2/s) — keep v1's queue. Firefox MV3 uses event pages + gecko id + AMO signing; build with WXT or per-target manifests. Safari needs a macOS build + container app and lacks side panel/offscreen — defer, design the popup fallback.
- Pairing: one-use 6–8 char code (5 min TTL) → scoped, revocable token; CORS only for registered extension IDs.

## Agent-readability findings

- Browser agents (Playwright MCP and similar) work from accessibility snapshots, not screenshots; canvas without ARIA fallbacks is invisible. ARIA quality *is* the agent interface.
- WebMCP shipped as an early Chrome preview (Feb 2026); the API moved to `document.modelContext` in the W3C draft and Chrome removed `navigator.modelContext` in August. Treat as progressive enhancement behind feature detection.
- llms.txt is fetched by coding agents but barely by crawlers (Ahrefs, Jun 2026: 97% of sites with one got zero requests in May). Keep it small (<10k tokens).
- Mimik's changelog shows how brittle element matching is — store multiple locators, prefer role + name, keep an expected result per step.

## Unverified / follow-ups

ScreenSteps, StepShot, Navattic, Floik, Clueso, Whatfix, WalkMe, Userlane pricing; how Excalidraw/Umami/Docmost/BookStack package multi-target hosting; PHP WebAuthn library choice (lbuchs/WebAuthn is a single-folder option to evaluate). Vendor claims (Scribe agent benchmark, Mimik user counts) are self-reported.

## Sources

- https://scribe.com/pricing · https://support.scribehow.com/hc/en-us/articles/35221245251485-Scribe-MCP-Server · https://scribe.launchnotes.io/ · https://scribe.com/library/100-million-arr-press-release
- https://www.tango.ai/blog/ai-workflow-documentation-tools · https://help.tango.ai/en/articles/11056403-how-does-tango-s-ai-agent-work
- https://github.com/westpoint-io/mimik · https://github.com/btahir/showsteps
- https://playwright.dev/mcp/snapshots · https://w3c-cg.github.io/aikr/webMCP/webmcp-technical-notes.html
- https://developers.cloudflare.com/workers/platform/pricing/
- https://www.citeflow.io/blog/llms-txt-worth-it-2026 · https://agentexperience.tech/insights/state-of-llms-txt/
- Pricing aggregators used for cross-checks: supered.io, bingeable.ai, trainn.co, sopx.io, dubble.so, howdygo.com, arcade.software

import type { GuideInput } from '@stepdoc/schema'
import tokens from '../../../../docs/v2/design-tokens.json'
import {
  escapeHtml as html,
  expectationText,
  GuideExportError,
  imageAlt,
  json,
  prepareExport,
  targetText,
  valueText,
  type ExportOptions,
} from './common'
import { howTo } from './json-ld'
import { metadata } from './markdown'

export interface HtmlExportOptions extends ExportOptions {
  theme?: 'light' | 'dark'
}

const styles = `:root{${Object.values(tokens.color)
  .map((token) => `${token.css}:${token.light}`)
  .join(';')};${Object.entries(tokens.space)
  .map(([name, size]) => `--sd-space-${name}:${size}px`)
  .join(';')};${Object.entries(tokens.type)
  .map(
    ([name, style]) =>
      `--sd-type-${name}:${style.weight} ${style.size}px/${style.line}px var(--sd-font-${style.family})`,
  )
  .join(
    ';',
  )};--sd-font-sans:${tokens.font.sans};--sd-font-mono:${tokens.font.mono}}
[data-theme="dark"]{${Object.values(tokens.color)
  .map((token) => `${token.css}:${token.dark}`)
  .join(';')}}
*{box-sizing:border-box}body{margin:0;background:var(--sd-bg-canvas);color:var(--sd-text-primary);font:var(--sd-type-body-l)}
body>header,nav,main,body>footer{padding:var(--sd-space-4) max(var(--sd-space-4),calc((100% - var(--sd-space-24)*9)/2))}body>header,nav{background:var(--sd-bg-raised)}
nav{display:flex;flex-wrap:wrap;gap:var(--sd-space-4)}a{color:var(--sd-accent-text)}a:focus-visible{outline:1px solid var(--sd-accent-solid);outline-offset:2px}
main{background:var(--sd-bg-surface)}h1{font:var(--sd-type-heading-l)}h2{font:var(--sd-type-heading-m)}p,li{overflow-wrap:anywhere}
.metadata,figcaption{color:var(--sd-text-secondary);font:var(--sd-type-body-s)}aside{padding:var(--sd-space-4);background:var(--sd-bg-raised)}
ol{padding-left:var(--sd-space-6)}ol>li{padding-block:var(--sd-space-6);break-inside:avoid}figure{margin:var(--sd-space-6) 0}img{display:block;max-width:100%;height:auto}
dt{font:var(--sd-type-label-m)}dd{margin:0 0 var(--sd-space-4)}footer{color:var(--sd-text-secondary)}@media print{nav{display:none}body,main{background:var(--sd-bg-surface)}img{max-height:80vh;object-fit:contain}}
`

/** Portable document markup; the published-site shell and view tabs belong to publish. */
export function exportHtml(
  input: GuideInput,
  options: HtmlExportOptions = {},
): string {
  const context = prepareExport(input, options)
  if (
    options.theme !== undefined &&
    options.theme !== 'light' &&
    options.theme !== 'dark'
  )
    throw new GuideExportError('invalid_options')
  const { guide } = context
  const sections = guide.steps
    .map(
      (step) => `<li id="step-${step.index}" data-sd-step="${step.index}">
<h2>${html(step.title)}</h2><p>${html(step.description || step.title)}</p>
${step.url ? `<p>Page: <a href="${html(step.url)}" rel="noreferrer">${html(step.url)}</a></p>` : ''}
${step.target ? `<p>Target: ${html(targetText(step))}</p>` : ''}
${step.action ? `<p>Action: ${step.action}</p>` : ''}
${valueText(step) ? `<p>Value: ${html(valueText(step)!)}</p>` : ''}
${expectationText(step)
  .map((text) => `<p>Expected: ${html(text)}</p>`)
  .join('\n')}
${step.screenshot ? `<figure><img src="${html(step.screenshot.rendered)}" alt="${html(imageAlt(step))}" width="${step.screenshot.width}" height="${step.screenshot.height}"><figcaption>${html(imageAlt(step))}</figcaption></figure>` : ''}
${step.notes ? `<p>Note: ${html(step.notes)}</p>` : ''}
</li>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="${html(guide.locale)}" data-theme="${options.theme === 'dark' ? 'dark' : 'light'}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="StepDoc"><meta name="description" content="${html(guide.description)}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${html(guide.title)}</title>
${context.canonicalUrl ? `<link rel="canonical" href="${html(context.canonicalUrl)}">` : ''}
<link rel="alternate" type="application/json" href="guide.json"><link rel="alternate" type="text/markdown" href="guide.md">
<style>${styles}</style><script type="application/ld+json">${json(howTo(context))}</script></head>
<body><header><a href="#guide">StepDoc guide</a></header>
<nav aria-label="Guide formats"><a data-sd="export-json" href="guide.json">JSON</a><a data-sd="export-markdown" href="guide.md">Markdown</a><a data-sd="export-playwright" href="replay.spec.ts">Playwright</a><a data-sd="export-skill" href="SKILL.md">Agent skill</a></nav>
<main id="guide"><article><header><h1>${html(guide.title)}</h1><p>${html(guide.description)}</p><p class="metadata">${html(metadata(guide))}</p></header>
<aside aria-label="Requirements"><h2>Preconditions</h2><ul>${(guide.preconditions.length ? guide.preconditions : ['None specified.']).map((item) => `<li>${html(item)}</li>`).join('')}</ul>
${guide.variables.length ? `<h2>Variables</h2><dl>${guide.variables.map((variable) => `<dt>${html(variable.name)} (${variable.kind})</dt><dd>${html(variable.description || variable.type)}</dd>`).join('')}</dl>` : ''}</aside>
<ol>${sections}</ol></article></main><footer>Created with StepDoc · ${html(guide.schema)}</footer></body></html>
`
}

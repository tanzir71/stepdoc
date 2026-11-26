/* global console */
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { websiteFiles } from './generate-website.mjs'

const read = (file) => readFile(new URL('../' + file, import.meta.url), 'utf8')
const normalize = (text) => text.replaceAll('\r\n', '\n')
assert(
  (await stat(new URL('../.nojekyll', import.meta.url))).isFile(),
  'Pages must serve Markdown/skill companions without Jekyll transformation',
)
for (const [file, expected] of await websiteFiles())
  assert.equal(
    normalize(await read(file)),
    normalize(expected),
    `Generated drift: ${file}; run pnpm website:build`,
  )
const files = [
  'styles.css',
  'main.js',
  'docs/index.html',
  'og.png',
  'llms.txt',
  'fonts/GeistSans.woff2',
  'fonts/GeistMono.woff2',
  'fonts/OFL.txt',
]
for (const file of files)
  assert(
    (await stat(new URL('../site/' + file, import.meta.url))).size > 0,
    `Nonempty ${file}`,
  )
const entry = await read('index.html')
assert(
  /<h1\b/.test(entry) &&
    entry.includes('href="./site/ui/tokens.css?v=') &&
    !entry.includes('http-equiv="refresh"'),
  'Native project-root landing without redirect',
)
const home = await read('site/index.html')
for (const file of ['site/index.html', 'site/docs/index.html']) {
  const html = await read(file)
  for (const token of [
    '<!doctype html',
    '<title',
    'name="description"',
    '<header',
    '<main',
    '<footer',
  ])
    assert(
      html.toLowerCase().includes(token.toLowerCase()),
      `${file}: ${token}`,
    )
  assert(!html.includes('\ufffd'), `UTF-8 ${file}`)
  assert(
    !/(?:href|src)=["']\/(?!\/)/.test(html),
    `Project-relative paths ${file}`,
  )
  assert(!html.includes('/blob/master/'), `Current branch ${file}`)
}
const manifest = JSON.parse(await read('site/assets/provenance.json'))
assert.equal(manifest.figma, 'lTCFRrrKJb415s0nSxKE3B')
for (const asset of manifest.assets) {
  assert(
    asset.unusedVariant || home.includes(`data-asset="${asset.file}"`),
    `Original asset callsite ${asset.file}`,
  )
  const bytes = await readFile(
    new URL('../site/assets/' + asset.file, import.meta.url),
  )
  assert(
    bytes.length > 0 && asset.nodes.length > 0,
    `Original asset provenance ${asset.file}`,
  )
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    asset.sha256,
    `Original asset bytes ${asset.file}`,
  )
  if (asset.file.endsWith('.svg')) {
    const root = bytes.toString().match(/<svg\b[^>]*>/)?.[0]
    assert(root, `SVG root ${asset.file}`)
    const dimension = (key) =>
      Number(root.match(new RegExp(`\\b${key}="([\\d.]+)(?:px)?"`))?.[1])
    assert.equal(
      dimension('width'),
      asset.width,
      `Original width ${asset.file}`,
    )
    assert.equal(
      dimension('height'),
      asset.height,
      `Original height ${asset.file}`,
    )
  }
}
for (const [local, shared] of [
  ['GeistSans.woff2', 'GeistSans.woff2'],
  ['GeistMono.woff2', 'GeistMono.woff2'],
  ['OFL.txt', 'OFL.txt'],
])
  assert.deepEqual(
    await readFile(new URL('../site/fonts/' + local, import.meta.url)),
    await readFile(
      new URL('../packages/ui/assets/fonts/' + shared, import.meta.url),
    ),
    `Shared font/licence ${local}`,
  )
const css = await read('site/styles.css')
assert(!/@import\b|https?:\/\//.test(css), 'No external styles/fonts')
assert(!/#[\da-f]{3,8}\b/i.test(css), 'Token-only landing colours')
const demo = await read('site/demo/index.html')
assert.equal(
  (demo.match(/<img\b[^>]*src="data:image\/png;base64,/g) ?? []).length,
  3,
  'Real guide with three embedded original images',
)
assert(
  !/<script\b(?![^>]*type="application\/ld\+json")/i.test(demo),
  'Guide has only inert JSON-LD',
)
assert(
  demo.includes('name="generator" content="StepDoc"'),
  'Production core HTML exporter',
)
console.log(
  `Website static verification passed: generated/shared sources, ${manifest.assets.length} unchanged Figma assets, local fonts, project paths and production guide.`,
)

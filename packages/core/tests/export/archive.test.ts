import { describe, expect, it } from 'vitest'
import { unzipSync, zipSync } from 'fflate'
import { guideSchema } from '@stepdoc/schema'
import {
  ArchiveError,
  ARCHIVE_LIMITS,
  BUNDLE_FORMAT,
  exportBundle,
  importBundle,
  readZip,
  rasterInfo,
  sha256,
  zipFiles,
  type GuideAssets,
} from '../../src/export/archive'
import { exportMarkdownZip } from '../../src/export/markdown-zip'
import { exportDocx } from '../../src/export/docx'
import { exportHtml } from '../../src/export/html'

const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6p2sAAAAASUVORK5CYII=',
    'base64',
  ),
)
const fixture = () =>
  guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id: 'portable-guide',
    title: 'Configure billing',
    description: 'Choose a plan.',
    app: {
      origin: 'https://owner:synthetic@example.com?key=synthetic#private',
    },
    variables: [{ name: 'invoice_email', kind: 'secret' }],
    steps: [
      {
        id: 'email-step',
        index: 1,
        type: 'action',
        action: 'fill',
        title: 'Fill the invoice email field',
        description: 'Use your billing address.',
        url: 'https://owner:synthetic@example.com/billing?token=synthetic#private',
        target: { role: 'textbox', name: 'Invoice email' },
        value: { kind: 'secret', variable: 'invoice_email' },
        screenshot: {
          original: 'native/original-key',
          rendered: 'native/rendered-key',
          width: 1,
          height: 1,
          alt: 'The invoice email field',
        },
        edits: {
          annotations: [{ type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }],
        },
        redactions: [
          {
            kind: 'email',
            source: 'manual',
            rect: { x: 0, y: 0, width: 1, height: 1 },
            status: 'applied',
          },
        ],
      },
    ],
    version: 12,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T12:00:00Z',
  })
const assets: GuideAssets = {
  'email-step': {
    original: { data: png, mime: 'image/png' },
    rendered: { data: png, mime: 'image/png' },
  },
}
const enc = new TextEncoder(),
  dec = new TextDecoder()
function sizeLie(bytes: Uint8Array, size: number) {
  const copy = new Uint8Array(bytes),
    v = new DataView(copy.buffer)
  let at = 0
  while (v.getUint32(at, true) !== 0x02014b50) at++
  const local = v.getUint32(at + 42, true)
  v.setUint32(at + 24, size, true)
  v.setUint32(local + 22, size, true)
  return copy
}

describe('portable stepdoc bundle', () => {
  it('round trips edits, runtime references and safe source/rendered bytes without native keys or URL credentials', async () => {
    const guide = fixture(),
      before = structuredClone(guide)
    const bytes = await exportBundle(guide, assets)
    const files = readZip(bytes)
    expect(JSON.parse(dec.decode(files['manifest.json']))).toMatchObject({
      format: BUNDLE_FORMAT,
    })
    expect(Object.keys(files).sort()).toEqual([
      'guide.json',
      'img/step-1-original.png',
      'img/step-1.png',
      'manifest.json',
    ])
    const result = await importBundle(bytes)
    expect(result.guide.steps[0]).toMatchObject({
      value: { kind: 'secret', variable: 'invoice_email' },
      edits: guide.steps[0]!.edits,
      redactions: guide.steps[0]!.redactions,
    })
    expect(result.assets['email-step']!.original!.data).toEqual(png)
    expect(result.assets['email-step']!.rendered.data).toEqual(png)
    expect(result.guide.app!.origin).toBe('https://example.com/')
    expect(result.guide.steps[0]!.url).toBe('https://example.com/billing')
    const json = dec.decode(files['guide.json'])
    for (const forbidden of ['synthetic', 'native/', 'token=', '#private'])
      expect(json).not.toContain(forbidden)
    expect(guide).toEqual(before)
  })
  it('accepts DEFLATE bundles as well as stored bundles', async () => {
    const files = readZip(await exportBundle(fixture(), assets))
    const result = await importBundle(zipSync(files, { level: 6 }))
    expect(result.guide.id).toBe('portable-guide')
  })
  it('handles text-only guides and rendered-only imported screenshots', async () => {
    const guide = fixture()
    delete guide.steps[0]!.screenshot
    expect(Object.keys(readZip(await exportBundle(guide, {})))).toHaveLength(2)
    const withoutOriginal = fixture()
    withoutOriginal.steps[0]!.screenshot!.original = null
    const result = await importBundle(
      await exportBundle(withoutOriginal, {
        'email-step': { rendered: assets['email-step']!.rendered },
      }),
    )
    expect(result.guide.steps[0]!.screenshot!.original).toBeNull()
  })
  it('rejects missing sources, renders and dimension mismatches instead of producing broken bundles', async () => {
    await expect(exportBundle(fixture(), {})).rejects.toMatchObject({
      code: 'missing_image',
    })
    await expect(
      exportBundle(fixture(), {
        'email-step': { rendered: assets['email-step']!.rendered },
      }),
    ).rejects.toMatchObject({ code: 'missing_image' })
    const guide = fixture()
    guide.steps[0]!.screenshot!.width = 2
    await expect(exportBundle(guide, assets)).rejects.toMatchObject({
      code: 'invalid_image',
    })
  })
  it('verifies hashes, rejects unknown formats/files and rejects forbidden captured literals', async () => {
    const original = readZip(await exportBundle(fixture(), assets))
    const changed = { ...original, 'guide.json': enc.encode('{}') }
    await expect(importBundle(zipSync(changed))).rejects.toBeInstanceOf(
      ArchiveError,
    )
    const manifest = JSON.parse(dec.decode(original['manifest.json']))
    manifest.format = 'stepdoc/bundle@99'
    await expect(
      importBundle(
        zipSync({
          ...original,
          'manifest.json': enc.encode(JSON.stringify(manifest)),
        }),
      ),
    ).rejects.toBeInstanceOf(ArchiveError)
    await expect(
      importBundle(zipSync({ ...original, 'img/step-2.png': png })),
    ).rejects.toBeInstanceOf(ArchiveError)
    const bad = fixture() as unknown as { steps: { value: unknown }[] }
    bad.steps[0]!.value = {
      kind: 'literal',
      literal: 'sensitive-synthetic-input',
    }
    await expect(
      exportBundle(bad as ReturnType<typeof fixture>, assets),
    ).rejects.toThrow('invalid_guide')
    const badJson = enc.encode(JSON.stringify(bad))
    const validManifest = JSON.parse(dec.decode(original['manifest.json']))
    validManifest.files['guide.json'] = await sha256(badJson)
    await expect(
      importBundle(
        zipSync({
          ...original,
          'guide.json': badJson,
          'manifest.json': enc.encode(JSON.stringify(validManifest)),
        }),
      ),
    ).rejects.toBeInstanceOf(ArchiveError)
  })
})
describe('bounded ZIP reader', () => {
  it('rejects inherited image entries and unsafe generated archive paths', async () => {
    const inherited: GuideAssets = Object.create(assets)
    await expect(exportBundle(fixture(), inherited)).rejects.toMatchObject({
      code: 'missing_image',
    })
    expect(() => zipFiles({ '../guide.json': enc.encode('test') })).toThrow(
      ArchiveError,
    )
  })
  for (const name of [
    '../guide.json',
    '/guide.json',
    'img/../guide.json',
    'img\\step-1.png',
    '__proto__',
    '.github/workflows/publish.yml',
    'img/step-1.svg',
  ]) {
    it(`rejects unsupported archive path ${name}`, () => {
      const bytes = zipSync({
        [name === '__proto__' ? 'forbidden' : name]: enc.encode('test'),
      })
      if (name === '__proto__') {
        const from = enc.encode('forbidden'),
          to = enc.encode(name)
        for (let at = 0; at <= bytes.length - from.length; at++)
          if (from.every((byte, i) => bytes[at + i] === byte)) bytes.set(to, at)
      }
      expect(() => readZip(bytes)).toThrow(ArchiveError)
    })
  }
  it('rejects ZIP64 sizes before allocation', () => {
    const zip = zipSync({ 'guide.json': enc.encode('test') })
    expect(() => readZip(sizeLie(zip, 0xffffffff))).toThrow('archive_limit')
  })
  it('bounds actual inflated output even when both size headers lie', () => {
    const zip = zipSync(
      { 'guide.json': new Uint8Array(5 * 1024 * 1024).fill(65) },
      { level: 6 },
    )
    expect(() => readZip(sizeLie(zip, 1))).toThrow('archive_limit')
  })
  it('checks CRC, truncation, duplicate directory names and declared metadata limits', () => {
    const zip = zipSync({ 'guide.json': enc.encode('test') }, { level: 0 })
    const damaged = new Uint8Array(zip)
    damaged[40] = damaged[40]! ^ 1
    expect(() => readZip(damaged)).toThrow(ArchiveError)
    expect(() => readZip(zip.subarray(0, zip.length - 1))).toThrow(ArchiveError)
    // A real signature just outside the comment search window is not a found EOCD.
    const trailing = new Uint8Array(zip.length + 65536)
    trailing.set(zip)
    expect(() => readZip(trailing)).toThrow(ArchiveError)
    expect(() => readZip(sizeLie(zip, ARCHIVE_LIMITS.metadata + 1))).toThrow(
      'archive_limit',
    )
    const duplicate = zipSync(
      { 'guide.json': enc.encode('test'), 'other.json': enc.encode('test') },
      { level: 0 },
    )
    // Equal-length names at both local/central headers become the same path.
    const target = enc.encode('other.json'),
      source = enc.encode('guide.json')
    for (let at = 0; at <= duplicate.length - target.length; at++)
      if (target.every((byte, index) => duplicate[at + index] === byte))
        duplicate.set(source, at)
    expect(() => readZip(duplicate)).toThrow(ArchiveError)
  })
  it('rejects unsupported raster formats and allocation-sized dimensions', () => {
    expect(() =>
      rasterInfo({ data: enc.encode('<svg/>'), mime: 'image/png' }),
    ).toThrow('invalid_image')
    const large = new Uint8Array(png)
    new DataView(large.buffer).setUint32(16, 32768)
    expect(() => rasterInfo({ data: large, mime: 'image/png' })).toThrow(
      'invalid_image',
    )
  })
})
describe('client document formats', () => {
  it('packages Markdown with real matching images and omits source pixels', () => {
    const files = unzipSync(exportMarkdownZip(fixture(), assets))
    expect(Object.keys(files).sort()).toEqual(['guide.md', 'img/step-1.png'])
    expect(dec.decode(files['guide.md'])).toContain('img/step-1.png')
    expect(dec.decode(files['guide.md'])).not.toContain('synthetic')
  })
  it('writes editable semantic Word headings, escaped text, accessible PNGs and authored dates', async () => {
    const guide = fixture()
    guide.title = 'Billing <plan> & setup'
    guide.steps[0]!.notes = 'Line one\nLine two\u0000'
    const files = unzipSync(await exportDocx(guide, assets))
    const xml = dec.decode(files['word/document.xml'])
    expect(xml).toContain('w:val="Title"')
    expect(xml).toContain('w:val="Heading1"')
    expect(xml).toContain('Billing &lt;plan&gt; &amp; setup')
    expect(xml).toContain('descr="The invoice email field"')
    expect(xml).toContain('w:br')
    expect(xml).not.toContain('\u0000')
    expect(xml).not.toContain('synthetic')
    const paragraphs = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g)!
    const heading = paragraphs.findIndex(
      (p) =>
        p.includes('w:val="Heading1"') &&
        p.includes('Fill the invoice email field'),
    )
    expect(heading).toBeGreaterThan(-1)
    for (const p of paragraphs.slice(heading, -1))
      expect(p).toContain('<w:keepNext/>')
    expect(paragraphs.at(-1)).toContain('<w:keepNext w:val="false"/>')
    expect(
      Object.keys(files).filter((name) => name.startsWith('word/media/')),
    ).toHaveLength(1)
    const props = dec.decode(files['docProps/core.xml'])
    expect(props).toContain('2026-11-25T12:00:00Z')
    expect(props).toContain('<dc:creator>StepDoc</dc:creator>')
    expect(dec.decode(files['word/styles.xml'])).not.toContain('w:val="italic"')
  })
  it('embeds only valid local fonts and adds print page/block rules without altering default HTML', () => {
    const options = {
      sans: 'data:font/woff2;base64,YQ==',
      mono: 'data:font/woff2;base64,Yg==',
    }
    const html = exportHtml(fixture(), { fonts: options, print: true })
    expect(html).toContain('@page{size:A4;margin:16mm}')
    expect(html).toContain('font-src data:;')
    expect(html).toContain('@font-face')
    const standalone = exportHtml(fixture(), { standalone: true })
    expect(standalone).not.toContain('aria-label="Guide formats"')
    expect(standalone).not.toContain('rel="alternate"')
    expect(() =>
      exportHtml(fixture(), {
        fonts: { ...options, sans: 'https://external.example/font.woff2' },
      }),
    ).toThrow('invalid_options')
  })
})

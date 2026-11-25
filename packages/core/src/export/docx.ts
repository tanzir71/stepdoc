import {
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  TextRun,
  type IParagraphOptions,
} from 'docx'
import { unzipSync } from 'fflate'
import type { GuideInput } from '@stepdoc/schema'
import tokens from '../../../../docs/v2/design-tokens.json'
import {
  escapeHtml,
  expectationText,
  imageAlt,
  targetText,
  valueText,
} from './common'
import { metadata } from './markdown'
import {
  ArchiveError,
  portableAssets,
  zipFiles,
  type GuideAssets,
} from './archive'

const text = (value: string) =>
  Array.from(
    value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, ''),
    (char) => {
      const n = char.codePointAt(0)!
      return n >= 0xd800 && n <= 0xdfff ? '\ufffd' : char
    },
  ).join('')
function paragraphOptions(
  value: string,
  options: IParagraphOptions = {},
): IParagraphOptions {
  return {
    ...options,
    children: text(value)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(
        (line, index) =>
          new TextRun({ text: line, ...(index ? { break: 1 } : {}) }),
      ),
  }
}
function paragraph(value: string, options: IParagraphOptions = {}) {
  return new Paragraph(paragraphOptions(value, options))
}

/** Editable Word document. Receives only client-flattened PNGs; never decodes images. */
export async function exportDocx(
  input: GuideInput,
  assets: GuideAssets,
): Promise<Uint8Array> {
  const { guide } = portableAssets(input, assets)
  const children: Paragraph[] = [
    paragraph(guide.title, { heading: HeadingLevel.TITLE }),
  ]
  if (guide.description) children.push(paragraph(guide.description))
  children.push(paragraph(metadata(guide), { style: 'Metadata' }))
  if (guide.preconditions.length) {
    children.push(
      paragraph('Before you begin', { heading: HeadingLevel.HEADING_1 }),
    )
    children.push(
      ...guide.preconditions.map((item) =>
        paragraph(item, { bullet: { level: 0 } }),
      ),
    )
  }
  if (guide.variables.length) {
    children.push(
      paragraph('Runtime inputs', { heading: HeadingLevel.HEADING_1 }),
    )
    children.push(
      ...guide.variables.map((variable) =>
        paragraph(
          `${variable.name} (${variable.kind}, ${variable.type})${variable.description ? ` - ${variable.description}` : ''}`,
        ),
      ),
    )
  }
  for (const step of guide.steps) {
    const block: IParagraphOptions[] = []
    block.push(
      paragraphOptions(`${step.index}  ${step.title}`, {
        heading: HeadingLevel.HEADING_1,
      }),
    )
    if (step.description) block.push(paragraphOptions(step.description))
    if (step.url)
      block.push(paragraphOptions(`Page: ${step.url}`, { style: 'Metadata' }))
    if (step.target)
      block.push(
        paragraphOptions(`Target: ${targetText(step)}`, { style: 'Metadata' }),
      )
    if (valueText(step))
      block.push(
        paragraphOptions(`Input: ${valueText(step)!}`, { style: 'Metadata' }),
      )
    block.push(
      ...expectationText(step).map((value) =>
        paragraphOptions(`Expected: ${value}`, { style: 'Metadata' }),
      ),
    )
    if (step.screenshot) {
      const asset = assets[step.id]!.rendered
      if (asset.mime !== 'image/png') throw new ArchiveError('invalid_image')
      const scale = Math.min(
        1,
        642 / step.screenshot.width,
        620 / step.screenshot.height,
      )
      block.push({
        keepNext: true,
        children: [
          new ImageRun({
            type: 'png',
            data: new Uint8Array(asset.data),
            transformation: {
              width: Math.round(step.screenshot.width * scale),
              height: Math.round(step.screenshot.height * scale),
            },
            altText: {
              name: `Step ${step.index}`,
              title: text(step.title),
              description: text(imageAlt(step)),
            },
          }),
        ],
      })
      block.push(paragraphOptions(imageAlt(step), { style: 'Caption' }))
    }
    if (step.notes) block.push(paragraphOptions(`Note: ${step.notes}`))
    children.push(
      ...block.map(
        (options, index) =>
          new Paragraph({
            ...options,
            keepNext: index < block.length - 1 || step.type === 'section',
          }),
      ),
    )
  }
  const muted = tokens.color['text/secondary'].light.replace('#', '')
  const document = new Document({
    title: text(guide.title),
    creator: 'StepDoc',
    lastModifiedBy: 'StepDoc',
    revision: guide.version,
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 22, color: '000000' },
          paragraph: { spacing: { after: 120, line: 276 } },
        },
        title: {
          run: { font: 'Arial', size: 44, bold: true, color: '000000' },
          paragraph: { spacing: { after: 180 }, keepNext: true },
        },
        heading1: {
          run: { font: 'Arial', size: 28, bold: true, color: '000000' },
          paragraph: { spacing: { before: 300, after: 120 }, keepNext: true },
        },
        caption: {
          run: { font: 'Arial', size: 18, italics: false, color: muted },
          paragraph: { spacing: { after: 180 } },
        },
      },
      paragraphStyles: [
        {
          id: 'Metadata',
          name: 'Metadata',
          basedOn: 'Normal',
          run: { size: 18, color: muted },
          paragraph: { spacing: { after: 100 } },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 },
          },
        },
        children,
      },
    ],
  })
  // Only unpack our just-generated, trusted OOXML. Untrusted bundles use readZip's bounded parser.
  const files = unzipSync(new Uint8Array(await Packer.toArrayBuffer(document)))
  // Library defaults include wall-clock creation times. Retain only authored guide dates.
  files['docProps/core.xml'] = new TextEncoder().encode(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeHtml(text(guide.title))}</dc:title><dc:creator>StepDoc</dc:creator><cp:lastModifiedBy>StepDoc</cp:lastModifiedBy><cp:revision>${guide.version}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${guide.createdAt}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${guide.updatedAt}</dcterms:modified></cp:coreProperties>`,
  )
  return zipFiles(files)
}

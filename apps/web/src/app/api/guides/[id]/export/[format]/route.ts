import JSZip from 'jszip'
import { chromium } from 'playwright'
import { getGuide } from '@/lib/db'
import { renderStandaloneHtml } from '@/lib/html-export'
import { apiError, exportFormatSchema, parseUuid } from '@/lib/http'

async function dataUrl(url: string) {
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer())
  return `data:image/webp;base64,${bytes.toString('base64')}`
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string; format: string }> }) {
  try {
    const { id: rawId, format: rawFormat } = await params
    const id = parseUuid(rawId)
    const format = exportFormatSchema.parse(rawFormat)
    const guide = await getGuide(id)
    if (!guide) return new Response('Not found', { status: 404 })
    if (format === 'pdf') {
      const browser = await chromium.launch({ headless: true })
      try {
        const page = await browser.newPage()
        const base = process.env.NEXT_PUBLIC_APP_URL ?? 'http://127.0.0.1:3000'
        await page.goto(`${base}/guides/${id}`, { waitUntil: 'networkidle' })
        await page.emulateMedia({ media: 'print' })
        const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' } })
        return new Response(pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer, { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${slug(guide.title)}.pdf"` } })
      } finally { await browser.close() }
    }
    if (format === 'html') {
      const steps = await Promise.all(guide.steps.map(async (step) => ({ text: step.text, imageDataUrl: step.imageUrl ? await dataUrl(step.imageUrl) : null })))
      return new Response(renderStandaloneHtml({ title: guide.title, description: guide.description, sourceUrl: guide.source_url, steps }), { headers: { 'content-type': 'text/html', 'content-disposition': `attachment; filename="${slug(guide.title)}.html"` } })
    }
    const zip = new JSZip()
    const lines = [`# ${guide.title}`, guide.description]
    for (const [index, step] of guide.steps.entries()) {
      lines.push(`## ${index + 1}. ${step.text}`)
      if (step.imageUrl) {
        const bytes = await (await fetch(step.imageUrl)).arrayBuffer()
        zip.file(`images/step-${index + 1}.webp`, bytes)
        lines.push(`![${step.text}](images/step-${index + 1}.webp)`)
      }
    }
    zip.file(`${slug(guide.title)}.md`, lines.join('\n\n'))
    const bytes = await zip.generateAsync({ type: 'uint8array' })
    return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${slug(guide.title)}.zip"` } })
  } catch (error) { return apiError(error) }
}

function slug(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'guide' }

import { mkdir, writeFile } from 'node:fs/promises'
import { renderStandaloneHtml } from '../apps/web/src/lib/html-export.ts'

const svg = (title: string, subtitle: string, screen: string, accent = '#2563eb') => {
  const markup = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="720" viewBox="0 0 1200 720"><rect width="1200" height="720" rx="18" fill="#e9eef6"/><rect x="34" y="34" width="1132" height="652" rx="14" fill="#fff" stroke="#cbd5e1"/><rect x="34" y="34" width="1132" height="52" rx="14" fill="#172033"/><circle cx="66" cy="60" r="7" fill="#fb7185"/><circle cx="90" cy="60" r="7" fill="#fbbf24"/><circle cx="114" cy="60" r="7" fill="#34d399"/><rect x="455" y="49" width="290" height="22" rx="11" fill="#2d3a4f"/><text x="600" y="64" fill="#cbd5e1" font-family="monospace" font-size="10" text-anchor="middle">internal.example/${screen}</text><text x="78" y="145" fill="#64748b" font-family="monospace" font-size="12">STEPDOC DEMO WORKSPACE</text><text x="78" y="205" fill="#172033" font-family="Arial,sans-serif" font-weight="700" font-size="42">${title}</text><text x="78" y="244" fill="#64748b" font-family="Arial,sans-serif" font-size="20">${subtitle}</text><rect x="78" y="292" width="1044" height="1" fill="#dbe2ec"/><rect x="78" y="330" width="330" height="250" rx="12" fill="#f4f7fb" stroke="#dbe2ec"/><rect x="445" y="330" width="677" height="58" rx="9" fill="#f8fafc" stroke="#dbe2ec"/><rect x="445" y="412" width="677" height="58" rx="9" fill="#f8fafc" stroke="#dbe2ec"/><rect x="445" y="494" width="430" height="58" rx="9" fill="#f8fafc" stroke="#dbe2ec"/><rect x="920" y="494" width="202" height="58" rx="9" fill="${accent}"/><text x="1021" y="530" fill="#fff" font-family="Arial,sans-serif" font-weight="700" font-size="16" text-anchor="middle">${screen === 'share' ? 'Copy public link' : 'Continue'}</text><circle cx="1018" cy="523" r="30" fill="none" stroke="#ef4444" stroke-width="5"/><circle cx="1018" cy="523" r="7" fill="#ef4444"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(markup).toString('base64')}`
}

const html = renderStandaloneHtml({
  title: 'Share an internal guide without exposing your workspace',
  description: 'Capture a short browser workflow, review privacy-sensitive regions, and publish only the read-only guide. This sample uses invented screens and contains no private data.',
  sourceUrl: 'internal.example (synthetic)',
  steps: [
    { text: 'Open the StepDoc extension and click “Start capture”', imageDataUrl: svg('Start a new capture', 'The extension records actions, never the values you type.', 'capture') },
    { text: 'Complete the workflow in the tab you want to document', imageDataUrl: svg('Work through the task', 'Clicks become steps; sensitive fields are pixelated before persistence.', 'workflow', '#1d4ed8') },
    { text: 'Click “Stop & open” when the workflow is complete', imageDataUrl: svg('Finish the capture', 'The session opens as an editable guide in your private StepDoc app.', 'finish') },
    { text: 'Review every screenshot and adjust redaction layers', imageDataUrl: svg('Review privacy first', 'Move click markers, add blur regions, and edit the generated instruction.', 'review', '#7c3aed') },
    { text: 'Enable the read-only link and copy its unguessable URL', imageDataUrl: svg('Publish only the guide', 'The editor stays private. Only /p/{publicId} is intended to be shared.', 'share', '#2563eb') },
  ],
})

await mkdir(new URL('../site/demo/', import.meta.url), { recursive: true })
await writeFile(new URL('../site/demo/index.html', import.meta.url), html)
console.log('Generated site/demo/index.html with the production StepDoc HTML export renderer.')

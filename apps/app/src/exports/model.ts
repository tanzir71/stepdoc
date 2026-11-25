export const formats = [
  { id: 'pdf', name: 'PDF', description: 'Print-ready, one step per block' },
  { id: 'html', name: 'HTML', description: 'Single file, images inlined' },
  { id: 'markdown', name: 'Markdown', description: '.md + images, zipped' },
  { id: 'docx', name: 'DOCX', description: 'Editable Word document' },
  { id: 'bundle', name: '.stepdoc', description: 'Re-importable bundle' },
  {
    id: 'json',
    name: 'guide.json',
    description: 'Replay contract, schema v1',
    agent: true,
  },
  {
    id: 'playwright',
    name: 'Playwright',
    description: 'replay.spec.ts',
    agent: true,
  },
  {
    id: 'skill',
    name: 'SKILL.md',
    description: 'Agent skill folder',
    agent: true,
  },
] as const
export type ExportFormat = (typeof formats)[number]['id']
export function selectedFormats(search: string): ExportFormat[] {
  const raw = new URLSearchParams(search).get('formats')
  if (raw === null) return ['pdf', 'markdown', 'json']
  const requested = new Set(raw.split(','))
  return formats.map((format) => format.id).filter((id) => requested.has(id))
}
export function exportUrl(
  id: string,
  search: string,
  selected?: readonly ExportFormat[],
) {
  const query = new URLSearchParams(search)
  if (selected)
    query.set(
      'formats',
      formats
        .filter((format) => selected.includes(format.id))
        .map((format) => format.id)
        .join(','),
    )
  query.sort()
  return `/g/${id}/export${query.size ? `?${query}` : ''}`
}

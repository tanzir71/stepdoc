import {
  WORKSPACE_FORMAT,
  WORKSPACE_GUIDE_LIMIT,
  workspaceManifestSchema,
} from '@stepdoc/schema/workspace'
import {
  ARCHIVE_LIMITS,
  ArchiveError,
  importBundle,
  readZip,
  sha256,
  zipFiles,
} from './archive'

export async function exportWorkspace(bundles: readonly Uint8Array[]) {
  if (bundles.length > WORKSPACE_GUIDE_LIMIT)
    throw new ArchiveError('archive_limit')
  const files: Record<string, Uint8Array> = Object.create(null)
  const entries = []
  for (const [index, bytes] of bundles.entries()) {
    const path = `guides/${index + 1}.stepdoc`
    files[path] = bytes
    entries.push({ path, sha256: await sha256(bytes) })
  }
  files['manifest.json'] = new TextEncoder().encode(
    JSON.stringify({ format: WORKSPACE_FORMAT, files: entries }),
  )
  return zipFiles(files)
}

/** Validate the complete envelope and every nested bundle before any client writes. */
export async function importWorkspace(bytes: Uint8Array) {
  try {
    const files = readZip(bytes, 'workspace')
    const manifest = workspaceManifestSchema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          files['manifest.json'],
        ),
      ),
    )
    if (Object.keys(files).length !== manifest.files.length + 1)
      throw new ArchiveError('invalid_archive')
    const result: Awaited<ReturnType<typeof importBundle>>[] = []
    const ids = new Set<string>()
    let expanded = 0
    for (const [index, entry] of manifest.files.entries()) {
      if (
        entry.path !== `guides/${index + 1}.stepdoc` ||
        !files[entry.path] ||
        (await sha256(files[entry.path]!)) !== entry.sha256
      )
        throw new ArchiveError('invalid_archive')
      const bundle = await importBundle(files[entry.path]!)
      expanded += new TextEncoder().encode(JSON.stringify(bundle.guide)).length
      for (const asset of Object.values(bundle.assets))
        expanded +=
          asset.rendered.data.length + (asset.original?.data.length ?? 0)
      if (expanded > ARCHIVE_LIMITS.bytes)
        throw new ArchiveError('archive_limit')
      if (ids.has(bundle.guide.id)) throw new ArchiveError('invalid_archive')
      ids.add(bundle.guide.id)
      result.push(bundle)
    }
    return result
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError('invalid_archive')
  }
}

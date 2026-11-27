import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const workspace = fileURLToPath(
  new URL('../../../', import.meta.url),
)
const inputs = [
  'apps/app/src',
  'apps/app/public',
  'apps/app/index.html',
  'apps/app/vite.config.ts',
  'apps/app/package.json',
  'apps/extension/entrypoints',
  'apps/extension/src',
  'apps/extension/wxt.config.ts',
  'apps/extension/package.json',
  'apps/extension/scripts/runtime-source.mjs',
  'apps/extension/scripts/runtime-source.d.mts',
  'packages/core/src',
  'packages/core/package.json',
  'packages/schema/src',
  'packages/schema/migrations',
  'packages/schema/package.json',
  'packages/storage/src',
  'packages/storage/package.json',
  'packages/ui/src',
  'packages/ui/assets',
  'packages/ui/styles.css',
  'packages/ui/tokens.css',
  'packages/ui/package.json',
  'docs/v2/guide.schema.json',
  'docs/v2/design-tokens.json',
  'pnpm-lock.yaml',
]
export async function runtimeSource() {
  const files = []
  async function visit(relative) {
    const parent = dirname(relative)
    const name = relative.slice(parent === '.' ? 0 : parent.length + 1)
    const entries = await readdir(join(workspace, parent), {
      withFileTypes: true,
    })
    const entry = entries.find((item) => item.name === name)
    if (!entry || entry.isSymbolicLink())
      throw new Error('Missing or redirected extension build input')
    if (entry.isDirectory()) {
      for (const child of await readdir(join(workspace, relative)))
        await visit(relative + '/' + child)
    } else if (entry.isFile()) files.push(relative)
    else throw new Error('Unsupported extension build input')
  }
  for (const input of inputs) await visit(input)
  const hash = createHash('sha256')
  for (const path of files.sort()) {
    let bytes = await readFile(join(workspace, path))
    if (/\.(?:[cm]?[jt]sx?|json|css|html|ya?ml|md|sql)$/.test(path))
      bytes = Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'))
    hash.update(path + '\0' + bytes.length + '\0').update(bytes)
  }
  return hash.digest('hex')
}
export async function recordBuild(outDir, browser, expected) {
  if (basename(outDir) !== `${browser}-mv3`) return
  const sourceSha256 = await runtimeSource()
  if (!expected || sourceSha256 !== expected)
    throw new Error(
      'Extension source changed during compilation; rebuild it',
    )
  const { version } = JSON.parse(
    await readFile(join(workspace, 'apps/extension/package.json'), 'utf8'),
  )
  await mkdir(dirname(outDir), { recursive: true })
  await writeFile(
    join(dirname(outDir), `build-${browser}.json`),
    JSON.stringify({ browser, version, sourceSha256 }) + '\n',
  )
}

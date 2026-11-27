import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runtimeSource, workspace } from './runtime-source.mjs'

const require = createRequire(
  new URL('../../../packages/core/package.json', import.meta.url),
)
const { zipSync, unzipSync } = require('fflate')
const output = fileURLToPath(new URL('../.output/', import.meta.url))
export async function packageExtensions({ check = false } = {}) {
  const sourceSha256 = await runtimeSource()
  const { version } = JSON.parse(
    await readFile(join(workspace, 'apps/extension/package.json'), 'utf8'),
  )
  const metadata = {
    format: 'stepdoc/extension-distribution@1',
    version,
    sourceSha256,
    browsers: {},
  }
  const destination = join(workspace, 'site/downloads')
  if (!check) {
    await mkdir(destination, { recursive: true })
    await mkdir(join(workspace, 'dist'), { recursive: true })
  }
  for (const browser of ['chrome', 'edge', 'firefox']) {
    const provenance = JSON.parse(
      await readFile(join(output, `build-${browser}.json`), 'utf8'),
    )
    if (
      provenance.sourceSha256 !== sourceSha256 ||
      provenance.version !== version ||
      provenance.browser !== browser
    )
      throw new Error(`Rebuild the ${browser} extension before packaging`)
    const root = join(output, browser + '-mv3')
    const files = Object.create(null)
    async function collect(directory, prefix = '') {
      for (const entry of (
        await readdir(directory, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix + entry.name
        if (
          entry.isSymbolicLink() ||
          /(?:^|\/)(?:\.\.?|node_modules|\.env[^/]*)(?:\/|$)/.test(relative)
        )
          throw new Error('Unsafe extension distribution entry')
        if (entry.isDirectory())
          await collect(join(directory, entry.name), relative + '/')
        else {
          if (
            !entry.isFile() ||
            !/\.(?:js|css|html|json|svg|png|webp|woff2|txt)$/.test(relative)
          )
            throw new Error(
              'Uncompiled file entered the extension distribution',
            )
          files[relative] = [
            new Uint8Array(await readFile(join(directory, entry.name))),
            { mtime: new Date(1980, 0, 1) },
          ]
        }
      }
    }
    await collect(root)
    for (const [name, source] of [
      ['LICENSE.txt', 'LICENSE'],
      ['OFL.txt', 'packages/ui/assets/fonts/OFL.txt'],
    ])
      files[name] = [
        new Uint8Array(await readFile(join(workspace, source))),
        { mtime: new Date(1980, 0, 1) },
      ]
    const manifest = JSON.parse(
      new TextDecoder().decode(files['manifest.json']?.[0]),
    )
    if (
      manifest.manifest_version !== 3 ||
      manifest.version !== version ||
      !files['app.html'] ||
      !files['popup.html'] ||
      (browser !== 'firefox' && !files['sidepanel.html'])
    )
      throw new Error('Compiled extension is incomplete')
    const bytes = zipSync(files, { level: 9 })
    const file = `stepdoc-${browser}.zip`
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    metadata.browsers[browser] = {
      file,
      sha256,
      bytes: bytes.length,
      files: Object.keys(files).length,
      signed: false,
    }
    if (check) {
      const existing = await readFile(join(destination, file))
      if (!existing.equals(Buffer.from(bytes)))
        throw new Error(`Stale compiled ${browser} download`)
    } else {
      await writeFile(join(destination, file), bytes)
      await writeFile(join(workspace, 'dist', file), bytes)
    }
  }
  const json = JSON.stringify(metadata, null, 2) + '\n'
  if (check) {
    if (
      (await readFile(join(destination, 'extensions.json'), 'utf8')) !==
      json
    )
      throw new Error('Stale extension distribution metadata')
  } else await writeFile(join(destination, 'extensions.json'), json)
  return metadata
}
export async function verifyDistribution() {
  const metadata = JSON.parse(
    await readFile(
      join(workspace, 'site/downloads/extensions.json'),
      'utf8',
    ),
  )
  if (
    metadata.format !== 'stepdoc/extension-distribution@1' ||
    metadata.sourceSha256 !== (await runtimeSource())
  )
    throw new Error('Compiled extension downloads do not match the source')
  for (const browser of ['chrome', 'edge', 'firefox']) {
    const item = metadata.browsers[browser]
    if (!item || item.file !== `stepdoc-${browser}.zip`)
      throw new Error('Missing browser download')
    const bytes = await readFile(
      join(workspace, 'site/downloads', item.file),
    )
    if (
      bytes.length !== item.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== item.sha256
    )
      throw new Error('Compiled extension checksum mismatch')
    const files = unzipSync(bytes)
    for (const [name, source] of [
      ['LICENSE.txt', 'LICENSE'],
      ['OFL.txt', 'packages/ui/assets/fonts/OFL.txt'],
    ])
      if (
        !files[name] ||
        !Buffer.from(files[name]).equals(
          await readFile(join(workspace, source)),
        )
      )
        throw new Error('Compiled extension license missing or stale')
    if (
      Object.keys(files).length !== item.files ||
      Object.keys(files).some((name) =>
        /(?:^|\/)(?:\.\.?|node_modules|\.env[^/]*)(?:\/|$)|\.(?:tsx?|map)$/.test(
          name,
        ),
      )
    )
      throw new Error('Unsafe compiled extension download')
    const manifest = JSON.parse(
      new TextDecoder().decode(files['manifest.json']),
    )
    if (
      manifest.version !== metadata.version ||
      manifest.manifest_version !== 3 ||
      !files['app.html'] ||
      !files['popup.html']
    )
      throw new Error('Compiled extension manifest mismatch')
  }
  return metadata
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url)
    .replaceAll('\\', '/')
    .toLowerCase() === process.argv[1].replaceAll('\\', '/').toLowerCase()
) {
  const metadata = await packageExtensions({
    check: process.argv.includes('--check'),
  })
  console.log(
    `Compiled extension downloads ${process.argv.includes('--check') ? 'verified' : 'packaged'}: ${Object.keys(metadata.browsers).join(', ')}; version ${metadata.version}.`,
  )
}

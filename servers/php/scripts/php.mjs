import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const phpRoot = fileURLToPath(new URL('../', import.meta.url))
const workspace = resolve(phpRoot, '../..')
export function phpRuntime() {
  const info = JSON.parse(
    execFileSync(
      process.env.STEPDOC_PHP_BINARY || 'php',
      [
        '-r',
        'echo json_encode(["binary"=>PHP_BINARY,"extensions"=>get_loaded_extensions()]);',
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  )
  const args = []
  if (process.platform === 'win32') {
    const ext = join(dirname(info.binary), 'ext')
    args.push('-d', `extension_dir=${ext}`)
    for (const name of ['pdo_sqlite', 'openssl', 'curl', 'zip'])
      if (
        !info.extensions.includes(name) &&
        existsSync(join(ext, `php_${name}.dll`))
      )
        args.push('-d', `extension=${name}`)
  }
  // Leave developer/vendor paths out of HTTP errors even with a bare local php.ini.
  args.push(
    '-d',
    'display_errors=0',
    '-d',
    'upload_max_filesize=64M',
    '-d',
    'post_max_size=70M',
  )
  return { binary: info.binary, args }
}

export async function dependencies(runtime = phpRuntime()) {
  const lock = join(phpRoot, 'composer.lock')
  const installed = join(phpRoot, 'vendor/composer/installed.json')
  if (existsSync(installed)) {
    const wanted = JSON.parse(await readFile(lock, 'utf8')).packages
    const actual = JSON.parse(await readFile(installed, 'utf8')).packages
    if (
      wanted.length === actual.length &&
      wanted.every((pkg) =>
        actual.some(
          (item) =>
            item.name === pkg.name &&
            item.version === pkg.version &&
            item.source?.reference === pkg.source?.reference,
        ),
      )
    )
      return
  }
  const toolDir = join(workspace, 'test-results/tools')
  await mkdir(toolDir, { recursive: true })
  const phar = join(toolDir, 'composer-2.11.3.phar')
  const digest =
    '04f8b003da4e3a2459056591fbfebd02b4dc3e5adeb158616b90cf55a65113ec'
  if (!existsSync(phar)) {
    const response = await fetch(
      'https://getcomposer.org/download/2.11.3/composer.phar',
      { signal: AbortSignal.timeout(30000), redirect: 'error' },
    )
    if (!response.ok) throw new Error('Composer download failed')
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error('Composer checksum mismatch')
    await writeFile(phar, bytes)
  }
  if (
    createHash('sha256')
      .update(await readFile(phar))
      .digest('hex') !== digest
  )
    throw new Error('Composer checksum mismatch')
  const result = spawnSync(
    runtime.binary,
    [
      ...runtime.args,
      phar,
      'install',
      '--no-interaction',
      '--no-progress',
      '--no-ansi',
      '--no-plugins',
      '--no-scripts',
      '--prefer-dist',
      `--working-dir=${phpRoot}`,
    ],
    { stdio: 'inherit', windowsHide: true },
  )
  if (result.status !== 0) throw new Error('PHP dependencies could not install')
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const runtime = phpRuntime()
  await dependencies(runtime)
  if (process.argv[2] === 'lint') {
    const files = (await readdir(phpRoot, { recursive: true })).filter(
      (file) =>
        file.endsWith('.php') &&
        !file.replaceAll('\\', '/').startsWith('vendor/'),
    )
    for (const file of files)
      execFileSync(
        runtime.binary,
        [...runtime.args, '-l', join(phpRoot, file)],
        { stdio: 'pipe', windowsHide: true },
      )
    console.log(
      `PHP syntax verified: ${files.length} source files; locked dependencies present.`,
    )
  } else if (process.argv[2] !== 'install')
    throw new Error('Expected lint or install')
}

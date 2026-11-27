import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  chmod,
} from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dependencies, phpRoot, phpRuntime } from './php.mjs'

const workspace = resolve(phpRoot, '../..')
export async function buildPhp({
  output = join(workspace, 'dist'),
  buildApp = true,
} = {}) {
  const runtime = phpRuntime()
  await dependencies(runtime)
  if (buildApp) {
    const require = createRequire(
      new URL('../../../apps/app/package.json', import.meta.url),
    )
    const vite = join(
      dirname(require.resolve('vite/package.json')),
      'bin/vite.js',
    )
    const build = spawnSync(process.execPath, [vite, 'build'], {
      cwd: join(workspace, 'apps/app'),
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: 'inherit',
      windowsHide: true,
    })
    if (build.status !== 0) throw new Error('Static app build failed')
  }
  await mkdir(output, { recursive: true })
  const outputRoot = await realpath(output)
  const staging = await mkdtemp(join(outputRoot, '.stepdoc-build-'))
  const directory = join(staging, 'stepdoc')
  try {
    await mkdir(directory)
    for (const name of [
      'src',
      'migrations',
      'public',
      'vendor',
      'bin',
      'bootstrap.php',
      'router.php',
      'composer.json',
      'composer.lock',
    ])
      await cp(join(phpRoot, name), join(directory, name), {
        recursive: true,
        dereference: false,
      })
    await cp(join(workspace, 'apps/app/dist'), join(directory, 'app'), {
      recursive: true,
      dereference: false,
    })
    await mkdir(join(directory, 'schema'))
    await cp(
      join(workspace, 'docs/v2/guide.schema.json'),
      join(directory, 'schema/guide.schema.json'),
    )
    await cp(join(workspace, 'LICENSE'), join(directory, 'LICENSE'))
    await cp(join(phpRoot, 'INSTALL.md'), join(directory, 'README.md'))
    await cp(join(phpRoot, 'BACKUPS.md'), join(directory, 'BACKUPS.md'))
    await writeFile(join(directory, '.htaccess'), 'Require all denied\n')
    const key = randomBytes(32).toString('base64url')
    await writeFile(
      join(directory, 'setup-key.sha256'),
      createHash('sha256').update(key).digest('hex') + '\n',
      { mode: 0o600 },
    )
    const files = {}
    async function inventory(folder, prefix = '') {
      for (const entry of (
        await readdir(folder, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix + entry.name
        if (entry.isSymbolicLink())
          throw new Error('Distribution contains a symbolic link')
        if (entry.isDirectory())
          await inventory(join(folder, entry.name), name + '/')
        else if (entry.isFile()) {
          if (
            /(?:^|\/)(?:node_modules|data|\.env[^/]*|stepdoc\.config\.json|installation\.lock)(?:\/|$)/.test(
              name,
            )
          )
            throw new Error(
              'Private runtime state entered the distribution',
            )
          files[name] = createHash('sha256')
            .update(await readFile(join(folder, entry.name)))
            .digest('hex')
        } else throw new Error('Unsupported distribution file')
      }
    }
    await inventory(directory)
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify(
        {
          product: 'StepDoc',
          target: 'php-sqlite',
          php: '>=8.1',
          schema: 'stepdoc/guide@1',
          files,
        },
        null,
        2,
      ) + '\n',
    )
    const temporaryArchive = join(staging, 'stepdoc-php.zip')
    const archived = spawnSync(
      runtime.binary,
      [...runtime.args, join(phpRoot, 'scripts/archive.php')],
      {
        input: JSON.stringify({ directory, archive: temporaryArchive }),
        stdio: ['pipe', 'inherit', 'inherit'],
        windowsHide: true,
      },
    )
    if (archived.status !== 0)
      throw new Error(
        'PHP ZIP build failed; enable the local PHP ZIP extension',
      )
    const archive = join(outputRoot, 'stepdoc-php.zip')
    const setupKeyFile = join(outputRoot, 'stepdoc-php-install-key.txt')
    await rename(temporaryArchive, archive)
    await writeFile(setupKeyFile, key + '\n', { mode: 0o600 })
    await chmod(setupKeyFile, 0o600)
    return {
      archive,
      setupKeyFile,
      fileCount: Object.keys(files).length + 1,
    }
  } finally {
    // Delete only the fresh staging child of the explicitly resolved output folder.
    const target = await realpath(staging)
    if (
      !target.startsWith(outputRoot + sep) ||
      !target.startsWith(join(outputRoot, '.stepdoc-build-'))
    )
      throw new Error('Unexpected staging path')
    await rm(target, { recursive: true, force: true })
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await buildPhp()
  console.log(
    `Built ${result.archive} (${result.fileCount} files). Private setup key saved separately to ${result.setupKeyFile}; it is never bundled or printed.`,
  )
}

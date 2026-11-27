import { createHash, randomUUID } from 'node:crypto'
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { phpRuntime } from '../../servers/php/scripts/php.mjs'
import { buildPhp } from '../../servers/php/scripts/build.mjs'

const results = fileURLToPath(
  new URL('../../test-results/', import.meta.url),
)
export const apacheAvailable =
  spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 15000,
  }).status === 0
export async function installationArtifact() {
  await mkdir(results, { recursive: true })
  return buildPhp({
    output: await mkdtemp(join(results, 'php-archive-')),
    buildApp: true,
  })
}
type Artifact = Awaited<ReturnType<typeof installationArtifact>>
export async function installerFixture(
  artifact: Artifact,
  { base = '', apache = false, badRoot = false } = {},
) {
  const runtime = phpRuntime()
  const temporary = await mkdtemp(join(results, 'php-install-'))
  execFileSync(
    runtime.binary,
    [
      ...runtime.args,
      '-r',
      `
    $input=json_decode(stream_get_contents(STDIN),true,8,JSON_THROW_ON_ERROR);
    $zip=new ZipArchive(); if($zip->open($input['archive'])!==true) exit(1);
    for($i=0;$i<$zip->numFiles;$i++){ $name=$zip->getNameIndex($i); if(!str_starts_with($name,'stepdoc/') || str_contains($name,'..') || str_contains($name,'\\\\')) exit(1); }
    if(!$zip->extractTo($input['directory'])) exit(1); $zip->close();
  `,
    ],
    {
      input: JSON.stringify({
        archive: artifact.archive,
        directory: temporary,
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const root = join(temporary, 'stepdoc')
  const key = (await readFile(artifact.setupKeyFile, 'utf8')).trim()
  const manifest = JSON.parse(
    await readFile(join(root, 'manifest.json'), 'utf8'),
  ) as { files: Record<string, string> }
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (
      path.includes('..') ||
      !resolve(root, path).startsWith(
        root + (process.platform === 'win32' ? '\\' : '/'),
      )
    )
      throw new Error('Unsafe distribution entry')
    const bytes = await readFile(join(root, path))
    if (
      createHash('sha256').update(bytes).digest('hex') !== hash ||
      bytes.includes(Buffer.from(key))
    )
      throw new Error('Distribution integrity/privacy mismatch')
    if (
      /(?:^|\/)(?:node_modules|data|\.github\/workflows)(?:\/|$)/.test(path)
    )
      throw new Error('Development/runtime state packaged')
  }
  const env = { ...process.env }
  for (const name of Object.keys(env))
    if (name.startsWith('STEPDOC_')) delete env[name]
  env.STEPDOC_API_PATH = base + '/api/v1'
  const children: ChildProcess[] = []
  let container: string | undefined
  let origin: string
  let logs = ''
  async function local() {
    const reservation = createServer()
    await new Promise<void>((resolve) =>
      reservation.listen(0, '127.0.0.1', resolve),
    )
    const address = reservation.address()
    if (!address || typeof address === 'string')
      throw new Error('No local port')
    const port = address.port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    const child = spawn(
      runtime.binary,
      [
        ...runtime.args,
        '-S',
        `localhost:${port}`,
        '-t',
        badRoot ? root : join(root, 'public'),
        join(root, 'router.php'),
      ],
      {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    child.stdout?.on('data', (value: Buffer) => {
      logs = (logs + value.toString()).slice(-32768)
    })
    child.stderr?.on('data', (value: Buffer) => {
      logs = (logs + value.toString()).slice(-32768)
    })
    children.push(child)
    const addressUrl = `http://localhost:${port}`
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const response = await fetch(
          addressUrl + base + '/install.php?action=status',
          { signal: AbortSignal.timeout(1000) },
        )
        await response.body?.cancel()
        if (response.status === 200) return addressUrl
      } catch {}
      if (child.exitCode !== null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('Extracted PHP process did not become available')
  }
  async function close() {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve())
          child.kill()
        })
    if (container) {
      const label = execFileSync(
        'docker',
        [
          'inspect',
          '--format',
          '{{index .Config.Labels "stepdoc.test"}}',
          container,
        ],
        { encoding: 'utf8', windowsHide: true },
      ).trim()
      if (label !== 'installer')
        throw new Error('Refusing to remove an unrelated container')
      execFileSync('docker', ['rm', '-f', container], {
        stdio: 'ignore',
        windowsHide: true,
      })
    }
  }
  try {
    if (apache) {
      if (
        spawnSync('docker', ['image', 'inspect', 'php:8.1-apache'], {
          windowsHide: true,
          stdio: 'ignore',
        }).status !== 0
      )
        execFileSync('docker', ['pull', 'php:8.1-apache'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 180000,
        })
      const config = join(temporary, 'apache.conf')
      await writeFile(
        config,
        `<VirtualHost *:80>\nDocumentRoot /srv/stepdoc/public\nAlias /tools /srv/stepdoc/public\n<Directory /srv/stepdoc/public>\nAllowOverride All\nRequire all granted\n</Directory>\nErrorLog /proc/self/fd/2\nCustomLog /proc/self/fd/1 common\n</VirtualHost>\n`,
      )
      container = 'stepdoc-install-' + randomUUID()
      execFileSync(
        'docker',
        [
          'run',
          '-d',
          '--name',
          container,
          '--label',
          'stepdoc.test=installer',
          '-p',
          '127.0.0.1::80',
          '-v',
          `${root}:/srv/stepdoc`,
          '-v',
          `${config}:/etc/apache2/sites-available/000-default.conf:ro`,
          'php:8.1-apache',
          'bash',
          '-c',
          'a2enmod rewrite >/dev/null && exec apache2-foreground',
        ],
        { windowsHide: true, stdio: 'pipe' },
      )
      const mapping = execFileSync(
        'docker',
        ['port', container, '80/tcp'],
        { windowsHide: true, encoding: 'utf8' },
      ).trim()
      const port = /127\.0\.0\.1:(\d+)/.exec(mapping)?.[1]
      if (!port) throw new Error('No Apache loopback port')
      origin = `http://localhost:${port}`
    } else origin = await local()
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const response = await fetch(
          origin + base + '/install.php?action=status',
          { signal: AbortSignal.timeout(1000) },
        )
        if (response.status === 200) {
          await response.body?.cancel()
          ready = true
          break
        }
        await response.body?.cancel()
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!ready)
      throw new Error('Extracted installer did not become available')
    return {
      root,
      origin,
      base,
      key,
      manifest,
      endpoint: origin + base + '/install.php',
      api: origin + base + '/api/v1/',
      peer: local,
      request: (
        action: string,
        body?: unknown,
        cookie?: string,
        overrides: Record<string, string> = {},
        destination = origin,
      ) => {
        const url = destination + base + '/install.php?action=' + action
        const options = {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(body === undefined
              ? {}
              : { 'Content-Type': 'application/json', Origin: origin }),
            ...(cookie ? { Cookie: cookie } : {}),
            ...overrides,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'manual' as const,
        }
        if (destination === origin) return fetch(url, options)
        // Two PHP workers share one canonical Host, as behind a real web server.
        return new Promise<Response>((resolve, reject) => {
          const request = httpRequest(
            url,
            { method: options.method, headers: options.headers },
            (response) => {
              const chunks: Buffer[] = []
              response.on('data', (chunk: Buffer) => chunks.push(chunk))
              response.on('error', reject)
              response.on('end', () => {
                const headers = new Headers()
                for (
                  let index = 0;
                  index < response.rawHeaders.length;
                  index += 2
                )
                  headers.append(
                    response.rawHeaders[index]!,
                    response.rawHeaders[index + 1]!,
                  )
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode,
                    headers,
                  }),
                )
              })
            },
          )
          request.on('error', reject)
          request.end(options.body)
        })
      },
      sql: <T = Record<string, unknown>[]>(
        sql: string,
        params: unknown[] = [],
      ): T =>
        JSON.parse(
          execFileSync(
            runtime.binary,
            [
              ...runtime.args,
              '-r',
              `$db=require 'bootstrap.php';$input=json_decode(stream_get_contents(STDIN),true,16,JSON_THROW_ON_ERROR);$result=$db->execute($input['sql'],$input['params'])->fetchAll();echo json_encode($result,JSON_THROW_ON_ERROR);`,
            ],
            {
              cwd: root,
              env,
              input: JSON.stringify({ sql, params }),
              encoding: 'utf8',
              windowsHide: true,
            },
          ),
        ) as T,
      privateFiles: async () =>
        Promise.all(
          [
            'data/stepdoc.sqlite',
            'data/stepdoc.sqlite-wal',
            'data/auth.key',
            'stepdoc.config.json',
          ].map(async (name) => {
            try {
              return await readFile(join(root, name))
            } catch {
              return Buffer.alloc(0)
            }
          }),
        ),
      logs: () => logs,
      close,
    }
  } catch (error) {
    await close()
    throw error
  }
}
export type InstallerFixture = Awaited<ReturnType<typeof installerFixture>>

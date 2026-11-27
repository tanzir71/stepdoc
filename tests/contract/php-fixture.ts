import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { issuedTokenSchema } from '@stepdoc/schema/storage-api'
import {
  dependencies,
  phpRoot,
  phpRuntime,
} from '../../servers/php/scripts/php.mjs'

const workspace = fileURLToPath(new URL('../../', import.meta.url))
export async function phpFixture(
  options: {
    hostname?: string
    smtpPort?: number
    maxUploadBytes?: number
    apiPath?: string
    restoreFrom?: string
  } = {},
) {
  const runtime = phpRuntime()
  await dependencies(runtime)
  await mkdir(join(workspace, 'test-results'), { recursive: true })
  const dataDir = await mkdtemp(
    join(workspace, 'test-results/php-contract-'),
  )
  if (options.restoreFrom)
    await cp(options.restoreFrom, dataDir, {
      recursive: true,
      dereference: false,
    })
  const env = {
    ...process.env,
    STEPDOC_DATA_DIR: dataDir,
    STEPDOC_API_PATH: options.apiPath ?? '/tools/api/v1',
    STEPDOC_PAGE_SIZE: '3',
    STEPDOC_MAX_UPLOAD_BYTES: String(options.maxUploadBytes ?? 4096),
    // Fixtures never inherit a developer's real mail configuration.
    STEPDOC_MAIL_FROM: options.smtpPort ? 'stepdoc@fixture.test' : '',
    STEPDOC_SMTP_HOST: '127.0.0.1',
    STEPDOC_SMTP_PORT: String(options.smtpPort ?? 1),
    STEPDOC_SMTP_SECURITY: 'none',
    STEPDOC_SMTP_USERNAME: '',
    STEPDOC_SMTP_PASSWORD: '',
  }
  let canonicalOrigin = 'https://localhost'
  const cli = (command: string, input: object): unknown =>
    JSON.parse(
      execFileSync(
        runtime.binary,
        [...runtime.args, join(phpRoot, 'bin/stepdoc.php'), command],
        {
          input: JSON.stringify(input),
          encoding: 'utf8',
          env: { ...env, STEPDOC_ORIGIN: canonicalOrigin },
          windowsHide: true,
        },
      ),
    ) as unknown
  const first = cli('workspace:create', {
    name: 'Contract workspace A',
  }) as {
    id: string
  }
  const second = cli('workspace:create', {
    name: 'Contract workspace B',
  }) as {
    id: string
  }
  const issue = (workspaceId: string, scopes: string[], origin?: string) =>
    issuedTokenSchema.parse(
      cli('token:issue', {
        workspaceId,
        name: 'Contract device',
        scopes,
        origin,
      }),
    )
  const owner = issue(first.id, ['admin'])
  const other = issue(second.id, ['admin'])
  const reader = issue(first.id, ['guides:read'])
  const capture = issue(first.id, ['capture:write', 'guides:read'])
  const extensionOrigin =
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  const extension = issue(
    first.id,
    ['guides:read', 'guides:write'],
    extensionOrigin,
  )
  const children: ChildProcess[] = []
  async function start() {
    const listener = createServer()
    await new Promise<void>((resolve) =>
      listener.listen(0, '127.0.0.1', resolve),
    )
    const address = listener.address()
    if (!address || typeof address === 'string')
      throw new Error('Missing fixture port')
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    )
    const origin = `http://${options.hostname ?? '127.0.0.1'}:${address.port}`
    const child = spawn(
      runtime.binary,
      [
        ...runtime.args,
        '-S',
        `127.0.0.1:${address.port}`,
        '-t',
        join(phpRoot, 'public'),
        join(phpRoot, 'router.php'),
      ],
      {
        env: { ...env, STEPDOC_ORIGIN: origin },
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    )
    children.push(child)
    let ended = false
    child.once('exit', () => {
      ended = true
    })
    child.once('error', () => {
      ended = true
    })
    // Drain PHP's local access log without logging requests, headers or fixture tokens.
    child.stderr?.resume()
    const api = `${origin}${env.STEPDOC_API_PATH}/`
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (ended) throw new Error('PHP fixture exited during startup')
      try {
        const response = await fetch(api + 'health', {
          signal: AbortSignal.timeout(500),
        })
        if (response.ok) return { api, origin, child }
        await response.body?.cancel()
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    child.kill()
    throw new Error('PHP fixture did not become healthy')
  }
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill()
    })
  }
  try {
    const server = await start()
    canonicalOrigin = server.origin
    const peer = await start()
    return {
      server,
      peer,
      dataDir,
      workspaceId: first.id,
      owner,
      other,
      reader,
      capture,
      extension,
      extensionOrigin,
      maxUploadBytes: options.maxUploadBytes ?? 4096,
      command: cli,
      revoke: (id: string) => cli('token:revoke', { id }),
      issue: (scopes: string[]) => issue(first.id, scopes),
      member: (
        email: string,
        role: 'owner' | 'editor' | 'viewer',
        name: string = role,
      ) => ({
        ...(cli(role === 'owner' ? 'owner:create' : 'member:add', {
          workspaceId: first.id,
          email,
          name,
          role,
        }) as { id: string }),
        email,
        role,
      }),
      restart: async () => {
        await stop(server.child)
        Object.assign(server, await start())
        canonicalOrigin = server.origin
      },
      inspect: (sql: string): unknown =>
        JSON.parse(
          execFileSync(
            runtime.binary,
            [
              ...runtime.args,
              '-r',
              '$db=require $argv[1];echo json_encode($db->execute($argv[2])->fetchAll());',
              join(phpRoot, 'bootstrap.php'),
              sql,
            ],
            { env, encoding: 'utf8', windowsHide: true },
          ),
        ) as unknown,
      close: async () => {
        await Promise.all(children.map(stop))
      },
    }
  } catch (error) {
    await Promise.all(children.map(stop))
    throw error
  }
}

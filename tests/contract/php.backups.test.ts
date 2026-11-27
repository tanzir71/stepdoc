import { afterEach, describe, expect, it } from 'vitest'
import {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { guideSchema, type Guide } from '@stepdoc/schema'
import {
  apiHealthSchema,
  apiSessionSchema,
} from '@stepdoc/schema/storage-api'
import { HttpAdapter } from '@stepdoc/storage/http'
import { phpFixture } from './php-fixture'
import { authFixture, apiClient, type AuthFixture } from './auth-fixture'
import { authBrowser } from './auth-browser'
import { phpRoot, phpRuntime } from '../../servers/php/scripts/php.mjs'

type Fixture = Awaited<ReturnType<typeof phpFixture>>
type Summary = {
  id: string
  createdAt: string
  kind: 'daily' | 'manual'
  files: number
  bytes: number
}
const fixtures: Array<{ close(): Promise<void> }> = []
const browsers: Array<{ close(): Promise<void> }> = []
const held: ChildProcess[] = []
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.close()
  for (const child of held.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve())
        child.kill()
      })
    }
  for (const fixture of fixtures.splice(0)) await fixture.close()
})
async function fixture(options: Parameters<typeof phpFixture>[0] = {}) {
  const value = await phpFixture(options)
  fixtures.push(value)
  return value
}
const hash = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex')
const document = (id: string): Guide =>
  guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id,
    uuid: randomUUID(),
    title: 'Backup fixture guide',
    steps: [
      { id: 'one', index: 1, type: 'manual', title: 'Review settings' },
    ],
    version: 1,
    createdAt: '2026-11-27T00:00:00Z',
    updatedAt: '2026-11-27T00:00:00Z',
  })
const adapter = (f: Fixture, token = f.owner.token) =>
  HttpAdapter.open(f.server.api, {
    auth: { kind: 'bearer', token: () => token },
  })
const snapshot = (f: Fixture, id: string) => join(f.dataDir, 'backups', id)
const list = (f: Fixture) =>
  (f.command('backup:list', {}) as { backups: Summary[] }).backups
const create = (f: Fixture) => f.command('backup:create', {}) as Summary
function env(f: Fixture) {
  return {
    ...process.env,
    STEPDOC_DATA_DIR: f.dataDir,
    STEPDOC_API_PATH: '/tools/api/v1',
    STEPDOC_ORIGIN: f.server.origin,
  }
}
async function clock(f: Fixture, now: string, manual = false) {
  const runtime = phpRuntime()
  const { stdout } = await promisify(execFile)(
    runtime.binary,
    [
      ...runtime.args,
      '-r',
      '$db=require $argv[1];$b=new StepDoc\\Backups($db,new DateTimeImmutable($argv[2]));if($argv[3]==="manual")$b->create();else $b->daily();echo json_encode(["check"=>$b->check(),"backups"=>$b->list()],JSON_THROW_ON_ERROR);',
      join(phpRoot, 'bootstrap.php'),
      now,
      manual ? 'manual' : 'daily',
    ],
    { env: env(f), windowsHide: true },
  )
  return JSON.parse(stdout) as {
    check: { status: string }
    backups: Summary[]
  }
}
function sql(f: Fixture, path: string, query: string) {
  const runtime = phpRuntime()
  return JSON.parse(
    execFileSync(
      runtime.binary,
      [
        ...runtime.args,
        '-r',
        '$db=new PDO("sqlite:".$argv[1]);$db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);echo json_encode($db->query($argv[2])->fetchAll(PDO::FETCH_ASSOC),JSON_THROW_ON_ERROR);',
        path,
        query,
      ],
      { env: env(f), windowsHide: true, encoding: 'utf8' },
    ),
  ) as Array<Record<string, string | number | null>>
}
function rejected(f: Fixture, id: string) {
  const runtime = phpRuntime()
  const result = spawnSync(
    runtime.binary,
    [...runtime.args, join(phpRoot, 'bin/stepdoc.php'), 'backup:verify'],
    {
      env: env(f),
      input: JSON.stringify({ id }),
      encoding: 'utf8',
      windowsHide: true,
    },
  )
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(JSON.parse(result.stderr).error.message).toBe('Command failed.')
  expect(result.stderr.includes(f.dataDir)).toBe(false)
}
async function holdWal(f: Fixture) {
  const runtime = phpRuntime()
  const child = spawn(
    runtime.binary,
    [
      ...runtime.args,
      '-r',
      '$db=require $argv[1];$db->pdo->exec("PRAGMA wal_autocheckpoint=0");echo "ready\\n";fflush(STDOUT);fgets(STDIN);',
      join(phpRoot, 'bootstrap.php'),
    ],
    { env: env(f), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  )
  held.push(child)
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve())
    child.once('error', reject)
    child.once('exit', () =>
      reject(new Error('WAL keeper exited before readiness')),
    )
  })
}
async function call(
  f: Fixture,
  path: string,
  body: object | FormData,
  token = f.capture.token,
) {
  return fetch(f.server.api + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      ...(body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    body: body instanceof FormData ? body : JSON.stringify(body),
  })
}

describe('private lazy PHP backups', () => {
  it('runs from normal requests once per UTC day, serializes real workers and adopts a completed rename after interruption', async () => {
    const f = await fixture()
    expect(list(f)).toHaveLength(1)
    const health = apiHealthSchema.parse(
      await (await fetch(f.server.api + 'health')).json(),
    )
    expect(
      health.checks?.find((item) => item.id === 'backup')?.status,
    ).toBe('ok')
    await Promise.all([
      fetch(f.server.origin + '/tools/'),
      fetch(f.peer.origin + '/tools/'),
    ])
    expect(list(f)).toHaveLength(1)
    // Clock injection is local PHP construction, never an HTTP/test-mode bypass.
    const tomorrow = new Date()
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
    tomorrow.setUTCHours(0, 0, 0, 0)
    await Promise.all([
      clock(f, tomorrow.toISOString()),
      clock(f, tomorrow.toISOString()),
    ])
    const next = await clock(f, tomorrow.toISOString())
    expect(next.backups).toHaveLength(2)
    expect(
      next.backups[0]?.id.startsWith(tomorrow.toISOString().slice(0, 10)),
    ).toBe(true)
    expect(next.check.status).toBe('ok')
    const root = join(f.dataDir, 'backups')
    const partial = join(
      root,
      '.pending-' +
        tomorrow.toISOString().slice(0, 10) +
        'T000001Z-' +
        'a'.repeat(16),
    )
    await mkdir(partial)
    await writeFile(join(partial, 'incomplete'), 'interrupted bytes')
    await unlink(join(root, '.status.json'))
    const recovered = await clock(f, tomorrow.toISOString())
    expect(recovered.backups.map((item) => item.id)).toEqual(
      next.backups.map((item) => item.id),
    )
    expect(
      (await readdir(root)).some((name) => name.startsWith('.pending-')),
    ).toBe(false)
    expect(recovered.check.status).toBe('ok')
    const offset = new Date(tomorrow.getTime() + 86400000)
    const utc = await clock(
      f,
      offset.toISOString().replace('T00:00:00.000Z', 'T02:00:00+02:00'),
    )
    expect(
      utc.backups[0]?.id.startsWith(
        offset.toISOString().slice(0, 10) + 'T000000Z-',
      ),
    ).toBe(true)
  }, 90000)

  it('restores committed WAL, immutable history and large byte-identical blobs from a bounded-memory snapshot, excluding only incomplete uploads', async () => {
    const f = await fixture({ maxUploadBytes: 32 * 1024 * 1024 })
    await holdWal(f)
    const storage = await adapter(f)
    let guide = await storage.createGuide(document('backup-wal-guide'))
    const bytes = new Uint8Array(20 * 1024 * 1024).fill(37)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
    const { key } = await storage.putBlob(guide.id, {
      file: new Blob([bytes], { type: 'image/png' }),
      stepId: 'one',
      kind: 'rendered',
    })
    guide.steps[0]!.screenshot = {
      rendered: key,
      width: 1,
      height: 1,
      devicePixelRatio: 1,
    }
    guide = await storage.saveGuide(guide, guide.version)
    const captured = document('backup-capture-receipt')
    expect((await call(f, 'sessions', captured)).status).toBe(201)
    const pending = document('backup-incomplete')
    const form = new FormData()
    form.set(
      'file',
      new Blob([bytes.slice(0, 16)], { type: 'image/png' }),
      'discarded-upload-name.png',
    )
    form.set('stepId', 'one')
    form.set('kind', 'rendered')
    form.set('captureUuid', pending.uuid!)
    expect((await call(f, `guides/${pending.id}/blobs`, form)).status).toBe(
      201,
    )
    const mainOnly = join(f.dataDir, 'main-without-wal.sqlite')
    await copyFile(join(f.dataDir, 'stepdoc.sqlite'), mainOnly)
    expect(
      sql(
        f,
        mainOnly,
        "SELECT count(*) AS n FROM guides WHERE id='backup-wal-guide'",
      )[0]?.n,
    ).toBe(0)
    expect(
      (await stat(join(f.dataDir, 'stepdoc.sqlite-wal'))).size,
    ).toBeGreaterThan(32)
    const runtime = phpRuntime()
    const point = JSON.parse(
      execFileSync(
        runtime.binary,
        [
          ...runtime.args,
          '-d',
          'memory_limit=16M',
          join(phpRoot, 'bin/stepdoc.php'),
          'backup:create',
        ],
        { input: '{}', env: env(f), encoding: 'utf8', windowsHide: true },
      ),
    ) as Summary
    expect(point.bytes).toBeGreaterThan(20 * 1024 * 1024)
    expect(
      (
        f.command('backup:verify', { id: point.id }) as {
          verified: boolean
        }
      ).verified,
    ).toBe(true)
    const database = join(snapshot(f, point.id), 'data/stepdoc.sqlite')
    expect(
      sql(f, database, 'SELECT count(*) AS n FROM capture_blobs')[0]?.n,
    ).toBe(0)
    expect(
      sql(
        f,
        database,
        'SELECT count(*) AS n FROM capture_uploads WHERE committed_at IS NULL',
      )[0]?.n,
    ).toBe(0)
    expect(
      sql(
        f,
        database,
        'SELECT count(*) AS n FROM capture_uploads WHERE committed_at IS NOT NULL',
      )[0]?.n,
    ).toBe(1)
    expect(f.inspect('SELECT count(*) AS n FROM capture_blobs')).toEqual([
      { n: 1 },
    ])
    expect(
      await readFile(join(snapshot(f, point.id), 'data/auth.key')),
    ).toEqual(await readFile(join(f.dataDir, 'auth.key')))
    expect(
      hash(await readFile(join(snapshot(f, point.id), 'data/blobs', key))),
    ).toBe(hash(bytes))
    guide.title = 'Changed after recovery point'
    await storage.saveGuide(guide, guide.version)
    const restored = await fixture({
      restoreFrom: join(snapshot(f, point.id), 'data'),
    })
    const recovered = await adapter(restored, f.owner.token)
    const saved = await recovered.getGuide(guide.id)
    expect(saved.version).toBe(2)
    expect(saved.title).toBe('Backup fixture guide')
    expect(
      (await recovered.listVersions(guide.id)).map((item) => item.version),
    ).toEqual([2, 1])
    expect(
      hash(
        new Uint8Array(await (await recovered.getBlob(key)).arrayBuffer()),
      ),
    ).toBe(hash(bytes))
    expect(
      (await call(restored, 'sessions', captured, f.capture.token)).status,
    ).toBe(201)
    expect((await recovered.getGuide(captured.id)).version).toBe(1)
    expect((await storage.getGuide(guide.id)).version).toBe(3)
    const configuration = JSON.parse(
      await readFile(
        join(snapshot(f, point.id), 'stepdoc.config.json'),
        'utf8',
      ),
    )
    expect(configuration).toEqual({
      origin: f.server.origin,
      apiPath: '/tools/api/v1',
    })
    storage.close()
    recovered.close()
  }, 120000)

  it('recovers native passkeys and one-use recovery authentication with the private HMAC key, without snapshotting shown-once values', async () => {
    const source = await authFixture()
    fixtures.push(source)
    const native = await authBrowser(source)
    browsers.push(native)
    const credential = await native.ceremony(
      'register',
      source.members.owner.email,
      source.owner.token,
    )
    const response = await native.request(
      'auth/passkey/verify',
      'POST',
      credential,
      source.owner.token,
    )
    expect(response.status).toBe(200)
    const session = apiSessionSchema.parse(response.body)
    expect(Boolean(session.recoveryCodes?.length === 10)).toBe(true)
    const point = create(source)
    const restored = await fixture({
      hostname: 'localhost',
      restoreFrom: join(snapshot(source, point.id), 'data'),
    })
    const recoveredFixture: AuthFixture = {
      ...restored,
      smtp: source.smtp,
      members: source.members,
    }
    const recovered = apiClient(recoveredFixture)
    const code = session.recoveryCodes![0]!
    expect(
      (
        await recovered.request('auth/recovery', 'POST', {
          email: source.members.owner.email,
          code,
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await recovered.request('auth/recovery', 'POST', {
          email: source.members.owner.email,
          code,
        })
      ).status,
    ).toBe(400)
    const { credentials } = await native.cdp.send(
      'WebAuthn.getCredentials',
      { authenticatorId: native.authenticatorId },
    )
    const target = await authBrowser(recoveredFixture)
    browsers.push(target)
    for (const value of credentials)
      await target.cdp.send('WebAuthn.addCredential', {
        authenticatorId: target.authenticatorId,
        credential: value,
      })
    const assertion = await target.ceremony('authenticate')
    expect(
      (await target.request('auth/passkey/verify', 'POST', assertion))
        .status,
    ).toBe(200)
    const secretCookie = (await native.context.cookies()).find(
      (value) => value.name === 'sd_session',
    )?.value
    const database = await readFile(
      join(snapshot(source, point.id), 'data/stepdoc.sqlite'),
    )
    expect(
      [
        ...(session.recoveryCodes ?? []),
        secretCookie ?? '',
        source.owner.token,
      ]
        .filter(Boolean)
        .some((secret) => database.includes(Buffer.from(secret))),
    ).toBe(false)
    expect(
      (
        source.command('backup:verify', { id: point.id }) as {
          verified: boolean
        }
      ).verified,
    ).toBe(true)
  }, 120000)

  it('retains seven successful points, keeps earlier points after failure, throttles retries and supports an explicit local retry', async () => {
    const f = await fixture()
    const storage = await adapter(f)
    let guide = await storage.createGuide(document('backup-failure-guide'))
    const bytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4,
    ])
    const { key } = await storage.putBlob(guide.id, {
      file: new Blob([bytes], { type: 'image/png' }),
      kind: 'rendered',
      stepId: 'one',
    })
    guide.steps[0]!.screenshot = {
      rendered: key,
      width: 1,
      height: 1,
      devicePixelRatio: 1,
    }
    await storage.saveGuide(guide, 1)
    const start = new Date()
    start.setUTCDate(start.getUTCDate() + 1)
    start.setUTCHours(0, 0, 0, 0)
    for (let day = 0; day < 9; day++)
      await clock(
        f,
        new Date(start.getTime() + day * 86400000).toISOString(),
      )
    const prior = list(f)
    expect(prior).toHaveLength(7)
    const marker = join(f.dataDir, 'backups/user-files')
    await mkdir(marker)
    await writeFile(join(marker, 'keep'), 'untouched')
    const path = join(f.dataDir, 'blobs', key)
    await rename(path, path + '.held')
    const attempt = new Date(start.getTime() + 9 * 86400000)
    const failed = await clock(f, attempt.toISOString())
    expect(failed.check.status).toBe('warn')
    expect(failed.backups).toEqual(prior)
    const statusPath = join(f.dataDir, 'backups/.status.json')
    const state = await readFile(statusPath, 'utf8')
    await clock(f, new Date(attempt.getTime() + 60000).toISOString())
    expect(await readFile(statusPath, 'utf8')).toBe(state)
    expect((await fetch(f.server.api + 'health')).status).toBe(200)
    await rename(path + '.held', path)
    const repaired = await clock(
      f,
      new Date(attempt.getTime() + 120000).toISOString(),
      true,
    )
    expect(repaired.check.status).toBe('ok')
    expect(repaired.backups).toHaveLength(7)
    expect(repaired.backups[0]?.kind).toBe('manual')
    expect(
      (await readdir(join(f.dataDir, 'backups'))).some((name) =>
        name.startsWith('.pending-'),
      ),
    ).toBe(false)
    expect(await readFile(join(marker, 'keep'), 'utf8')).toBe('untouched')
    expect(
      (
        f.command('backup:verify', { id: repaired.backups[0]!.id }) as {
          verified: boolean
        }
      ).verified,
    ).toBe(true)
    storage.close()
  }, 90000)

  it('rejects corrupt bytes, incomplete manifests, traversal and duplicate entries with fixed private CLI errors', async () => {
    const f = await fixture()
    const point = create(f)
    const root = snapshot(f, point.id)
    const keyPath = join(root, 'data/auth.key')
    const original = await readFile(keyPath)
    await writeFile(keyPath, new Uint8Array(32))
    rejected(f, point.id)
    await writeFile(keyPath, original)
    const manifestPath = join(root, 'manifest.jsonl')
    const manifest = await readFile(manifestPath, 'utf8')
    await writeFile(
      manifestPath,
      manifest.split('\n').slice(0, -2).join('\n') + '\n',
    )
    rejected(f, point.id)
    const lines = manifest.trimEnd().split('\n')
    const footer = JSON.parse(lines.pop()!) as {
      sha256: string
      files: number
      bytes: number
    }
    const entry = JSON.parse(lines[1]!) as {
      path: string
      bytes: number
      sha256: string
    }
    lines[1] = JSON.stringify({ ...entry, path: '../auth.key' })
    footer.sha256 = hash(lines.join('\n') + '\n')
    await writeFile(
      manifestPath,
      [...lines, JSON.stringify(footer), ''].join('\n'),
    )
    rejected(f, point.id)
    const duplicate = manifest.trimEnd().split('\n')
    const end = JSON.parse(duplicate.pop()!) as {
      sha256: string
      files: number
      bytes: number
    }
    duplicate.push(duplicate[1]!)
    end.files++
    end.bytes += entry.bytes
    end.sha256 = hash(duplicate.join('\n') + '\n')
    await writeFile(
      manifestPath,
      [...duplicate, JSON.stringify(end), ''].join('\n'),
    )
    rejected(f, point.id)
    await writeFile(manifestPath, manifest)
    expect(
      (
        f.command('backup:verify', { id: point.id }) as {
          verified: boolean
        }
      ).verified,
    ).toBe(true)
    rejected(f, '../outside')
  }, 60000)

  it('never follows a redirected backup root, changes live storage, exposes backup files or adds HTTP administration', async () => {
    const f = await fixture()
    const before = f.inspect('SELECT id,token_hash FROM tokens ORDER BY id')
    const privateRoot = join(f.dataDir, 'backups')
    const saved = join(f.dataDir, 'saved-backups')
    await rename(privateRoot, saved)
    const outside = await mkdtemp(join(f.dataDir, 'outside-'))
    await writeFile(join(outside, 'marker'), 'untouched')
    await symlink(outside, privateRoot, 'junction')
    try {
      const response = await fetch(f.server.api + 'health')
      expect(response.status).toBe(200)
      const body = apiHealthSchema.parse(await response.json())
      expect(
        body.checks?.find((item) => item.id === 'backup')?.status,
      ).toBe('warn')
      expect(JSON.stringify(body).includes(f.dataDir)).toBe(false)
      expect(await readdir(outside)).toEqual(['marker'])
      expect(
        f.inspect('SELECT id,token_hash FROM tokens ORDER BY id'),
      ).toEqual(before)
    } finally {
      await unlink(privateRoot)
      await rename(saved, privateRoot)
    }
    const id = list(f)[0]!.id
    for (const path of [
      `/tools/data/backups/${id}/data/auth.key`,
      `/tools/backups/${id}/manifest.jsonl`,
      `/tools/backups/${id}/data/stepdoc.sqlite`,
    ])
      expect((await fetch(f.server.origin + path)).status).toBe(404)
    expect(
      (
        await fetch(f.server.api + 'backup/create', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + f.owner.token },
        })
      ).status,
    ).toBe(404)
  }, 60000)
})

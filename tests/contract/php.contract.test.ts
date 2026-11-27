import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { guideSchema } from '@stepdoc/schema'
import { HttpAdapter } from '@stepdoc/storage/http'
import { phpFixture } from './php-fixture'
import { phpRoot, phpRuntime } from '../../servers/php/scripts/php.mjs'

let fixture: Awaited<ReturnType<typeof phpFixture>>
beforeAll(async () => {
  fixture = await phpFixture()
})
afterAll(async () => {
  await fixture?.close()
})
describe('PHP storage and host boundaries', () => {
  it('persists only hashed tokens and safe audit metadata, with versioned migrations', async () => {
    const tokens = fixture.inspect(
      'SELECT token_hash,scopes,revoked_at FROM tokens',
    ) as { token_hash: string }[]
    expect(tokens.length).toBeGreaterThan(0)
    for (const token of tokens)
      expect(token.token_hash).toMatch(/^[a-f0-9]{64}$/)
    for (const name of (await readdir(fixture.dataDir)).filter((name) =>
      name.startsWith('stepdoc.sqlite'),
    )) {
      expect(
        (await readFile(join(fixture.dataDir, name))).includes(
          Buffer.from(fixture.owner.token),
        ),
      ).toBe(false)
    }
    expect(
      JSON.stringify(fixture.inspect('SELECT * FROM audit_log')),
    ).not.toContain(fixture.owner.token)
    expect(fixture.inspect('SELECT version FROM migrations')).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
    ])
    expect(fixture.inspect('PRAGMA foreign_key_check')).toEqual([])
  })
  it('keeps unmodified blob bytes and old versions on disk after trash, without retaining upload filenames', async () => {
    const adapter = await HttpAdapter.open(fixture.server.api, {
      auth: { kind: 'bearer', token: () => fixture.owner.token },
    })
    try {
      let guide = await adapter.createGuide(
        guideSchema.parse({
          schema: 'stepdoc/guide@1',
          id: 'disk-guide',
          title: 'Private disk guide',
          steps: [{ id: 'one', index: 1, type: 'manual', title: 'Continue' }],
          version: 1,
          createdAt: '2026-11-26T00:00:00Z',
          updatedAt: '2026-11-26T00:00:00Z',
        }),
      )
      // Signature validation accepts transport bytes without decoding any image.
      const png = new Uint8Array([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3, 4, 5,
      ])
      const { key } = await adapter.putBlob(guide.id, {
        file: new Blob([png], { type: 'image/png' }),
        stepId: 'one',
        kind: 'rendered',
      })
      guide.steps[0]!.screenshot = {
        rendered: key,
        width: 1,
        height: 1,
        devicePixelRatio: 1,
      }
      guide = await adapter.saveGuide(guide, 1)
      await adapter.deleteGuide(guide.id)
      expect(await readFile(join(fixture.dataDir, 'blobs', key))).toEqual(
        Buffer.from(png),
      )
      expect(
        fixture.inspect(
          "SELECT version FROM guide_versions WHERE guide_id='disk-guide' ORDER BY version",
        ),
      ).toEqual([{ version: 1 }, { version: 2 }])
      const blobs = fixture.inspect('SELECT * FROM blobs') as Record<
        string,
        unknown
      >[]
      expect(blobs).toHaveLength(1)
      expect(blobs[0]).toMatchObject({
        mime: 'image/png',
        bytes: png.byteLength,
        kind: 'rendered',
      })
      expect(blobs[0]).not.toHaveProperty('filename')
      expect(await readdir(join(fixture.dataDir, 'blobs'))).toEqual([key])
      expect((await stat(join(fixture.dataDir, 'blobs', key))).size).toBe(
        png.byteLength,
      )
    } finally {
      adapter.close()
    }
  })
  it('rejects a data directory within the public root before creating any database', async () => {
    const runtime = phpRuntime()
    const forbidden = join(
      phpRoot,
      'public',
      `forbidden-${crypto.randomUUID()}`,
    )
    const response = spawnSync(
      runtime.binary,
      [...runtime.args, join(phpRoot, 'bin/stepdoc.php'), 'workspace:create'],
      {
        input: JSON.stringify({ name: 'Forbidden' }),
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, STEPDOC_DATA_DIR: forbidden },
      },
    )
    expect(response.status).toBe(1)
    expect(response.stdout).toBe('')
    expect(response.stderr).not.toContain(forbidden)
    expect(JSON.parse(response.stderr)).toMatchObject({
      error: { code: 'invalid_options' },
    })
    expect(existsSync(forbidden)).toBe(false)
  })
  it('uses the source JSON Schema and keeps defaults and privacy checks independent of Node', async () => {
    const runtime = phpRuntime()
    const input = {
      schema: 'stepdoc/guide@1',
      id: 'standalone-schema',
      title: 'Standalone',
      steps: [{ id: 'one', index: 1, type: 'manual', title: 'Continue' }],
      version: 1,
      createdAt: '2026-11-26T00:00:00Z',
      updatedAt: '2026-11-26T00:00:00Z',
    }
    const result = execFileSync(
      runtime.binary,
      [
        ...runtime.args,
        '-r',
        'require $argv[1];$data=json_decode(stream_get_contents(STDIN));echo json_encode((new \\StepDoc\\GuideValidator())->parse($data));',
        join(phpRoot, 'vendor/autoload.php'),
      ],
      { input: JSON.stringify(input), encoding: 'utf8', windowsHide: true },
    )
    const parsed: unknown = JSON.parse(result)
    expect(parsed).toEqual(guideSchema.parse(parsed))
    const forbidden = {
      ...input,
      variables: [
        { name: 'credential', kind: 'secret', example: 'PRIVATE_VALUE' },
      ],
    }
    const response = await fetch(fixture.server.api + 'guides', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${fixture.owner.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(forbidden),
    })
    expect(response.status).toBe(400)
    expect(
      JSON.stringify(fixture.inspect('SELECT doc_json FROM guides')),
    ).not.toContain('PRIVATE_VALUE')
  })
  it('throttles last-seen metadata while still enforcing revocation immediately', async () => {
    const token = fixture.issue(['guides:read'])
    const request = () =>
      fetch(fixture.server.api + 'guides', {
        headers: { Authorization: `Bearer ${token.token}` },
      })
    expect((await request()).status).toBe(200)
    const first = fixture.inspect(
      `SELECT last_seen_at FROM tokens WHERE id='${token.id}'`,
    )
    expect((await request()).status).toBe(200)
    expect(
      fixture.inspect(`SELECT last_seen_at FROM tokens WHERE id='${token.id}'`),
    ).toEqual(first)
    fixture.revoke(token.id)
    expect((await request()).status).toBe(401)
  })
})

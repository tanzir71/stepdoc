import { describe, expect, it } from 'vitest'
import { zipSync, unzipSync } from 'fflate'
import { guideSchema } from '@stepdoc/schema'
import { exportBundle, sha256 } from '../../src/export/archive'
import { exportWorkspace, importWorkspace } from '../../src/export/workspace'

const bundle = (id: string) =>
  exportBundle(
    guideSchema.parse({
      schema: 'stepdoc/guide@1',
      id,
      title: id,
      version: 1,
      createdAt: '2026-11-28T00:00:00Z',
      updatedAt: '2026-11-28T00:00:00Z',
      steps: [
        {
          id: 'first-step',
          index: 1,
          type: 'manual',
          title: 'Read this',
          description: 'A local note.',
        },
      ],
    }),
    {},
  )
describe('portable workspace envelope', () => {
  it('round-trips multiple guides and an empty workspace without credentials or host configuration', async () => {
    const bytes = await exportWorkspace(
      await Promise.all(['guide-one', 'guide-two'].map(bundle)),
    )
    expect((await importWorkspace(bytes)).map((item) => item.guide.id)).toEqual(
      ['guide-one', 'guide-two'],
    )
    expect(Object.keys(unzipSync(bytes))).toEqual([
      'guides/1.stepdoc',
      'guides/2.stepdoc',
      'manifest.json',
    ])
    expect(await importWorkspace(await exportWorkspace([]))).toEqual([])
  })
  it('rejects corrupted nested hashes, duplicate guide identities and unknown files before restore', async () => {
    const one = await bundle('guide-one')
    await expect(
      importWorkspace(await exportWorkspace([one, one])),
    ).rejects.toMatchObject({ code: 'invalid_archive' })
    const files = unzipSync(await exportWorkspace([one]))
    const corrupt = files['guides/1.stepdoc']!
    corrupt[0] = corrupt[0]! ^ 1
    await expect(importWorkspace(zipSync(files))).rejects.toMatchObject({
      code: 'invalid_archive',
    })
    files['credentials.json'] = new TextEncoder().encode('{}')
    await expect(importWorkspace(zipSync(files))).rejects.toMatchObject({
      code: 'invalid_archive',
    })
  })
  it('rejects traversal, duplicate manifest entries, extra metadata and excess guide counts', async () => {
    const one = await bundle('guide-one')
    const entry = { path: 'guides/1.stepdoc', sha256: await sha256(one) }
    for (const files of [
      [entry, entry],
      [{ ...entry, path: '../escape.stepdoc' }],
    ])
      await expect(
        importWorkspace(
          zipSync({
            'manifest.json': new TextEncoder().encode(
              JSON.stringify({ format: 'stepdoc/workspace@1', files }),
            ),
            'guides/1.stepdoc': one,
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_archive' })
    const source = unzipSync(await exportWorkspace([one]))
    const manifest = JSON.parse(
      new TextDecoder().decode(source['manifest.json']),
    )
    source['manifest.json'] = new TextEncoder().encode(
      JSON.stringify({ ...manifest, token: 'not-permitted' }),
    )
    await expect(importWorkspace(zipSync(source))).rejects.toMatchObject({
      code: 'invalid_archive',
    })
    await expect(
      exportWorkspace(Array.from({ length: 501 }, () => one)),
    ).rejects.toMatchObject({ code: 'archive_limit' })
  })
})

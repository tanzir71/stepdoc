import { describe, expect, it } from 'vitest'
import { guideSchema } from '@stepdoc/schema'
import { IndexedDbAdapter, StorageError, storageError } from '../src'
import {
  guidePage,
  summary,
  validateGuide,
  validateId,
  validateVersion,
} from '../src/guides'
import source from '../../schema/tests/fixtures/complete.json'

const complete = guideSchema.parse(source)
function guide(id: string, updatedAt = '2026-11-25T00:00:00Z') {
  return { ...structuredClone(complete), id, updatedAt }
}

describe('guide validation and storage errors', () => {
  it('copies validated data and never mutates a caller document', () => {
    const input = guide('local-guide')
    const output = validateGuide(input)
    output.title = 'Changed'
    output.steps[0]!.title = 'Changed'
    expect(input.title).toBe(complete.title)
    expect(input.steps[0]!.title).toBe(complete.steps[0]!.title)
  })
  it.each([
    'typed',
    'missing',
    'mismatch',
    'duplicate-step',
    'duplicate-index',
    'duplicate-variable',
  ])('rejects invalid privacy/identity state: %s', (kind) => {
    const input = guide('local-guide')
    if (kind === 'typed')
      Object.assign(input.steps[1]!, {
        value: { kind: 'literal', literal: 'private-input' },
      })
    if (kind === 'missing') input.variables = []
    if (kind === 'mismatch') input.variables[0]!.kind = 'variable'
    if (kind === 'duplicate-step') input.steps[1]!.id = input.steps[0]!.id
    if (kind === 'duplicate-index')
      input.steps[1]!.index = input.steps[0]!.index
    if (kind === 'duplicate-variable') input.variables.push(input.variables[0]!)
    expect(() => validateGuide(input)).toThrowError(
      new StorageError('invalid_guide'),
    )
    expect(() => validateGuide(input, true)).toThrowError(
      new StorageError('corrupt_data'),
    )
  })
  it('never attaches validation input or native causes to errors', () => {
    const input = { ...guide('local-guide'), private: 'private-input' }
    try {
      validateGuide(input)
      throw new Error('Missing failure')
    } catch (error) {
      expect(error).toBeInstanceOf(StorageError)
      expect(String(error) + JSON.stringify(error)).not.toContain(
        'private-input',
      )
      expect(error).not.toHaveProperty('cause')
    }
    expect(storageError(new Error('private-native-error'))).toEqual(
      new StorageError('storage_unavailable'),
    )
    expect(
      storageError(new DOMException('private-path', 'QuotaExceededError')).code,
    ).toBe('storage_full')
    expect(storageError(new StorageError('conflict', 3)).currentVersion).toBe(3)
  })
  it.each(['../guide', '', 'x', 'Private-guide', 'guide/next'])(
    'rejects invalid guide IDs: %s',
    (id) => expect(() => validateId(id)).toThrow(StorageError),
  )
  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid versions: %s',
    (version) => expect(() => validateVersion(version)).toThrow(StorageError),
  )
  it('imports safely without browser globals and reports unsupported persistence', async () => {
    expect(typeof indexedDB).toBe('undefined')
    await expect(IndexedDbAdapter.open()).rejects.toMatchObject({
      code: 'unsupported',
    })
  })
  it('sanitizes configuration getters instead of forwarding native messages', async () => {
    const options = Object.defineProperty({}, 'pageSize', {
      get() {
        throw new Error('private-native-options')
      },
    })
    await expect(IndexedDbAdapter.open(options)).rejects.toEqual(
      new StorageError('storage_unavailable'),
    )
  })
  it.each([
    { databaseName: '../guide' },
    { pageSize: 0 },
    { pageSize: 201 },
    { pageSize: 1.5 },
  ])('rejects invalid adapter configuration', async (options) => {
    await expect(IndexedDbAdapter.open(options)).rejects.toMatchObject({
      code: 'invalid_options',
    })
  })
})

describe('library queries and summaries', () => {
  it('searches authored step text without indexing variable or target payloads', async () => {
    const input = guide('step-search')
    input.steps[0]!.description = 'Open the plan dialog'
    expect(
      (await guidePage([input], { q: 'PLAN DIALOG' }, 50)).items,
    ).toHaveLength(1)
    expect(
      (await guidePage([input], { q: 'billing_email' }, 50)).items,
    ).toHaveLength(0)
  })
  const items = [
    guide('guide-aaa'),
    guide('guide-bbb'),
    guide('guide-ccc', '2026-11-26T00:00:00Z'),
  ]
  it('sorts by timestamp, breaks ties by ID and pages without duplicates', async () => {
    const page1 = await guidePage(items, {}, 2)
    expect(page1.items.map((item) => item.id)).toEqual([
      'guide-ccc',
      'guide-aaa',
    ])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await guidePage(items, { cursor: page1.nextCursor! }, 2)
    expect(page2.items.map((item) => item.id)).toEqual(['guide-bbb'])
    expect(page2.nextCursor).toBeNull()
  })
  it('handles equivalent timestamps with different offsets', async () => {
    const page = await guidePage(
      [guide('guide-bbb', '2026-11-25T06:00:00+06:00'), guide('guide-aaa')],
      {},
      50,
    )
    expect(page.items.map((item) => item.id)).toEqual([
      'guide-aaa',
      'guide-bbb',
    ])
  })
  it('exposes only the API summary fields, never target/variable/original data', () => {
    const result = summary(complete)
    expect(result).toMatchObject({
      id: complete.id,
      stepCount: 8,
      openRedactions: 0,
      verification: 'passed',
      thumb: complete.steps[0]!.screenshot!.rendered,
    })
    expect(result).not.toHaveProperty('variables')
    expect(result).not.toHaveProperty('steps')
    expect(JSON.stringify(result)).not.toContain('billing_email')
    expect(JSON.stringify(result)).not.toContain('original.webp')
  })
  it('searches title/description/tags/application case insensitively', async () => {
    const queries = [
      'WORKSPACE',
      'billing contact',
      'onboarding',
      'example.com',
    ]
    for (const q of queries)
      expect((await guidePage([complete], { q }, 50)).items).toHaveLength(1)
    expect(
      (await guidePage([complete], { q: 'not present' }, 50)).items,
    ).toEqual([])
  })
  it('filters review/passed/status and assigned/unassigned collections', async () => {
    const review = guide('review-guide')
    review.steps[0]!.redactions[0]!.status = 'open'
    const draft = guide('draft-guide')
    draft.status = 'draft'
    draft.collectionId = null
    draft.verification = { status: 'never-run' }
    expect(
      (
        await guidePage([review, draft], { status: 'needs-review' }, 50)
      ).items.map((item) => item.id),
    ).toEqual(['review-guide'])
    expect(
      (
        await guidePage([review, draft], { status: 'replay-passed' }, 50)
      ).items.map((item) => item.id),
    ).toEqual(['review-guide'])
    expect(
      (
        await guidePage(
          [review, draft],
          { status: 'draft', collection: null },
          50,
        )
      ).items.map((item) => item.id),
    ).toEqual(['draft-guide'])
    expect(
      (
        await guidePage([review, draft], { collection: 'billing' }, 50)
      ).items.map((item) => item.id),
    ).toEqual(['review-guide'])
  })
  it('does not encode search text in cursors and rejects a cursor reused with different filters', async () => {
    const page = await guidePage(items, { q: 'workspace' }, 1)
    expect(atob(page.nextCursor!)).not.toContain('workspace')
    await expect(
      guidePage(items, { q: 'other', cursor: page.nextCursor! }, 1),
    ).rejects.toMatchObject({ code: 'invalid_query' })
  })
  it.each([
    'invalid',
    btoa('{}'),
    btoa(
      JSON.stringify({
        id: '../bad',
        at: '2026-11-25',
        filter: 'a'.repeat(64),
      }),
    ),
  ])('rejects malformed cursors', async (cursor) => {
    await expect(guidePage(items, { cursor }, 50)).rejects.toMatchObject({
      code: 'invalid_query',
    })
  })
  it.each([{ q: 'x'.repeat(1001) }, { cursor: 'x'.repeat(2049) }])(
    'bounds incoming queries',
    async (query) => {
      await expect(guidePage(items, query, 50)).rejects.toMatchObject({
        code: 'invalid_query',
      })
    },
  )
})

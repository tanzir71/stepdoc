import { afterEach, describe, expect, it, vi } from 'vitest'
import { guideSchema } from '@stepdoc/schema'
import { importGuide, libraryUrl, manualGuide, parseLibrary } from './model'
import { readPreferences } from './preferences'

afterEach(() => vi.unstubAllGlobals())
describe('local library navigation and authoring', () => {
  it('preserves independently selected filters and shareable display state', () => {
    const url = libraryUrl('?q=plan&view=list&status=draft', {
      status: 'all',
      collection: 'finance-ops',
      limit: 'all',
    })
    expect(parseLibrary(url.slice(1))).toMatchObject({
      query: { q: 'plan', collection: 'finance-ops' },
      view: 'list',
      status: 'all',
      showAll: true,
    })
    expect(
      parseLibrary('?status=invalid&sort=invalid&view=invalid'),
    ).toMatchObject({ status: 'all', sort: 'edited', view: 'grid' })
  })
  it('creates schema-valid guides from explicit author instructions', () => {
    const guide = guideSchema.parse(
      manualGuide('  My guide  ', '  Open settings  '),
    )
    expect(guide.title).toBe('My guide')
    expect(guide.steps[0]).toMatchObject({
      type: 'manual',
      title: 'Open settings',
    })
    expect(guide.steps[0]).not.toHaveProperty('value')
    expect(importGuide(JSON.stringify(guide))).toEqual(guide)
  })
  it('rejects invalid imports including literal recorded field values', () => {
    const input = manualGuide('Example', 'Open settings')
    input.steps[0] = {
      ...input.steps[0]!,
      type: 'action',
      action: 'fill',
      value: { kind: 'literal', literal: 'synthetic-private-input' },
    }
    expect(importGuide(JSON.stringify(input))).toBeNull()
    expect(importGuide('{')).toBeNull()
  })
  it('defaults to light when preferences are missing, corrupt, blocked or incompatible', () => {
    for (const value of [
      null,
      '{',
      '{}',
      '{"version":2,"theme":"dark"}',
      '{"version":1,"theme":"unknown"}',
    ]) {
      vi.stubGlobal('localStorage', { getItem: () => value })
      expect(readPreferences()).toEqual({
        version: 1,
        theme: 'light',
        collapsed: false,
      })
    }
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('blocked')
      },
    })
    expect(readPreferences().theme).toBe('light')
    vi.stubGlobal('localStorage', {
      getItem: () => '{"version":1,"theme":"system","collapsed":true}',
    })
    expect(readPreferences()).toEqual({
      version: 1,
      theme: 'system',
      collapsed: true,
    })
  })
})

import { describe, expect, it } from 'vitest'
import { stepSchema, type Step } from '@stepdoc/schema'
import { captureCleanupSuggestionSchema } from '@stepdoc/schema/capture'
import { suggestCaptureCleanup } from '../src/cleanup'

const click = (id: string, index = 1): Step =>
  stepSchema.parse({
    id,
    index,
    type: 'action',
    action: 'click',
    title: 'Click "Plan"',
    url: 'https://example.test/settings',
    target: {
      role: 'button',
      name: 'Plan',
      locators: [{ strategy: 'css', value: '#plan', unique: true }],
    },
  })
describe('offline capture cleanup proposals', () => {
  it('proposes a manual merge only for adjacent, proven same-context clicks', () => {
    const steps = [click('a'), click('b', 2), click('c', 3)]
    expect(suggestCaptureCleanup(steps)).toEqual([
      expect.objectContaining({
        id: 'merge-1',
        kind: 'merge',
        stepIds: ['a', 'b'],
      }),
    ])
    expect(steps).toHaveLength(3)
  })
  it.each([
    'frame',
    'shadowPath',
    'url',
    'locator',
    'role',
    'expect',
    'ambiguous',
  ])('does not merge across a changed %s', (change) => {
    const a = click('a'),
      b = click('b', 2)
    if (change === 'frame' || change === 'shadowPath')
      b.target![change] = ['#different']
    if (change === 'url') b.url = 'https://example.test/other'
    if (change === 'locator') b.target!.locators![0]!.value = '#other'
    if (change === 'role') b.target!.role = 'checkbox'
    if (change === 'expect') b.expect = { visible: { name: 'Result' } }
    if (change === 'ambiguous') b.target!.locators![0]!.unique = false
    expect(
      suggestCaptureCleanup([a, b]).some((item) => item.kind === 'merge'),
    ).toBe(false)
  })
  it('renames a vague title from an actual target without replacing an authored instruction', () => {
    const step = { ...click('a'), title: 'Click here' }
    expect(suggestCaptureCleanup([step])).toEqual([
      expect.objectContaining({
        kind: 'rename',
        title: 'Click "Plan"',
      }),
    ])
    expect(
      suggestCaptureCleanup([{ ...step, title: 'Open the workspace plan' }]),
    ).toEqual([])
    expect(suggestCaptureCleanup([{ ...step, target: undefined }])).toEqual([])
  })
  it('adds a check only from a meaningful recorded expectation and does not repeat an existing check', () => {
    const step = {
      ...click('a'),
      expect: { visible: { name: 'Plan changed' } },
    }
    const proposal = suggestCaptureCleanup([step])
    expect(proposal).toEqual([
      expect.objectContaining({
        kind: 'check',
        title: 'Verify "Plan changed" is visible',
      }),
    ])
    expect(
      suggestCaptureCleanup([
        step,
        stepSchema.parse({
          id: 'verified',
          index: 2,
          type: 'assert',
          title: 'Check',
          expect: step.expect,
        }),
      ]),
    ).toEqual([])
    expect(
      suggestCaptureCleanup([{ ...step, expect: { visible: {} } }]),
    ).toEqual([])
  })
  it('never reads values, image bytes or descriptions when proposing changes', () => {
    const step = { ...click('a'), title: 'Click here' }
    for (const key of [
      'value',
      'screenshot',
      'description',
      'notes',
      'edits',
      'redactions',
    ])
      Object.defineProperty(step, key, {
        get: () => {
          throw new Error('Private field read')
        },
      })
    expect(() => suggestCaptureCleanup([step])).not.toThrow()
    expect(
      suggestCaptureCleanup([step]).every(
        (item) => captureCleanupSuggestionSchema.safeParse(item).success,
      ),
    ).toBe(true)
  })
  it('respects the 500-step limit without suppressing available renames', () => {
    const steps = Array.from({ length: 500 }, (_, index) => ({
      ...click(`a-${index}`, index + 1),
      title: 'Click here',
      expect: { visible: { name: 'Done' } },
    }))
    expect(suggestCaptureCleanup(steps)).toHaveLength(500)
    expect(
      suggestCaptureCleanup(steps).every((item) => item.kind === 'rename'),
    ).toBe(true)
    expect(
      suggestCaptureCleanup(steps.slice(0, 499)).filter(
        (item) => item.kind === 'check',
      ),
    ).toHaveLength(1)
  })
  it('ignores manual sections, existing assertions and unsupported identities', () => {
    expect(
      suggestCaptureCleanup([
        stepSchema.parse({
          id: 'a',
          index: 1,
          type: 'manual',
          title: 'Click here',
        }),
        stepSchema.parse({
          id: 'b',
          index: 2,
          type: 'section',
          title: 'Click here',
        }),
        { ...click('x'.repeat(201)), title: 'Click here' },
      ]),
    ).toEqual([])
  })
})

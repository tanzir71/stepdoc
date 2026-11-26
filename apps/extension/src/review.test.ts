import { describe, expect, it } from 'vitest'
import {
  capturedGuide,
  editReview,
  suggestedTitle,
  type CaptureDraft,
} from './review'
import { stepSchema } from '@stepdoc/schema'
import {
  capturePreferencesSchema,
  reviewEditSchema,
} from '@stepdoc/schema/capture'

const draft = (): CaptureDraft => ({
  sessionId: '09cd3706-3fe8-4714-96d0-925f70868b66',
  startedAt: '2026-11-26T00:00:00Z',
  startedUrl: 'https://example.test/workflow',
  title: 'Capture',
  steps: [
    stepSchema.parse({
      id: 'a',
      index: 1,
      type: 'action',
      action: 'click',
      title: 'Open settings',
      target: { role: 'button', name: 'Settings' },
    }),
    stepSchema.parse({
      id: 'b',
      index: 2,
      type: 'action',
      action: 'fill',
      title: 'Fill email',
      value: { kind: 'secret', variable: 'field_2' },
    }),
    stepSchema.parse({
      id: 'c',
      index: 3,
      type: 'action',
      action: 'fill',
      title: 'Fill project',
      value: { kind: 'variable', variable: 'field_3' },
    }),
  ],
  images: [{ screenshot: 'a' }, { screenshot: 'b' }, { screenshot: 'c' }],
})
describe('capture review privacy and identity', () => {
  it('declares reference-only variables and stable capture identity', () => {
    const guide = capturedGuide(draft())
    expect(guide.id).toBe(`capture-${draft().sessionId}`)
    expect(guide.variables).toEqual([
      { name: 'field_2', kind: 'secret', type: 'string' },
      { name: 'field_3', kind: 'variable', type: 'string' },
    ])
    expect(guide.verification?.status).toBe('never-run')
    const input = {
      ...draft(),
      startedUrl:
        'https://user:password@example.test/workflow?private=value#secret',
    }
    expect(capturedGuide(input).preconditions).toEqual([
      'Open https://example.test/workflow',
    ])
  })
  it('keeps source image identity through deletion and reorder, renumbering indices only', () => {
    const input = draft()
    const deleted = editReview(input.steps, [...input.images], {
      operation: 'delete',
      ids: ['b'],
    })
    const moved = editReview(deleted.steps, deleted.images, {
      operation: 'move',
      id: 'c',
      direction: 'up',
    })
    expect(moved.steps.map((step) => [step.id, step.index])).toEqual([
      ['c', 1],
      ['a', 2],
    ])
    expect(moved.images.map((image) => image.screenshot)).toEqual(['c', 'a'])
    expect(input.steps[0]!.id).toBe('a')
    expect(
      capturedGuide({ ...input, steps: moved.steps }).variables.map(
        (variable) => variable.name,
      ),
    ).toEqual(['field_3'])
  })
  it('merges adjacent instructions explicitly as manual, retaining the first processed image', () => {
    const input = draft()
    const result = editReview(input.steps, [...input.images], {
      operation: 'merge',
      ids: ['a', 'b'],
    })
    expect(result.steps[0]).toMatchObject({
      type: 'manual',
      lowConfidence: true,
      description: '1. Open settings\n2. Fill email',
    })
    expect(result.steps[0]!.target).toBeUndefined()
    expect(result.steps[0]!.value).toBeUndefined()
    expect(result.images[0]!.screenshot).toBe('a')
  })
  it('rejects nonadjacent, duplicate, unknown or mismatched selections', () => {
    const input = draft()
    for (const ids of [
      ['a', 'c'],
      ['b', 'b'],
      ['a', 'missing'],
    ])
      expect(() =>
        editReview(input.steps, [...input.images], { operation: 'merge', ids }),
      ).toThrow()
    expect(() =>
      editReview(input.steps, [], { operation: 'delete', ids: ['a'] }),
    ).toThrow()
  })
  it('supports an empty review but refuses an empty saved guide', () => {
    const input = draft()
    const result = editReview(input.steps, [...input.images], {
      operation: 'delete',
      ids: ['a', 'b', 'c'],
    })
    expect(result.steps).toEqual([])
    expect(() => capturedGuide({ ...input, steps: [] })).toThrow()
  })
  it('uses an origin-only suggestion and strict bounded commands/preferences', () => {
    expect(
      suggestedTitle(
        'https://person:password@example.test/PRIVATE_TYPED?PRIVATE_QUERY#PRIVATE_FRAGMENT',
      ),
    ).toBe('Workflow on example.test')
    expect(capturePreferencesSchema.parse({})).toEqual({
      smartBlur: true,
      agentContext: true,
    })
    expect(() =>
      capturePreferencesSchema.parse({ typedValue: 'private' }),
    ).toThrow()
    expect(() =>
      reviewEditSchema.parse({ operation: 'title', title: ' '.repeat(10) }),
    ).toThrow()
    expect(() =>
      reviewEditSchema.parse({ operation: 'title', title: 'x'.repeat(201) }),
    ).toThrow()
  })
})

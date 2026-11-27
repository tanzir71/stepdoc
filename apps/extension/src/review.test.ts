import { describe, expect, it } from 'vitest'
import {
  capturedGuide,
  captureUploadGuide,
  editReview,
  suggestedTitle,
  type CaptureDraft,
} from './review'
import { stepSchema } from '@stepdoc/schema'
import { suggestCaptureCleanup } from '@stepdoc/core/cleanup'
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
  it('applies selected cleanup with paired pixels, original actions, notes and mask provenance', () => {
    const first = stepSchema.parse({
      id: 'one',
      index: 1,
      type: 'action',
      action: 'click',
      title: 'Click Plan',
      url: 'https://example.test/',
      target: {
        name: 'Plan',
        role: 'button',
        locators: [{ strategy: 'css', value: '#plan', unique: true }],
      },
      notes: 'First note',
    })
    const third = stepSchema.parse({
      ...first,
      id: 'three',
      index: 3,
      title: 'Click here',
      expect: { visible: { name: 'Done' } },
      notes: 'Keep this note',
      redactions: [
        {
          kind: 'field',
          source: 'auto',
          status: 'applied',
          rect: { x: 1, y: 2, width: 3, height: 4 },
        },
      ],
    })
    const steps = [first, { ...first, id: 'two', index: 2 }, third]
    const images = [
      { screenshot: 'first' },
      { screenshot: 'second' },
      { screenshot: 'third' },
    ]
    const result = editReview(steps, images, {
      operation: 'cleanup',
      ids: suggestCaptureCleanup(steps).map((item) => item.id),
    })
    expect(result.steps.map((step) => [step.type, step.index])).toEqual([
      ['manual', 1],
      ['action', 2],
      ['assert', 3],
    ])
    expect(result.steps[0]).toMatchObject({
      lowConfidence: true,
      notes: 'First note\nFirst note',
    })
    expect(result.steps[1]).toMatchObject({
      id: 'three',
      title: 'Click "Plan"',
      action: 'click',
      notes: 'Keep this note',
      expect: third.expect,
      redactions: third.redactions,
    })
    expect(result.steps[2]).toMatchObject({
      action: 'assert',
      expect: third.expect,
      redactions: third.redactions,
    })
    expect(result.images.map((image) => image.screenshot)).toEqual([
      'first',
      'third',
      'third',
    ])
    expect(new Set(result.steps.map((step) => step.id)).size).toBe(3)
    expect(suggestCaptureCleanup(result.steps)).toEqual([])
    expect(steps).toHaveLength(3)
    expect(third.title).toBe('Click here')
  })
  it('rejects a stale, repeated or forged cleanup selection without mutating its inputs', () => {
    const input = draft(),
      before = structuredClone(input)
    for (const ids of [['missing'], ['rename-1', 'rename-1']])
      expect(() =>
        editReview(input.steps, [...input.images], {
          operation: 'cleanup',
          ids,
        }),
      ).toThrow()
    expect(input).toEqual(before)
  })
  it('applies only selected proposals and keeps secret input references unchanged', () => {
    const input = draft()
    input.steps[1]!.title = 'Describe this step'
    input.steps[1]!.target = { role: 'textbox', name: 'Email' }
    const result = editReview(input.steps, [...input.images], {
      operation: 'cleanup',
      ids: ['rename-2'],
    })
    expect(result.steps[1]).toMatchObject({
      action: 'fill',
      title: 'Fill in the "Email" field',
      value: { kind: 'secret', variable: 'field_2' },
    })
    expect(result.images).toEqual(input.images)
  })
  it('rejects incomplete or invalid upload drafts before processing source pixels', async () => {
    await expect(
      captureUploadGuide({ ...draft(), images: [] }),
    ).rejects.toMatchObject({ code: 'invalid_guide' })
    await expect(
      captureUploadGuide({ ...draft(), sessionId: 'not-a-uuid' }),
    ).rejects.toMatchObject({ code: 'invalid_guide' })
    await expect(captureUploadGuide(draft())).rejects.toMatchObject({
      code: 'invalid_blob',
    })
  })
  it('blocks unresolved redactions before producing an upload payload', async () => {
    const input = draft()
    input.steps[0]!.redactions.push({
      kind: 'field',
      source: 'auto',
      status: 'open',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    })
    await expect(captureUploadGuide(input)).rejects.toMatchObject({
      code: 'redaction_open',
    })
  })
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
      voiceNarration: false,
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

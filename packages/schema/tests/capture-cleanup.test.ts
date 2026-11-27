import { describe, expect, it } from 'vitest'
import {
  captureCleanupSuggestionSchema,
  reviewEditSchema,
} from '../src/capture'

describe('private capture cleanup contract', () => {
  it('accepts a bounded display-only proposal and an ID-only application', () => {
    expect(
      captureCleanupSuggestionSchema.parse({
        id: 'rename-1',
        kind: 'rename',
        stepIds: ['step'],
        title: 'Click Plan',
        summary: 'Rename step 1.',
      }).kind,
    ).toBe('rename')
    expect(
      reviewEditSchema.parse({ operation: 'cleanup', ids: ['rename-1'] }),
    ).toEqual({
      operation: 'cleanup',
      ids: ['rename-1'],
    })
  })
  it('rejects client-authored patches, raw images and unknown fields', () => {
    expect(
      reviewEditSchema.safeParse({
        operation: 'cleanup',
        ids: ['rename-1'],
        title: 'Injected',
      }).success,
    ).toBe(false)
    expect(
      captureCleanupSuggestionSchema.safeParse({
        id: 'rename-1',
        kind: 'rename',
        stepIds: ['step'],
        title: 'Plan',
        summary: 'Rename.',
        screenshot: 'pixels',
      }).success,
    ).toBe(false)
  })
  it('rejects empty and oversized selections and suggestions', () => {
    for (const ids of [[], Array(501).fill('rename-1'), ['x'.repeat(33)]])
      expect(
        reviewEditSchema.safeParse({ operation: 'cleanup', ids }).success,
      ).toBe(false)
    expect(
      captureCleanupSuggestionSchema.safeParse({
        id: 'rename-1',
        kind: 'rename',
        stepIds: ['step'],
        title: 'Plan',
        summary: 'x'.repeat(501),
      }).success,
    ).toBe(false)
  })
})

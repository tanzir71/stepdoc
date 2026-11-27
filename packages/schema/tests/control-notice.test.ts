import { describe, expect, it } from 'vitest'
import { captureNoticeSchema } from '../src/capture'

describe('bounded capture notifications', () => {
  it('accepts an invalidation without a storage change body', () => {
    expect(captureNoticeSchema.parse({ type: 'CAPTURE_CHANGED' })).toEqual(
      { type: 'CAPTURE_CHANGED' },
    )
  })
  it('bounds the optional terminal guide result with the guide ID contract', () => {
    const notice = captureNoticeSchema.parse({
      type: 'CAPTURE_CHANGED',
      guideResult: { guideId: 'a'.repeat(81), saved: false },
    })
    expect(
      new TextEncoder().encode(JSON.stringify(notice)).length,
    ).toBeLessThan(256)
  })
  it('rejects image, storage and unknown result fields', () => {
    for (const extra of ['steps', 'pendingSession', 'screenshots'])
      expect(
        captureNoticeSchema.safeParse({
          type: 'CAPTURE_CHANGED',
          [extra]: 'PRIVATE_IMAGE',
        }).success,
      ).toBe(false)
    expect(
      captureNoticeSchema.safeParse({
        type: 'CAPTURE_CHANGED',
        guideResult: {
          guideId: 'notice-guide',
          saved: true,
          image: 'PRIVATE_IMAGE',
        },
      }).success,
    ).toBe(false)
  })
  it('rejects invalid IDs, non-boolean results and other protocols', () => {
    expect(
      captureNoticeSchema.safeParse({
        type: 'CAPTURE_CHANGED',
        guideResult: { guideId: 'a'.repeat(82), saved: true },
      }).success,
    ).toBe(false)
    expect(
      captureNoticeSchema.safeParse({
        type: 'CAPTURE_CHANGED',
        guideResult: { guideId: 'notice-guide', saved: 'true' },
      }).success,
    ).toBe(false)
    expect(captureNoticeSchema.safeParse({ type: 'STATE' }).success).toBe(
      false,
    )
  })
})

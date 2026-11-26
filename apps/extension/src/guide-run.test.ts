import { describe, expect, it } from 'vitest'
import { guideSchema } from '@stepdoc/schema'
import {
  guideMeControlSchema,
  guideMeMatchSchema,
  guideMeStepSchema,
} from '@stepdoc/schema/guide-me'
import { newGuideRun, advanceGuide, guideReport } from './guide-run'

function run() {
  return newGuideRun(
    guideSchema.parse({
      schema: 'stepdoc/guide@1',
      id: 'guide-test',
      title: 'Walkthrough',
      version: 1,
      createdAt: '2026-11-26T00:00:00Z',
      updatedAt: '2026-11-26T00:00:00Z',
      steps: [
        {
          id: 'one',
          index: 1,
          type: 'action',
          action: 'click',
          title: 'Save',
          screenshot: { rendered: 'blobs/private.png', width: 20, height: 20 },
        },
        { id: 'two', index: 2, type: 'manual', title: 'Confirm' },
      ],
    }),
    1,
  )
}
describe('walkthrough state and privacy protocol', () => {
  it('projects a stable guide version without screenshots or unrelated metadata', () => {
    const value = run()
    expect(value.version).toBe(1)
    expect(value.steps[0]).not.toHaveProperty('screenshot')
    expect(JSON.stringify(value)).not.toContain('blobs/private')
  })
  it('reports completed interactions and explicit confirmations with the correct runner', () => {
    const value = advanceGuide(advanceGuide(run(), 'matched'), 'confirmed')
    expect(value.phase).toBe('saving')
    expect(guideReport(value)).toMatchObject({
      status: 'passed',
      runner: 'guide-me',
    })
  })
  it('reports the first skipped or incomplete step instead of a false pass', () => {
    expect(guideReport(run())).toMatchObject({
      status: 'failed',
      failedStep: 1,
    })
    expect(
      guideReport(advanceGuide(advanceGuide(run(), 'skipped'), 'matched')),
    ).toMatchObject({ status: 'failed', failedStep: 1 })
  })
  it('increments the sequence without mutating the previous state', () => {
    const initial = run(),
      next = advanceGuide(initial, 'matched')
    expect(initial.index).toBe(0)
    expect(next.index).toBe(1)
    expect(next.sequence).toBe(1)
  })
  it('rejects private input fields, missing references, forged counters and unknown actions', () => {
    expect(() =>
      guideMeStepSchema.parse({
        id: 'x',
        index: 1,
        type: 'action',
        action: 'fill',
        title: 'Fill',
        value: { kind: 'literal', literal: 'PRIVATE' },
      }),
    ).toThrow()
    expect(() =>
      guideMeControlSchema.parse({
        type: 'GUIDE_CONTROL',
        runId: run().runId,
        sequence: 0,
        action: 'execute-script',
      }),
    ).toThrow()
    expect(() =>
      guideMeMatchSchema.parse({
        type: 'GUIDE_MATCH',
        runId: run().runId,
        sequence: -1,
        documentId: run().runId,
        token: run().runId,
        value: 'PRIVATE',
      }),
    ).toThrow()
  })
})

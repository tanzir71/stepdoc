import { describe, expect, it } from 'vitest'
import { stepSchema } from '@stepdoc/schema'
import {
  capturePreviewCommandSchema,
  MAX_CAPTURE_CONTROL_BYTES,
} from '@stepdoc/schema/capture'
import type { LegacyStorage } from './background'
import {
  captureControls,
  captureSourceState,
  captureSourceMessage,
} from './capture-controls'
import { newGuideRun } from './guide-run'
import { guideSchema } from '@stepdoc/schema'

const sessionId = '12345678-1234-4234-8234-123456789abc'
const action = () =>
  stepSchema.parse({
    id: 'field',
    index: 1,
    type: 'action',
    action: 'fill',
    title: 'Enter email',
    value: { kind: 'secret', variable: 'invoice_email' },
    target: {
      role: 'textbox',
      name: 'Email',
      locators: [{ strategy: 'css', value: '#PRIVATE_LOCATOR' }],
    },
    screenshot: { rendered: 'PRIVATE_PIXELS', width: 1800, height: 1800 },
    redactions: [
      {
        kind: 'field',
        source: 'auto',
        status: 'applied',
        rect: { x: 1, y: 1, width: 10, height: 10 },
      },
    ],
    notes: 'Client-redacted narration',
  })
function state(): LegacyStorage {
  return {
    recording: true,
    captureSessionId: sessionId,
    captureTabId: 10,
    captureBlurMode: true,
    captureManualCount: 2,
    captureReview: {
      phase: 'recording',
      revision: 3,
      title: 'Workflow',
      clock: { elapsedMs: 100, runningSince: 200 },
      preferences: {
        smartBlur: true,
        agentContext: true,
        voiceNarration: false,
      },
    },
    capturedSteps: [action()],
  }
}
describe('bounded private capture controls', () => {
  it('never reads retained images and exposes only display metadata and a retry flag', () => {
    const raw = state()
    Object.defineProperty(raw, 'steps', {
      enumerable: true,
      get: () => {
        throw new Error('Full pixels read')
      },
    })
    raw.pendingSession = {
      title: 'Retry',
      description: '',
      steps: [
        {
          toJSON: () => {
            throw new Error('Retry body serialized')
          },
        },
      ],
    }
    const view = captureControls(raw)
    expect(view.pendingSession).toBe(true)
    expect(view.capturedSteps).toEqual([
      {
        id: 'field',
        index: 1,
        type: 'action',
        action: 'fill',
        title: 'Enter email',
        notes: 'Client-redacted narration',
        targetRole: 'textbox',
        valueKind: 'secret',
        variable: 'invoice_email',
        maskCount: 1,
        lowConfidence: false,
      },
    ])
    const wire = JSON.stringify(view)
    expect(wire).not.toContain('PRIVATE_')
    expect(wire).not.toContain('locators')
    expect(wire).not.toContain('screenshot')
    expect(wire.length).toBeLessThan(2000)
  })
  it('preserves full display notes, flags, order and literal kind without copying a literal value', () => {
    const raw = state()
    const first = action()
    first.notes = 'n'.repeat(12000)
    first.lowConfidence = true
    const second = stepSchema.parse({
      id: 'option',
      index: 2,
      type: 'action',
      action: 'select',
      title: 'Choose plan',
      value: { kind: 'literal', literal: 'PRIVATE_OPTION' },
    })
    raw.capturedSteps = [second, first]
    const view = captureControls(raw)
    expect(view.capturedSteps?.map((step) => step.id)).toEqual([
      'option',
      'field',
    ])
    expect(view.capturedSteps?.[1]?.notes).toBe(first.notes)
    expect(view.capturedSteps?.[1]?.lowConfidence).toBe(true)
    expect(view.capturedSteps?.[0]?.valueKind).toBe('literal')
    expect(JSON.stringify(view)).not.toContain('PRIVATE_OPTION')
  })
  it('removes unknown nested state while retaining optimistic save and destination metadata', () => {
    const raw = state()
    const server = {
      kind: 'server' as const,
      server: 'http://localhost/tools/api/v1/',
      deviceId: 'device',
      generation: sessionId,
      privateImage: 'PRIVATE_PIXELS',
    }
    raw.captureDestination = server
    raw.captureReview = {
      ...raw.captureReview,
      destination: server,
      remoteAttempt: server,
      remoteSaved: { id: 'capture', destination: server },
    }
    Object.assign(raw.captureReview, { privatePayload: 'PRIVATE_REVIEW' })
    Object.assign(raw.captureReview.preferences!, {
      privatePayload: 'PRIVATE_PREF',
    })
    Object.assign(raw.captureReview.clock!, { privatePayload: 'PRIVATE_CLOCK' })
    const view = captureControls(raw)
    expect(view.captureReview?.revision).toBe(3)
    expect(view.captureReview?.remoteSaved?.destination.deviceId).toBe('device')
    expect(view.captureReview?.clock).toEqual({
      elapsedMs: 100,
      runningSince: 200,
    })
    expect(JSON.stringify(view)).not.toContain('PRIVATE_')
  })
  it('projects Guide Me titles and progress without its private locators, values or receipts', () => {
    const raw = state()
    raw.guideMe = newGuideRun(
      guideSchema.parse({
        schema: 'stepdoc/guide@1',
        version: 1,
        id: 'guide',
        title: 'Walkthrough',
        createdAt: '2026-11-27T00:00:00Z',
        updatedAt: '2026-11-27T00:00:00Z',
        steps: [action()],
        variables: [{ name: 'invoice_email', kind: 'secret' }],
      }),
      10,
    )
    const view = captureControls(raw)
    expect(view.guideMe?.steps).toEqual([{ id: 'field', title: 'Enter email' }])
    expect(view.guideMe?.target).toEqual({ reason: 'missing' })
    expect(view.capturedSteps).toEqual([])
    expect(JSON.stringify(view)).not.toContain('PRIVATE_')
    expect(JSON.stringify(view)).not.toContain('invoice_email')
  })
  it('rejects an oversized metadata response before the runtime serializer receives it', () => {
    const raw = state()
    raw.capturedSteps![0]!.notes = '\0'.repeat(
      Math.ceil(MAX_CAPTURE_CONTROL_BYTES / 6),
    )
    expect(() => captureControls(raw)).toThrow('Capture controls unavailable')
    expect(raw.recording).toBe(true)
  })
  it('handles all 500 rows without exporting large per-step masks, edits or images', () => {
    const raw = state()
    raw.capturedSteps = Array.from({ length: 500 }, (_, index) => ({
      ...action(),
      id: `field-${index}`,
      index: index + 1,
    }))
    const view = captureControls(raw)
    expect(view.capturedSteps).toHaveLength(500)
    expect(
      new TextEncoder().encode(JSON.stringify(view)).byteLength,
    ).toBeLessThan(200000)
  })
})
describe('source recorder projection', () => {
  it('arms the selected producer without reading or serializing retained pixels or private step context', () => {
    const raw = state()
    Object.defineProperty(raw, 'steps', {
      get: () => {
        throw new Error('Retained image read')
      },
    })
    Object.defineProperty(raw.capturedSteps![0]!, 'screenshot', {
      get: () => {
        throw new Error('Step image read')
      },
    })
    const message = captureSourceMessage(raw, 10)
    expect(message.recording).toBe(true)
    expect(message.sessionId).toBe(sessionId)
    expect(message.stepCount).toBe(1)
    const wire = JSON.stringify(message)
    expect(wire).not.toContain('PRIVATE_')
    expect(wire).not.toContain('locators')
    expect(wire).not.toContain('notes')
    expect(wire.length).toBeLessThan(2000)
    const other = captureSourceMessage(raw, 20)
    expect(other.recording).toBe(false)
    expect(other.sessionId).toBeUndefined()
    expect(other.capturePill).toBeNull()
  })
  it('returns inert bounded state for corrupt recorder identities or counts', () => {
    for (const invalid of [
      { captureSessionId: 'PRIVATE_INVALID' },
      { captureManualCount: Infinity },
    ]) {
      const view = captureSourceState({ ...state(), ...invalid }, 10)
      expect(view.recording).toBe(false)
      expect(view.capturePill).toBe(null)
      expect(JSON.stringify(view)).not.toContain('PRIVATE_')
      expect(JSON.stringify(view).length).toBeLessThan(256)
    }
  })
  it('returns only the selected source recorder fields with its safe pill', () => {
    const raw = state()
    const view = captureSourceState(raw, 10)
    expect(view).toEqual({
      recording: true,
      paused: false,
      producerStopped: false,
      captureSessionId: sessionId,
      captureBlurMode: true,
      captureManualCount: 2,
      stepCount: 1,
      capturePill: {
        sessionId,
        phase: 'recording',
        count: 1,
        clock: { elapsedMs: 100, runningSince: 200 },
      },
    })
    expect(JSON.stringify(view)).not.toContain('Enter email')
    expect(JSON.stringify(view)).not.toContain('PRIVATE_')
  })
  it.each([undefined, 11])(
    'does not expose another tab capture to source %s',
    (tabId) => {
      const view = captureSourceState(state(), tabId)
      expect(view).toEqual({
        recording: false,
        paused: false,
        producerStopped: false,
        captureSessionId: undefined,
        captureBlurMode: false,
        captureManualCount: 0,
        stepCount: 0,
        capturePill: null,
      })
    },
  )
  it.each(['pausing', 'paused', 'stopping'] as const)(
    'retains the %s producer barrier',
    (phase) => {
      const raw = state()
      raw.captureReview!.phase = phase
      expect(captureSourceState(raw, 10).paused).toBe(true)
      expect(captureSourceState(raw, 10).producerStopped).toBe(
        phase !== 'paused',
      )
    },
  )
  it('validates preview recovery as a strict session/step command with no pixel payload', () => {
    const command = { type: 'CAPTURE_PREVIEW', sessionId, stepId: 'field' }
    expect(capturePreviewCommandSchema.safeParse(command).success).toBe(true)
    expect(
      capturePreviewCommandSchema.safeParse({
        ...command,
        screenshot: 'PRIVATE_PIXELS',
      }).success,
    ).toBe(false)
    expect(
      capturePreviewCommandSchema.safeParse({ ...command, sessionId: 'stale' })
        .success,
    ).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  FRAME_PROBE,
  CAPTURE_TRANSPORT,
  frameProbeSchema,
  frameSnapshotSchema,
  localCaptureSchema,
} from './capture'
import { stepSchema } from './guide'

const uuid = () => crypto.randomUUID()
describe('ephemeral capture transport (separate from guide@1)', () => {
  it('accepts metadata-only local events from inherited frames', () => {
    const step = stepSchema.parse({
      id: uuid(),
      index: 1,
      type: 'action',
      action: 'fill',
      title: 'Fill Email',
      value: { kind: 'secret', variable: 'field_1' },
      target: { frame: [] },
      url: null,
    })
    const event = {
      schema: CAPTURE_TRANSPORT,
      documentId: uuid(),
      step,
      topUrl: null,
      devicePixelRatio: 2,
      viewport: { width: 300, height: 200 },
      inputType: 'email',
    }
    expect(localCaptureSchema.parse(event)).toEqual(event)
    expect(
      localCaptureSchema.safeParse({ ...event, value: 'PRIVATE_TYPED' })
        .success,
    ).toBe(false)
    expect(
      localCaptureSchema.safeParse({ ...event, inputType: 'PRIVATE_TYPED' })
        .success,
    ).toBe(false)
    expect(
      localCaptureSchema.safeParse({
        ...event,
        step: { ...step, value: { kind: 'literal', literal: 'PRIVATE_TYPED' } },
      }).success,
    ).toBe(false)
  })
  it('permits no identity, text or other page data in window probes', () => {
    const probe = { type: FRAME_PROBE, nonce: uuid(), token: uuid() }
    expect(frameProbeSchema.parse(probe)).toEqual(probe)
    for (const property of ['frameId', 'documentId', 'text', 'value', 'url'])
      expect(
        frameProbeSchema.safeParse({ ...probe, [property]: 'PRIVATE' }).success,
      ).toBe(false)
  })
  it('requires bounded, finite, versioned frame snapshots', () => {
    const frame = {
      schema: CAPTURE_TRANSPORT,
      nonce: uuid(),
      documentId: uuid(),
      url: null,
      parentSelector: null,
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 1,
      revision: 0,
      children: [],
      masks: [],
      geometryMotion: false,
    }
    expect(frameSnapshotSchema.parse(frame)).toEqual(frame)
    expect(
      frameSnapshotSchema.safeParse({
        ...frame,
        viewport: { width: Infinity, height: 2 },
      }).success,
    ).toBe(false)
    expect(
      frameSnapshotSchema.safeParse({ ...frame, devicePixelRatio: 9 }).success,
    ).toBe(false)
    expect(
      frameSnapshotSchema.safeParse({ ...frame, revision: -1 }).success,
    ).toBe(false)
    expect(
      frameSnapshotSchema.safeParse({ ...frame, schema: 'stepdoc/capture@0' })
        .success,
    ).toBe(false)
  })
})

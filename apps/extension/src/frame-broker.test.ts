import { describe, expect, it } from 'vitest'
import type { FrameSnapshot, LocalCapture } from '@stepdoc/schema/capture'
import { FRAME_PROBE, CAPTURE_TRANSPORT } from '@stepdoc/schema/capture'
import {
  FrameBroker,
  FrameSceneChangedError,
  withStableFrameScene,
  type BrowserFrame,
  type FrameTransport,
} from './frame-broker'
import { contextualStep, legacyMeta } from './capture-context'
import { stepSchema } from '@stepdoc/schema'

const id = () => crypto.randomUUID()
function snapshot(): FrameSnapshot {
  return {
    schema: CAPTURE_TRANSPORT,
    nonce: id(),
    documentId: id(),
    url: 'https://fixture.test/page',
    parentSelector: null,
    viewport: { width: 800, height: 600 },
    devicePixelRatio: 2,
    revision: 0,
    children: [],
    masks: [],
    geometryMotion: false,
  }
}
function fixture() {
  const top = snapshot(),
    child = snapshot(),
    grandchild = snapshot()
  const token = id(),
    nested = id()
  top.children.push({
    token,
    selector: '#outer',
    outer: { x: 90, y: 40, width: 420, height: 320 },
    content: { x: 100, y: 50, width: 400, height: 300 },
    precise: true,
  })
  child.url = 'https://other.test/frame'
  child.viewport = { width: 200, height: 150 }
  child.children.push({
    token: nested,
    selector: '#inner',
    outer: { x: 8, y: 8, width: 104, height: 54 },
    content: { x: 10, y: 10, width: 100, height: 50 },
    precise: true,
  })
  grandchild.url = null
  grandchild.viewport = { width: 100, height: 50 }
  grandchild.masks.push({
    kind: 'field',
    source: 'auto',
    rule: 'form-value',
    status: 'applied',
    rect: { x: -10, y: 5, width: 50, height: 20 },
  })
  const frames: BrowserFrame[] = [
    { frameId: 0, parentFrameId: -1, documentId: 'browser-top' },
    { frameId: 4, parentFrameId: 0, documentId: 'browser-child' },
    { frameId: 9, parentFrameId: 4, documentId: 'browser-grandchild' },
  ]
  const snapshots = new Map([
    [0, top],
    [4, child],
    [9, grandchild],
  ])
  let broker: FrameBroker
  const io: FrameTransport = {
    frames: async () => frames,
    send: async (tabId, frameId, raw) => {
      const message = raw as {
        type: string
        nonce: string
        tokens?: string[]
      }
      if (message.type === 'FRAME_SNAPSHOT')
        return { ...snapshots.get(frameId), nonce: message.nonce }
      for (const probeToken of message.tokens ?? []) {
        const childId = probeToken === token ? 4 : 9
        broker.link(
          {
            type: FRAME_PROBE,
            nonce: message.nonce,
            token: probeToken,
            documentId: snapshots.get(childId)!.documentId,
          },
          tabId,
          childId,
          frames.find((frame) => frame.frameId === childId)!.documentId,
        )
      }
      return { ok: true }
    },
  }
  broker = new FrameBroker(io)
  return { broker, io, frames, snapshots, top, child, grandchild, token }
}
describe('authenticated frame collection', () => {
  it('maps nested cross-origin geometry, clipping and inherited URL without frame-order guesses', async () => {
    const f = fixture(),
      scene = await f.broker.collect(1)
    expect(scene.contexts.get(f.grandchild.documentId)).toMatchObject({
      frame: ['#outer', '#inner'],
      url: 'https://other.test/frame',
      topUrl: f.top.url,
      transform: { x: 120, y: 70, sx: 2, sy: 2 },
    })
    expect(scene.masks).toEqual([
      {
        kind: 'field',
        source: 'auto',
        rule: 'form-value',
        status: 'applied',
        rect: { x: 120, y: 80, width: 80, height: 40 },
      },
    ])
    expect(scene.frameIds.get(f.grandchild.documentId)).toBe(9)
  })
  it('maps local click pixels once and preserves v1 secret hints', async () => {
    const f = fixture(),
      scene = await f.broker.collect(1)
    const event: LocalCapture = {
      schema: CAPTURE_TRANSPORT,
      documentId: f.grandchild.documentId,
      step: stepSchema.parse({
        id: 'action',
        index: 1,
        type: 'action',
        action: 'fill',
        title: 'Fill',
        value: { kind: 'secret', variable: 'field_1' },
        target: { name: 'Email', frame: [] },
        click: { x: 40, y: 20, radius: 36 },
        url: null,
      }),
      topUrl: null,
      devicePixelRatio: 2,
      viewport: f.grandchild.viewport,
      inputType: 'email',
    }
    const step = contextualStep(event, scene)
    expect(step.click).toEqual({ x: 320, y: 180, radius: 36 })
    expect(step.target?.frame).toEqual(['#outer', '#inner'])
    expect(legacyMeta(step, event, scene)).toMatchObject({
      inputType: 'email',
      click: { x: 160, y: 90 },
      viewport: f.top.viewport,
    })
  })
  it('does not expose click coordinates outside ancestor clip', async () => {
    const f = fixture(),
      scene = await f.broker.collect(1)
    const event: LocalCapture = {
      schema: CAPTURE_TRANSPORT,
      documentId: f.grandchild.documentId,
      step: stepSchema.parse({
        id: 'click',
        index: 1,
        type: 'action',
        action: 'click',
        title: 'Click',
        click: { x: -20, y: 10 },
      }),
      topUrl: null,
      devicePixelRatio: 1,
      viewport: f.grandchild.viewport,
    }
    expect(contextualStep(event, scene)).toMatchObject({
      click: null,
      lowConfidence: true,
    })
  })
  it('accepts same-origin structural identity without page messages', async () => {
    const f = fixture()
    f.child.parentSelector = '#outer'
    f.grandchild.parentSelector = '#inner'
    const original = f.io.send
    f.io.send = async (...args) => {
      expect((args[2] as { type: string }).type).toBe('FRAME_SNAPSHOT')
      return original(...args)
    }
    expect((await f.broker.collect(1)).contexts.size).toBe(3)
  })
  it.each(['tab', 'frame', 'document', 'token', 'nonce', 'uuid'])(
    'rejects forged %s probes and masks unresolved contexts',
    async (mode) => {
      const f = fixture(),
        original = f.io.send
      f.io.send = async (tabId, frameId, raw) => {
        const message = raw as {
          type: string
          nonce: string
          tokens?: string[]
        }
        if (message.type === 'FRAME_SNAPSHOT')
          return original(tabId, frameId, raw)
        for (const token of message.tokens ?? []) {
          const childId = token === f.token ? 4 : 9
          expect(
            f.broker.link(
              {
                type: FRAME_PROBE,
                nonce: mode === 'nonce' ? id() : message.nonce,
                token: mode === 'token' ? id() : token,
                documentId:
                  mode === 'uuid'
                    ? id()
                    : f.snapshots.get(childId)!.documentId,
              },
              mode === 'tab' ? 99 : tabId,
              mode === 'frame' ? 99 : childId,
              mode === 'document'
                ? 'wrong'
                : f.frames.find((frame) => frame.frameId === childId)!
                    .documentId,
            ),
          ).toBe(false)
        }
        return { ok: true }
      }
      const scene = await f.broker.collect(1)
      expect(scene.contexts.size).toBe(1)
      expect(
        scene.masks.some((mask) => mask.rule === 'frame-unavailable'),
      ).toBe(true)
    },
  )
  it('keeps unknown receivers opaque and fails on explicit collector errors', async () => {
    const f = fixture(),
      original = f.io.send
    f.io.send = async (tab, frame, message) => {
      if (frame === 4) throw new Error('No receiver')
      return original(tab, frame, message)
    }
    expect(
      (await f.broker.collect(1)).masks.some(
        (mask) => mask.rect.width === 800,
      ),
    ).toBe(true)
    f.io.send = async (tab, frame, message) =>
      frame === 4
        ? { ok: false, error: 'private-data-must-not-escape' }
        : original(tab, frame, message)
    await expect(f.broker.collect(1)).rejects.toThrow(
      /^Frame metadata unavailable$/,
    )
  })
  it('fails closed on document replacement during collection', async () => {
    const f = fixture()
    let reads = 0
    f.io.frames = async () =>
      ++reads === 1
        ? f.frames
        : f.frames.map((frame) => ({ ...frame, documentId: 'replaced' }))
    await expect(f.broker.collect(1)).rejects.toBeInstanceOf(
      FrameSceneChangedError,
    )
  })
  it.each(['missing receiver', 'collector error'] as const)(
    'restarts the whole operation when a document is replaced before a %s response',
    async (failure) => {
      const f = fixture(),
        original = f.io.send
      f.io.frames = async () => f.frames.map((frame) => ({ ...frame }))
      let replaced = false,
        attempts = 0
      const current = id()
      f.io.send = async (tab, frame, message) => {
        if (
          frame === 0 &&
          !replaced &&
          (message as { type: string }).type === 'FRAME_SNAPSHOT'
        ) {
          replaced = true
          f.frames[0]!.documentId = 'replacement-browser-document'
          f.top.documentId = current
          if (failure === 'missing receiver')
            throw new Error('Old document receiver closed')
          return { ok: false, error: 'Old document collector stopped' }
        }
        return original(tab, frame, message)
      }
      const result = await withStableFrameScene(async () => {
        const candidate = ++attempts
        const scene = await f.broker.collect(1)
        return { candidate, scene }
      })
      expect(result.candidate).toBe(2)
      expect(result.scene.top.documentId).toBe(current)
      expect(result.scene.masks.length).toBeGreaterThan(0)
    },
  )
  it('restarts the entire operation after a changed graph without returning its first candidate', async () => {
    let calls = 0
    const result = await withStableFrameScene(async () => {
      if (++calls === 1) throw new FrameSceneChangedError()
      return { processed: true, candidate: calls }
    })
    expect(result).toEqual({ processed: true, candidate: 2 })
  })
  it('does not retry missing or invalid metadata', async () => {
    let calls = 0
    const error = new Error('Frame metadata unavailable')
    await expect(
      withStableFrameScene(async () => {
        calls++
        throw error
      }),
    ).rejects.toBe(error)
    expect(calls).toBe(1)
  })
  it('bounds repeated graph changes to three complete attempts', async () => {
    let calls = 0
    await expect(
      withStableFrameScene(async () => {
        calls++
        throw new FrameSceneChangedError()
      }),
    ).rejects.toBeInstanceOf(FrameSceneChangedError)
    expect(calls).toBe(3)
  })
  it('treats rotated/negative-scale and animated contexts as opaque', async () => {
    const f = fixture()
    f.top.children[0]!.precise = false
    expect((await f.broker.collect(1)).contexts.size).toBe(1)
    f.top.children[0]!.precise = true
    f.child.geometryMotion = true
    const scene = await f.broker.collect(1)
    expect(scene.contexts.get(f.child.documentId)?.precise).toBe(false)
    expect(
      scene.masks.some((mask) => mask.rule === 'animated-geometry'),
    ).toBe(true)
  })
  it('changes the stability signature for scroll/layout/mutation and preserves it across nonce changes', async () => {
    const f = fixture(),
      a = await f.broker.collect(1),
      b = await f.broker.collect(1)
    expect(a.signature).toBe(b.signature)
    f.child.revision++
    expect((await f.broker.collect(1)).signature).not.toBe(a.signature)
    f.child.revision--
    f.top.children[0]!.content.x++
    expect((await f.broker.collect(1)).signature).not.toBe(a.signature)
  })
  it.each(['frames', 'masks', 'unsafe-url', 'non-finite'])(
    'rejects %s limits/data without reflecting input',
    async (mode) => {
      const f = fixture()
      if (mode === 'frames')
        f.frames.push(
          ...Array.from({ length: 129 }, (_, index) => ({
            frameId: index + 20,
            parentFrameId: 0,
          })),
        )
      if (mode === 'masks')
        f.child.masks = Array.from(
          { length: 12_001 },
          () => f.grandchild.masks[0]!,
        )
      if (mode === 'unsafe-url')
        f.child.url = 'https://private.test/?PRIVATE_TOKEN'
      if (mode === 'non-finite') f.top.children[0]!.content.x = Infinity
      await expect(f.broker.collect(1)).rejects.toThrow(
        /^Frame metadata unavailable$/,
      )
    },
  )
})

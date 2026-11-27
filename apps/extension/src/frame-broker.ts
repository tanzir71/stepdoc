import type { Rect, Redaction } from '@stepdoc/schema'
import {
  FRAME_LIMITS,
  FRAME_PROBE,
  frameSnapshotSchema,
  frameLinkSchema,
  type FrameSnapshot,
  type FrameLink,
} from '@stepdoc/schema/capture'
import {
  identityTransform,
  childTransform,
  transformRect,
  intersectRects,
  type FrameContext,
} from '@stepdoc/core/capture/geometry'

export interface BrowserFrame {
  frameId: number
  parentFrameId: number
  documentId?: string
}
export interface FrameTransport {
  frames(tabId: number): Promise<BrowserFrame[]>
  send(tabId: number, frameId: number, message: unknown): Promise<unknown>
}
export interface FrameScene {
  signature: string
  top: FrameSnapshot
  contexts: Map<string, FrameContext>
  frameIds: Map<string, number>
  masks: Redaction[]
}
const failure = () => new Error('Frame metadata unavailable')
const graph = (items: BrowserFrame[]) =>
  JSON.stringify(
    [...items]
      .sort((a, b) => a.frameId - b.frameId)
      .map(({ frameId, parentFrameId, documentId }) => ({
        frameId,
        parentFrameId,
        documentId,
      })),
  )
export class FrameSceneChangedError extends Error {
  constructor() {
    super('Frame metadata unavailable')
    this.name = 'FrameSceneChangedError'
  }
}
/** Retry the whole before/image/after operation, never a partial scene or raw image. */
export async function withStableFrameScene<T>(
  capture: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await capture()
    } catch (error) {
      if (!(error instanceof FrameSceneChangedError) || attempt === 3)
        throw error
    }
  }
}
const policy = (rect: Rect, rule: string): Redaction => ({
  kind: 'field',
  source: 'policy',
  rule,
  rect,
  status: 'applied',
})

/** Parent identities come from webNavigation, never page-provided frame IDs or
 * matching src URLs. Only authenticated runtime senders can complete a probe. */
export class FrameBroker {
  private pending = new Map<
    string,
    {
      tabId: number
      frames: BrowserFrame[]
      snapshots: Map<number, FrameSnapshot>
      links: Map<string, number>
    }
  >()
  constructor(private readonly io: FrameTransport) {}
  async release(tabId: number): Promise<void> {
    try {
      const frames = await this.io.frames(tabId)
      await Promise.allSettled(
        frames.map(({ frameId }) =>
          this.io.send(tabId, frameId, { type: 'FRAME_RELEASE' }),
        ),
      )
    } catch {
      /* A closed/navigated tab has no capture controls to restore. */
    }
  }

  link(
    raw: unknown,
    tabId: number,
    frameId: number,
    browserDocumentId?: string,
  ): boolean {
    const parsed = frameLinkSchema.safeParse(raw)
    if (!parsed.success) return false
    const link: FrameLink = parsed.data
    const request = this.pending.get(link.nonce)
    if (!request || request.tabId !== tabId) return false
    const frame = request.frames.find((item) => item.frameId === frameId)
    if (
      !frame ||
      (frame.documentId && frame.documentId !== browserDocumentId)
    )
      return false
    const child = request.snapshots.get(frameId)
    const parent = request.snapshots.get(frame.parentFrameId)
    if (
      child?.documentId !== link.documentId ||
      !parent?.children.some((item) => item.token === link.token)
    )
      return false
    const key = `${frame.parentFrameId}:${link.token}`
    const previous = request.links.get(key)
    if (previous !== undefined && previous !== frameId) return false
    // A child cannot claim two distinct parent elements.
    if (
      [...request.links].some(
        ([existing, id]) => id === frameId && existing !== key,
      )
    )
      return false
    request.links.set(key, frameId)
    return true
  }

  async collect(tabId: number, geometryOnly = false): Promise<FrameScene> {
    const frames = await this.io.frames(tabId)
    if (
      !frames.length ||
      frames.length > FRAME_LIMITS.frames ||
      !frames.some((item) => item.frameId === 0) ||
      new Set(frames.map((item) => item.frameId)).size !== frames.length
    )
      throw failure()
    const nonce = crypto.randomUUID()
    const snapshots = new Map<number, FrameSnapshot>()
    const links = new Map<string, number>()
    this.pending.set(nonce, { tabId, frames, snapshots, links })
    try {
      await Promise.all(
        frames.map(async (frame) => {
          let raw: unknown
          try {
            raw = await this.io.send(tabId, frame.frameId, {
              type: 'FRAME_SNAPSHOT',
              nonce,
              geometryOnly,
            })
          } catch {
            return
          } // No receiver: the parent element stays fully masked.
          const parsed = frameSnapshotSchema.safeParse(raw)
          if (!parsed.success || parsed.data.nonce !== nonce)
            throw failure()
          const snapshot = parsed.data
          if (snapshot.url !== null) {
            const url = new URL(snapshot.url)
            if (
              !['http:', 'https:'].includes(url.protocol) ||
              url.username ||
              url.password ||
              url.search ||
              url.hash
            )
              throw failure()
          }
          if (
            new Set(snapshot.children.map((item) => item.token)).size !==
            snapshot.children.length
          )
            throw failure()
          snapshots.set(frame.frameId, snapshot)
        }),
      )
      const top = snapshots.get(0)
      if (!top?.url || top.viewport.width <= 0 || top.viewport.height <= 0)
        throw failure()
      for (const frame of frames) {
        const child = snapshots.get(frame.frameId),
          parent = snapshots.get(frame.parentFrameId)
        if (!child?.parentSelector || !parent) continue
        const matches = parent.children.filter(
          (item) => item.selector === child.parentSelector,
        )
        if (matches.length === 1)
          links.set(
            `${frame.parentFrameId}:${matches[0]!.token}`,
            frame.frameId,
          )
      }
      let probing = false
      await Promise.all(
        [...snapshots].map(async ([id, snapshot]) => {
          const tokens = snapshot.children
            .filter((item) => !links.has(`${id}:${item.token}`))
            .map((item) => item.token)
          if (!tokens.length) return
          probing = true
          const result = await this.io.send(tabId, id, {
            type: 'FRAME_PROBE',
            nonce,
            tokens,
          })
          if (
            !result ||
            typeof result !== 'object' ||
            !('ok' in result) ||
            result.ok !== true
          )
            throw failure()
        }),
      )
      if (probing) await new Promise((resolve) => setTimeout(resolve, 100))
      const current = await this.io.frames(tabId)
      if (graph(frames) !== graph(current))
        throw new FrameSceneChangedError()
      const contexts = new Map<string, FrameContext>()
      const frameIds = new Map<string, number>()
      const masks: Redaction[] = []
      const add = (mask: Redaction, context: FrameContext) => {
        const rect = intersectRects(
          transformRect(context.transform, mask.rect),
          context.clip,
        )
        if (rect.width > 0 && rect.height > 0) masks.push({ ...mask, rect })
        if (masks.length > FRAME_LIMITS.masks) throw failure()
      }
      const visit = (id: number, context: FrameContext, depth: number) => {
        if (depth > FRAME_LIMITS.depth || contexts.has(context.documentId))
          throw failure()
        const snapshot = snapshots.get(id)!
        contexts.set(context.documentId, context)
        frameIds.set(context.documentId, id)
        for (const mask of snapshot.masks) add(mask, context)
        if (snapshot.geometryMotion)
          add(
            policy(
              { x: 0, y: 0, ...snapshot.viewport },
              'animated-geometry',
            ),
            context,
          )
        const mapped = new Set<number>()
        for (const descriptor of snapshot.children) {
          const childId = links.get(`${id}:${descriptor.token}`)
          const child =
            childId === undefined ? undefined : snapshots.get(childId)
          if (childId !== undefined) mapped.add(childId)
          if (
            !child ||
            !descriptor.precise ||
            !descriptor.selector ||
            descriptor.content.width <= 0 ||
            descriptor.content.height <= 0 ||
            child.viewport.width <= 0 ||
            child.viewport.height <= 0
          ) {
            add(policy(descriptor.outer, 'frame-unavailable'), context)
            continue
          }
          const clip = intersectRects(
            context.clip,
            transformRect(context.transform, descriptor.content),
          )
          visit(
            childId!,
            {
              documentId: child.documentId,
              frame: [...context.frame, descriptor.selector],
              url: child.url ?? context.url,
              topUrl: top.url!,
              devicePixelRatio: top.devicePixelRatio,
              transform: childTransform(
                context.transform,
                descriptor.content,
                child.viewport,
              ),
              clip,
              precise:
                context.precise &&
                !snapshot.geometryMotion &&
                !child.geometryMotion,
            },
            depth + 1,
          )
        }
        // Unresolved browser frames could be inside closed roots or plugin hosts.
        // Cover the parent viewport instead of guessing an element by URL/order.
        if (
          frames.some(
            (frame) =>
              frame.parentFrameId === id && !mapped.has(frame.frameId),
          )
        )
          add(
            policy(
              { x: 0, y: 0, ...snapshot.viewport },
              'frame-unavailable',
            ),
            context,
          )
      }
      visit(
        0,
        {
          documentId: top.documentId,
          frame: [],
          url: top.url,
          topUrl: top.url,
          transform: { ...identityTransform },
          clip: { x: 0, y: 0, ...top.viewport },
          devicePixelRatio: top.devicePixelRatio,
          precise: !top.geometryMotion,
        },
        0,
      )
      // Nonces differ by collection. Everything that can affect identity, mask
      // geometry or pixels is included; mutations never include their contents.
      const signature = JSON.stringify({
        graph: graph(frames),
        snapshots: [...snapshots]
          .sort(([a], [b]) => a - b)
          .map(([id, { nonce: _nonce, ...snapshot }]) => [id, snapshot]),
        links: [...links].sort(([a], [b]) => a.localeCompare(b)),
      })
      return { signature, top, contexts, frameIds, masks }
    } catch (error) {
      if (!(error instanceof FrameSceneChangedError)) {
        // A reload can destroy the old receiver before snapshots/probes return.
        // Retry only a browser-confirmed graph replacement, never unavailable
        // metadata in an unchanged document, and never a partial/raw frame.
        let current: BrowserFrame[] | undefined
        try {
          current = await this.io.frames(tabId)
        } catch {
          /* Preserve the original closed-tab/transport failure. */
        }
        if (current && graph(frames) !== graph(current))
          throw new FrameSceneChangedError()
      }
      throw error
    } finally {
      this.pending.delete(nonce)
    }
  }
}

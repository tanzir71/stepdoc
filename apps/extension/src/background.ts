import { browser } from 'wxt/browser'
import { makeStep } from './legacy-capture'
import { compositeFrame } from './image'
import { CaptureQueue } from '@stepdoc/core/capture-queue'
import { stepSchema, expectationSchema, type Step } from '@stepdoc/schema'
import {
  localCaptureSchema,
  redactionChangeSchema,
  FRAME_PROBE,
} from '@stepdoc/schema/capture'
import { FrameBroker, type FrameScene } from './frame-broker'
import { contextualStep, legacyMeta } from './capture-context'
import type { CapturedEvent } from './capture-event'
import tokens from '../../../docs/v2/design-tokens.json'

type SessionBody = {
  title: string
  description: string
  sourceUrl?: string
  steps: unknown[]
}
interface LegacyStorage {
  recording?: boolean
  steps?: (ReturnType<typeof makeStep> & {
    position: number
    screenshot: string
  })[]
  capturedSteps?: Step[]
  captureSessionId?: string
  captureTabId?: number
  captureError?: string | null
  startedUrl?: string
  appUrl?: string
  pendingSession?: SessionBody
  captureBlurMode?: boolean
  captureManualCount?: number
}
type Pending = {
  event: CapturedEvent
  sessionId: string
  tabId: number
  windowId: number
  frameId: number
}
type ProcessedFrame = Awaited<ReturnType<typeof compositeFrame>> & {
  scene: FrameScene
  privacyEpoch: number
}
const safeUrl = (raw: string) => {
  const url = new URL(raw)
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Unsupported page')
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.href
}
export function startBackground() {
  if (import.meta.env.BROWSER !== 'firefox')
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  let lastCapture = 0
  let privacyEpoch = 0
  const manualCounts = new Map<string, number>()
  const broker = new FrameBroker({
    frames: async (tabId) =>
      (await browser.webNavigation.getAllFrames({ tabId })) ?? [],
    send: (tabId, frameId, message) =>
      browser.tabs.sendMessage(tabId, message, { frameId }),
  })
  const activationEpochs = new Map<number, number>()
  browser.tabs.onActivated.addListener(({ windowId }) =>
    activationEpochs.set(windowId, (activationEpochs.get(windowId) ?? 0) + 1),
  )
  let lastNavigation:
    | { sessionId: string; documentId: string; url: string }
    | undefined
  let writes = Promise.resolve()
  const expectations = new Map<string, NonNullable<Step['expect']>>()
  const mutate = <T>(operation: () => Promise<T>) => {
    const next = writes.then(operation)
    writes = next.then(
      () => {},
      () => {},
    )
    return next
  }
  const takeFrame = async (
    pending: Omit<Pending, 'event' | 'frameId'>,
    warming = false,
  ): Promise<ProcessedFrame> => {
    const framePrivacyEpoch = privacyEpoch
    const wait = 550 - (Date.now() - lastCapture)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    const state = await browser.storage.local.get<LegacyStorage>([
      'recording',
      'captureSessionId',
    ])
    if (
      (!warming && !state.recording) ||
      state.captureSessionId !== pending.sessionId
    )
      throw new Error('Capture ended')
    const tab = await browser.tabs.get(pending.tabId)
    const activation = activationEpochs.get(pending.windowId) ?? 0
    if (!tab.active) {
      await abort(pending.sessionId, 'tab_changed')
      throw new Error('Selected tab changed')
    }
    const collect = async () => {
      try {
        return await broker.collect(pending.tabId)
      } catch {
        await abort(pending.sessionId)
        throw new Error('Masks unavailable')
      }
    }
    try {
      const before = await collect()
      const raw = await browser.tabs.captureVisibleTab(pending.windowId, {
        format: 'png',
      })
      lastCapture = Date.now()
      const after = await collect()
      const afterTab = await browser.tabs.get(pending.tabId)
      if (
        !afterTab.active ||
        activation !== (activationEpochs.get(pending.windowId) ?? 0)
      ) {
        await abort(pending.sessionId, 'tab_changed')
        throw new Error('Selected tab changed')
      }
      if (
        safeUrl(afterTab.url ?? '') !== after.top.url ||
        before.signature !== after.signature
      ) {
        // Discard raw pixels if layout/document identity changed. The queue may
        // reuse only its previously processed frame and that frame's provenance.
        throw new Error('Frame changed')
      }
      // Only this processed frame enters the queue's reuse cache. Raw screenshot
      // pixels are never stored, cached between events, downloaded or uploaded.
      try {
        return {
          ...(await compositeFrame(
            raw,
            before.masks,
            before.top.devicePixelRatio,
          )),
          scene: before,
          privacyEpoch: framePrivacyEpoch,
        }
      } catch {
        await abort(pending.sessionId)
        throw new Error('Image processing unavailable')
      }
    } finally {
      await broker.release(pending.tabId)
    }
  }
  const queue = new CaptureQueue<Pending, ProcessedFrame>(
    async (pending) => {
      const frame = await takeFrame(pending)
      if (
        (pending.event.topUrl !== null &&
          frame.scene.top.url !== pending.event.topUrl) ||
        frame.scene.frameIds.get(pending.event.documentId) !== pending.frameId
      )
        throw new Error('Page changed')
      return frame
    },
    async ({ event: pending, frame, reused }) =>
      mutate(async () => {
        if (frame.privacyEpoch !== privacyEpoch) return false
        const state = await browser.storage.local.get<LegacyStorage>([
          'recording',
          'steps',
          'capturedSteps',
          'captureSessionId',
        ])
        if (!state.recording || state.captureSessionId !== pending.sessionId)
          return
        const index = (state.steps?.length ?? 0) + 1
        if (index > 500) {
          queue.clear()
          await browser.storage.local.set({
            recording: false,
            captureError: 'Capture stopped at the 500-step guide limit.',
          })
          await broadcast()
          return
        }
        // A reused image can belong to a previous document. It cannot supply
        // guessed frame selectors or click coordinates for a new document.
        if (
          frame.scene.frameIds.get(pending.event.documentId) !== pending.frameId
        ) {
          queue.clear()
          await browser.storage.local.set({
            recording: false,
            captureError:
              'Capture stopped because the frame context was unavailable.',
          })
          await broadcast()
          return
        }
        const enriched = contextualStep(pending.event, frame.scene)
        const step = stepSchema.parse({
          ...enriched,
          redactions: frame.redactions,
          index,
          ...(reused && { lowConfidence: true }),
          ...(expectations.has(pending.event.step.id) && {
            expect: expectations.get(pending.event.step.id),
          }),
          ...(pending.event.step.value?.kind === 'variable' ||
          pending.event.step.value?.kind === 'secret'
            ? {
                value: {
                  ...pending.event.step.value,
                  variable: `field_${index}`,
                },
              }
            : {}),
        })
        const capturedSteps = [...(state.capturedSteps ?? [])]
        if (step.action === 'navigate') {
          const navigation = {
            sessionId: pending.sessionId,
            documentId: pending.event.documentId,
            url: step.url!,
          }
          if (
            lastNavigation &&
            lastNavigation.sessionId === navigation.sessionId &&
            lastNavigation.documentId === navigation.documentId &&
            lastNavigation.url === navigation.url
          )
            return
          lastNavigation = navigation
        }
        if (
          step.action === 'navigate' &&
          capturedSteps.at(-1)?.type === 'action'
        ) {
          const previous = capturedSteps.at(-1)!
          if (previous.url !== step.url)
            previous.expect = { urlMatches: step.url! }
        }
        capturedSteps.push(step)
        const legacy = makeStep(legacyMeta(step, pending.event, frame.scene))
        await browser.storage.local.set({
          capturedSteps,
          steps: [
            ...(state.steps ?? []),
            {
              ...legacy,
              text: step.title,
              lowConfidence: step.lowConfidence,
              position: index - 1,
              screenshot: frame.dataUrl,
            },
          ],
        })
        await updateBadge()
      }),
  )
  async function updateBadge() {
    const state = await browser.storage.local.get<LegacyStorage>([
      'recording',
      'steps',
      'captureError',
    ])
    await browser.action.setBadgeText({
      text: state.captureError
        ? '!'
        : state.recording
          ? String(state.steps?.length ?? 0)
          : '',
    })
    await browser.action.setBadgeBackgroundColor({
      color: tokens.color['accent/solid'].light,
    })
  }
  async function broadcast() {
    const state = await browser.storage.local.get<LegacyStorage>([
      'recording',
      'captureSessionId',
      'captureTabId',
      'captureBlurMode',
      'captureManualCount',
    ])
    await updateBadge()
    await Promise.allSettled(
      (await browser.tabs.query({}))
        .filter((tab) => tab.id)
        .map((tab) =>
          browser.tabs.sendMessage(tab.id!, {
            type: 'STATE',
            recording: !!state.recording && tab.id === state.captureTabId,
            sessionId: state.captureSessionId,
            blurMode: !!state.captureBlurMode,
            manualCount: state.captureManualCount ?? 0,
          }),
        ),
    )
  }
  async function abort(
    sessionId: string,
    reason: 'metadata' | 'tab_changed' = 'metadata',
  ) {
    await mutate(async () => {
      const state =
        await browser.storage.local.get<LegacyStorage>('captureSessionId')
      if (state.captureSessionId !== sessionId) return
      queue.clear()
      await browser.storage.local.set({
        recording: false,
        captureError:
          reason === 'tab_changed'
            ? 'Capture stopped because the selected tab changed during the screenshot.'
            : 'Capture stopped because page metadata or privacy masks were unavailable.',
      })
    })
    await broadcast()
  }
  browser.runtime.onMessage.addListener((message, sender, respond) => {
    if (message.type === FRAME_PROBE) {
      respond({
        ok:
          sender.tab?.id !== undefined &&
          sender.frameId !== undefined &&
          broker.link(
            message,
            sender.tab.id,
            sender.frameId,
            sender.documentId,
          ),
      })
      return
    }
    void (async () => {
      if (message.type === 'START') {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        })
        if (!tab?.id) throw new Error('No capture tab')
        const startedUrl = safeUrl(tab.url ?? message.url ?? '')
        // A prior canceled capture can still own the queue's drain promise.
        // Stop producers and settle it before admitting a new session's work.
        const captureSessionId = crypto.randomUUID()
        await mutate(async () => {
          queue.clear()
          await browser.storage.local.set({ recording: false })
        })
        await broadcast()
        await queue.drain().catch(() => {})
        await mutate(async () => {
          queue.clear()
          expectations.clear()
          manualCounts.clear()
          privacyEpoch++
          lastNavigation = undefined
          await browser.storage.local.set({
            recording: false,
            steps: [],
            capturedSteps: [],
            captureSessionId,
            captureTabId: tab.id,
            captureError: null,
            startedUrl,
            captureBlurMode: false,
            captureManualCount: 0,
          })
        })
        let primed: ProcessedFrame
        try {
          primed = await takeFrame(
            {
              sessionId: captureSessionId,
              tabId: tab.id,
              windowId: tab.windowId,
            },
            true,
          )
        } catch {
          await abort(captureSessionId)
          throw new Error('Capture could not start')
        }
        await mutate(async () => {
          const latest = await browser.storage.local.get<LegacyStorage>([
            'captureSessionId',
            'captureError',
          ])
          if (
            latest.captureSessionId !== captureSessionId ||
            latest.captureError
          )
            throw new Error('Capture ended')
          queue.primeFrame(primed)
          await browser.storage.local.set({ recording: true })
        })
        await broadcast()
        respond({ ok: true })
      } else if (message.type === 'CANCEL') {
        await mutate(async () => {
          queue.clear()
          expectations.clear()
          manualCounts.clear()
          privacyEpoch++
          await browser.storage.local.set({
            recording: false,
            steps: [],
            capturedSteps: [],
            captureSessionId: crypto.randomUUID(),
            captureError: null,
            captureBlurMode: false,
            captureManualCount: 0,
          })
        })
        await broadcast()
        respond({ ok: true })
      } else if (
        message.type === 'SET_BLUR_MODE' ||
        message.type === 'REDACTION_CHANGED'
      ) {
        const ownControls =
          sender.id === browser.runtime.id &&
          !!sender.url?.startsWith(browser.runtime.getURL(''))
        const state = await browser.storage.local.get<LegacyStorage>([
          'recording',
          'captureSessionId',
          'captureTabId',
        ])
        if (
          !state.recording ||
          message.sessionId !== state.captureSessionId ||
          (sender.tab?.id !== state.captureTabId &&
            !(message.type === 'SET_BLUR_MODE' && ownControls))
        ) {
          respond({ ok: false })
          return
        }
        if (message.type === 'SET_BLUR_MODE') {
          if (typeof message.on !== 'boolean') throw new Error('Invalid mode')
          await browser.storage.local.set({ captureBlurMode: message.on })
        } else {
          if (!sender.tab) throw new Error('Invalid capture sender')
          const change = redactionChangeSchema.parse(message)
          // Invalidate synchronously before waiting on an earlier storage writer.
          // The queue retries old in-flight work and preserves event order.
          privacyEpoch++
          queue.invalidateFrame()
          manualCounts.set(change.documentId, change.count)
          const total = [...manualCounts.values()].reduce(
            (sum, value) => sum + value,
            0,
          )
          if (total > 500) {
            await abort(change.sessionId)
            respond({ ok: false })
            return
          }
          await mutate(async () => {
            await browser.storage.local.set({ captureManualCount: total })
          })
        }
        await broadcast()
        respond({ ok: true })
      } else if (
        message.type === 'CAPTURE' ||
        message.type === 'CAPTURE_ERROR' ||
        message.type === 'EXPECTATION'
      ) {
        const state = await browser.storage.local.get<LegacyStorage>([
          'recording',
          'captureTabId',
          'captureBlurMode',
          'captureManualCount',
          'captureSessionId',
          'capturedSteps',
        ])
        if (
          !sender.tab ||
          sender.tab.id !== state.captureTabId ||
          message.sessionId !== state.captureSessionId ||
          !state.recording
        ) {
          respond({ ok: false, error: 'Capture inactive' })
          return
        }
        if (message.type === 'CAPTURE_ERROR') {
          await abort(message.sessionId)
          respond({ ok: false })
          return
        }
        if (message.type === 'EXPECTATION') {
          const expectation = expectationSchema.parse(message.expect)
          await mutate(async () => {
            const latest = await browser.storage.local.get<LegacyStorage>([
              'captureSessionId',
              'capturedSteps',
            ])
            if (latest.captureSessionId !== message.sessionId) return
            if (expectations.size >= 500 && !expectations.has(message.id))
              return
            expectations.set(message.id, expectation)
            const capturedSteps = latest.capturedSteps ?? []
            const step = capturedSteps.find((step) => step.id === message.id)
            if (step) {
              step.expect = expectation
              await browser.storage.local.set({ capturedSteps })
            }
          })
          respond({ ok: true })
          return
        }
        const event = localCaptureSchema.parse(message.event)
        await queue.enqueue({
          event,
          sessionId: message.sessionId,
          tabId: sender.tab.id!,
          windowId: sender.tab.windowId,
          frameId: sender.frameId ?? 0,
        })
        respond({ ok: true })
      } else if (message.type === 'STOP') {
        await queue.drain()
        await writes
        const state =
          await browser.storage.local.get<LegacyStorage>('captureError')
        await browser.storage.local.set({ recording: false })
        await broadcast()
        respond(
          state.captureError
            ? { ok: false, error: state.captureError }
            : await upload(),
        )
      } else if (message.type === 'RETRY') respond(await retry())
      else if (message.type === 'CONTENT_STATE') {
        const state = await browser.storage.local.get<LegacyStorage>([
          'recording',
          'captureSessionId',
          'captureTabId',
          'captureBlurMode',
          'captureManualCount',
        ])
        respond({
          ...state,
          recording: !!state.recording && sender.tab?.id === state.captureTabId,
        })
      } else if (message.type === 'GET_STATE')
        respond(
          await browser.storage.local.get<LegacyStorage>([
            'recording',
            'steps',
            'capturedSteps',
            'captureSessionId',
            'captureError',
            'pendingSession',
            'captureBlurMode',
            'captureManualCount',
          ]),
        )
    })().catch(() => respond({ ok: false, error: 'Capture operation failed' }))
    return true
  })
  browser.tabs.onUpdated.addListener((id, info) => {
    if (info.status !== 'complete') return
    void (async () => {
      const state = await browser.storage.local.get<LegacyStorage>([
        'recording',
        'captureSessionId',
        'captureTabId',
      ])
      if (!state.recording || id !== state.captureTabId) return
      const tab = await browser.tabs.get(id)
      const result: { ok: boolean; event: CapturedEvent } =
        await browser.tabs.sendMessage(
          id,
          { type: 'CAPTURE_PAGE' },
          { frameId: 0 },
        )
      if (!result.ok) {
        await abort(state.captureSessionId!)
        return
      }
      await queue.enqueue({
        event: result.event,
        sessionId: state.captureSessionId!,
        tabId: id,
        windowId: tab.windowId,
        frameId: 0,
      })
    })().catch(() => {})
  })
  async function retry() {
    const value =
      await browser.storage.local.get<LegacyStorage>('pendingSession')
    return value.pendingSession
      ? upload(value.pendingSession)
      : { ok: false, error: 'No saved upload' }
  }

  async function upload(saved?: SessionBody) {
    const value = await browser.storage.local.get<LegacyStorage>([
      'steps',
      'startedUrl',
      'appUrl',
    ])
    const body = saved ?? {
      title: 'Captured guide',
      description: '',
      sourceUrl: value.startedUrl,
      steps: value.steps ?? [],
    }
    const app = value.appUrl ?? 'http://localhost:3000'
    try {
      const response = await fetch(`${app}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw Error(await response.text())
      const data = await response.json()
      await browser.storage.local.remove(['steps', 'pendingSession'])
      await browser.tabs.create({ url: `${app}/guides/${data.id}/edit` })
      return { ok: true }
    } catch (error) {
      await browser.storage.local.set({ pendingSession: body })
      // Service workers have no createObjectURL. A download URL may contain only
      // this already-redacted legacy payload; the retry copy remains in storage.
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(body, null, 2))}`
      await browser.downloads.download({
        url,
        filename: 'stepdoc-session.json',
      })
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Upload failed',
      }
    }
  }
}

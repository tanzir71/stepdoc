import { browser } from 'wxt/browser'
import { makeStep } from './legacy-capture'
import { composite } from './image'
import { CaptureQueue } from '@stepdoc/core/capture-queue'
import {
  stepSchema,
  expectationSchema,
  type Step,
  type Rect,
} from '@stepdoc/schema'
import { elementMetaSchema, type ElementMeta } from '@stepdoc/schema/legacy-v1'
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
}
type Pending = {
  event: CapturedEvent
  sessionId: string
  tabId: number
  windowId: number
}
type Masks = {
  ok: boolean
  documentId: string
  masks: Rect[]
  url: string
  viewport: { width: number; height: number }
  devicePixelRatio: number
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
  const activationEpochs = new Map<number, number>()
  browser.tabs.onActivated.addListener(({ windowId }) =>
    activationEpochs.set(windowId, (activationEpochs.get(windowId) ?? 0) + 1),
  )
  let lastNavigation:
    | { sessionId: string; documentId: string; url: string }
    | undefined
  let writes = Promise.resolve()
  const expectations = new Map<string, NonNullable<Step['expect']>>()
  const mutate = (operation: () => Promise<void>) => {
    const next = writes.then(operation)
    writes = next.catch(() => {})
    return next
  }
  const masks = async (pending: Pending): Promise<Masks> => {
    try {
      const result: Masks = await browser.tabs.sendMessage(
        pending.tabId,
        { type: 'GET_MASKS' },
        { frameId: 0 },
      )
      if (
        !result.ok ||
        typeof result.documentId !== 'string' ||
        result.documentId.length < 16 ||
        result.documentId.length > 100 ||
        result.url !== pending.event.topUrl ||
        !Array.isArray(result.masks) ||
        result.masks.length > 12_000 ||
        !Number.isFinite(result.devicePixelRatio) ||
        result.devicePixelRatio <= 0 ||
        ![result.viewport.width, result.viewport.height].every(
          (value) => Number.isFinite(value) && value > 0,
        )
      )
        throw new Error('Masks unavailable')
      for (const rect of result.masks)
        if (
          ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
          rect.width < 0 ||
          rect.height < 0
        )
          throw new Error('Invalid mask')
      return result
    } catch {
      await abort(pending.sessionId)
      throw new Error('Masks unavailable')
    }
  }
  const queue = new CaptureQueue<Pending>(
    async (pending) => {
      const wait = 550 - (Date.now() - lastCapture)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const state = await browser.storage.local.get<LegacyStorage>([
        'recording',
        'captureSessionId',
      ])
      if (!state.recording || state.captureSessionId !== pending.sessionId)
        throw new Error('Capture ended')
      const tab = await browser.tabs.get(pending.tabId)
      const activation = activationEpochs.get(pending.windowId) ?? 0
      if (!tab.active || safeUrl(tab.url ?? '') !== pending.event.topUrl)
        throw new Error('Page changed')
      const before = await masks(pending)
      const raw = await browser.tabs.captureVisibleTab(pending.windowId, {
        format: 'png',
      })
      lastCapture = Date.now()
      const after = await masks(pending)
      const afterTab = await browser.tabs.get(pending.tabId)
      if (
        !afterTab.active ||
        safeUrl(afterTab.url ?? '') !== pending.event.topUrl ||
        activation !== (activationEpochs.get(pending.windowId) ?? 0)
      ) {
        await abort(pending.sessionId, 'tab_changed')
        throw new Error('Selected tab changed')
      }
      if (
        !after.ok ||
        before.documentId !== after.documentId ||
        before.url !== after.url ||
        before.viewport.width !== after.viewport.width ||
        before.viewport.height !== after.viewport.height ||
        before.devicePixelRatio !== after.devicePixelRatio
      ) {
        await abort(pending.sessionId)
        throw new Error('Page changed')
      }
      // Only this processed frame enters the queue's reuse cache. Raw screenshot
      // pixels are never stored, cached between events, downloaded or uploaded.
      return composite(
        raw,
        [...before.masks, ...after.masks],
        undefined,
        before.devicePixelRatio,
      )
    },
    async ({ event: pending, frame, reused }) =>
      mutate(async () => {
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
        const step = stepSchema.parse({
          ...pending.event.step,
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
        const legacy = makeStep(pending.event.meta)
        await browser.storage.local.set({
          capturedSteps,
          steps: [
            ...(state.steps ?? []),
            {
              ...legacy,
              text: step.title,
              lowConfidence: step.lowConfidence,
              position: index - 1,
              screenshot: frame,
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
        await mutate(async () => {
          queue.clear()
          await browser.storage.local.set({ recording: false })
        })
        await broadcast()
        await queue.drain().catch(() => {})
        await mutate(async () => {
          queue.clear()
          expectations.clear()
          lastNavigation = undefined
          await browser.storage.local.set({
            recording: true,
            steps: [],
            capturedSteps: [],
            captureSessionId: crypto.randomUUID(),
            captureTabId: tab.id,
            captureError: null,
            startedUrl,
          })
        })
        await broadcast()
        respond({ ok: true })
      } else if (message.type === 'CANCEL') {
        await mutate(async () => {
          queue.clear()
          expectations.clear()
          await browser.storage.local.set({
            recording: false,
            steps: [],
            capturedSteps: [],
            captureSessionId: crypto.randomUUID(),
            captureError: null,
          })
        })
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
        const step = stepSchema.parse(message.event.step)
        const meta = elementMetaSchema.parse(message.event.meta)
        const event = {
          ...message.event,
          step,
          meta,
          topUrl: safeUrl(message.event.topUrl),
        } as CapturedEvent
        await queue.enqueue({
          event,
          sessionId: message.sessionId,
          tabId: sender.tab.id!,
          windowId: sender.tab.windowId,
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

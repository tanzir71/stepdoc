import { browser } from 'wxt/browser'
import { makeStep } from './legacy-capture'
import { compositeFrame, previewImage } from './image'
import { CapturePreviews } from './capture-previews'
import { captureControls, captureSourceState } from './capture-controls'
import { captureImageBlob } from '@stepdoc/storage/http'
import { MAX_BLOB_BYTES } from '@stepdoc/storage'
import { CaptureQueue } from '@stepdoc/core/capture-queue'
import { stepSchema, expectationSchema, type Step } from '@stepdoc/schema'
import {
  localCaptureSchema,
  redactionChangeSchema,
  capturePillControlSchema,
  capturePreviewCommandSchema,
  narrationCommandSchema,
  FRAME_PROBE,
} from '@stepdoc/schema/capture'
import {
  FrameBroker,
  FrameSceneChangedError,
  withStableFrameScene,
  type FrameScene,
} from './frame-broker'
import { contextualStep, legacyMeta } from './capture-context'
import { GuideController } from './guide-controller'
import type { GuideRun } from './guide-run'
import type { CapturedEvent } from './capture-event'
import tokens from '../../../docs/v2/design-tokens.json'
import { startClock, stopClock } from './capture-clock'
import { narrationText } from './narration-text'
import { pairingCommandSchema } from '@stepdoc/schema/pairing'
import { PairingController } from './pairing-controller'
import { IndexedDbConnectionVault } from './connection-vault'
import {
  captureBrowserSessionSchema,
  captureStartSchema,
  captureTargetSchema,
  captureTargetCommandSchema,
  type CaptureTarget,
} from '@stepdoc/schema/capture-target'
import { CaptureTargets, CaptureTargetError } from './capture-target'
import {
  capturePreferencesSchema,
  editReview,
  reviewEditSchema,
  saveCapture,
  suggestedTitle,
  type ReviewState,
} from './review'
import {
  captureDestinationCommandSchema,
  captureSaveCommandSchema,
  captureRecentCommandSchema,
  type CaptureDestination,
} from '@stepdoc/schema/capture-destination'
import {
  CaptureDestinations,
  DestinationFailure,
  destinationChoice,
  destinationError,
} from './capture-destination'

type SessionBody = {
  title: string
  description: string
  sourceUrl?: string
  steps: unknown[]
}
export interface LegacyStorage {
  guideMe?: GuideRun
  captureReview?: ReviewState
  recording?: boolean
  steps?: (ReturnType<typeof makeStep> & {
    position: number
    screenshot: string
  })[]
  capturedSteps?: Step[]
  captureSessionId?: string
  captureTabId?: number
  captureSource?: CaptureTarget
  captureError?: string | null
  startedUrl?: string
  appUrl?: string
  pendingSession?: SessionBody
  captureBlurMode?: boolean
  captureManualCount?: number
  captureDestination?: CaptureDestination
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
const openReview = (fullTab = false) =>
  browser.tabs.create({
    url:
      browser.runtime.getURL(
        fullTab || import.meta.env.BROWSER === 'firefox'
          ? '/popup.html'
          : '/sidepanel.html',
      ) + '?surface=tab&view=review',
  })
export function startBackground() {
  const fallbackBrowserSession = crypto.randomUUID()
  let browserSessionPromise: Promise<string> | undefined
  const browserSession = () =>
    (browserSessionPromise ??= (async () => {
      // Session storage survives worker restarts, but never a new browser session.
      try {
        if (!browser.storage.session) return fallbackBrowserSession
        const key = 'stepdoc.capture-browser-session.v1'
        const stored = await browser.storage.session.get(key)
        const parsed = captureBrowserSessionSchema.safeParse(stored[key])
        if (parsed.success) return parsed.data
        const fresh = crypto.randomUUID()
        await browser.storage.session.set({ [key]: fresh })
        return fresh
      } catch {
        return fallbackBrowserSession
      }
    })())
  const targets = new CaptureTargets({
    browserSession,
    tabs: () => browser.tabs.query({}),
    active: async () =>
      (await browser.tabs.query({ active: true, currentWindow: true }))[0],
    get: (id) => browser.tabs.get(id),
    activate: async (id, windowId) => {
      const sourceWindow = await browser.windows.get(windowId)
      await browser.windows.update(windowId, {
        focused: true,
        ...(sourceWindow.state === 'minimized'
          ? { state: 'normal' as const }
          : {}),
      })
      await browser.tabs.update(id, { active: true })
    },
  })
  if (import.meta.env.BROWSER !== 'firefox')
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  let lastCapture = 0
  let privacyEpoch = 0
  let producerStopped = false
  let commands = Promise.resolve()
  let privateRunning = false
  let narrationOwner:
    | { owner: string; sessionId: string; expires: number; sequence: number }
    | undefined
  let legacyStarting = 0
  let activeSave: { sessionId: string; controller: AbortController } | undefined
  const vault = new IndexedDbConnectionVault()
  const destinations = new CaptureDestinations(vault)
  const previews = new CapturePreviews()
  let previewJobs = Promise.resolve()
  const pairing = new PairingController({
    vault,
    extensionId: new URL(browser.runtime.getURL('/')).host,
    deviceName: `StepDoc ${import.meta.env.BROWSER}`,
    canChange: async () => {
      if (privateRunning || legacyStarting) return false
      const state = await browser.storage.local.get<LegacyStorage>([
        'recording',
        'captureReview',
        'guideMe',
      ])
      return (
        !privateRunning &&
        !legacyStarting &&
        !state.recording &&
        ['idle', undefined].includes(state.captureReview?.phase) &&
        (!state.guideMe || state.guideMe.phase === 'complete')
      )
    },
    changed: async (state) => {
      try {
        await browser.runtime.sendMessage({ type: 'PAIR_STATE', state })
      } catch {}
    },
  })
  const recovered = browser.storage.local
    .get<LegacyStorage>([
      'captureReview',
      'recording',
      'captureTabId',
      'captureSource',
    ])
    .then(async ({ captureReview, recording, captureTabId, captureSource }) => {
      const phase = captureReview?.phase
      const source = captureTargetSchema.safeParse(captureSource)
      if (
        (recording || phase === 'recording' || phase === 'paused') &&
        (!source.success ||
          source.data.browserSession !== (await browserSession()) ||
          source.data.tabId !== captureTabId)
      ) {
        await browser.storage.local.set({
          recording: false,
          captureBlurMode: false,
          captureError:
            'Capture stopped because its browser session changed. Review or discard the retained capture.',
          captureReview: {
            ...captureReview,
            phase: 'review',
            clock: stopClock(captureReview?.clock),
          },
        })
        return
      }
      if (
        phase &&
        ['starting', 'pausing', 'stopping', 'saving'].includes(phase)
      )
        await browser.storage.local.set({
          recording: false,
          captureBlurMode: false,
          captureReview: {
            ...captureReview,
            phase: phase === 'pausing' ? 'paused' : 'review',
            clock: stopClock(captureReview?.clock),
          },
        })
    })
  const manualCounts = new Map<string, number>()
  const broker = new FrameBroker({
    frames: async (tabId) =>
      (await browser.webNavigation.getAllFrames({ tabId })) ?? [],
    send: async (tabId, frameId, message) => {
      const { captureReview } =
        await browser.storage.local.get<LegacyStorage>('captureReview')
      return browser.tabs.sendMessage(
        tabId,
        {
          ...(typeof message === 'object' && message !== null ? message : {}),
          smartBlur: captureReview?.preferences?.smartBlur ?? true,
        },
        { frameId },
      )
    },
  })
  const guide = new GuideController(broker)
  const guideRecovered = guide.recover()
  browser.tabs.onRemoved.addListener((tabId) => {
    void guide.closed(tabId).catch(() => {})
    void recovered
      .then(async () => {
        const state = await browser.storage.local.get<LegacyStorage>([
          'recording',
          'captureTabId',
          'captureSessionId',
          'captureReview',
        ])
        if (
          tabId === state.captureTabId &&
          (state.recording || state.captureReview?.phase === 'paused')
        )
          await abort(state.captureSessionId!, 'tab_changed')
      })
      .catch(() => {})
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
  let expectationOwner:
    | { sessionId: string; id: string; frameId: number }
    | undefined
  const mutate = <T>(operation: () => Promise<T>) => {
    const next = writes.then(operation)
    writes = next.then(
      () => {},
      () => {},
    )
    return next
  }
  const takeFrameAttempt = async (
    pending: Omit<Pending, 'event' | 'frameId'>,
    warming: boolean,
    activation: { epoch?: number },
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
    activation.epoch ??= activationEpochs.get(pending.windowId) ?? 0
    if (
      !tab.active ||
      activation.epoch !== (activationEpochs.get(pending.windowId) ?? 0)
    ) {
      await abort(pending.sessionId, 'tab_changed')
      throw new Error('Selected tab changed')
    }
    const collect = async () => {
      try {
        return await broker.collect(pending.tabId)
      } catch (error) {
        if (error instanceof FrameSceneChangedError) throw error
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
        activation.epoch !== (activationEpochs.get(pending.windowId) ?? 0)
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
  const takeFrame = async (
    pending: Omit<Pending, 'event' | 'frameId'>,
    warming = false,
  ): Promise<ProcessedFrame> => {
    // Establish activation at the first attempt's tab check and retain it across retries.
    const activation: { epoch?: number } = {}
    try {
      return await withStableFrameScene(() =>
        takeFrameAttempt(pending, warming, activation),
      )
    } catch (error) {
      if (error instanceof FrameSceneChangedError)
        await abort(pending.sessionId)
      throw error
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
          'captureReview',
        ])
        if (!state.recording || state.captureSessionId !== pending.sessionId)
          return
        const index = (state.steps?.length ?? 0) + 1
        if (index > 500) {
          queue.clear()
          await browser.storage.local.set({
            recording: false,
            captureError: 'Capture stopped at the 500-step guide limit.',
            captureReview: {
              ...state.captureReview,
              phase: 'review',
              clock: stopClock(state.captureReview?.clock),
            },
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
            captureReview: {
              ...state.captureReview,
              phase: 'review',
              clock: stopClock(state.captureReview?.clock),
            },
          })
          await broadcast()
          return
        }
        const enriched = contextualStep(pending.event, frame.scene)
        const step = stepSchema.parse({
          ...enriched,
          redactions: frame.redactions,
          screenshot: {
            rendered: '',
            width: frame.width,
            height: frame.height,
            devicePixelRatio: frame.scene.top.devicePixelRatio,
          },
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
        if (state.captureReview?.preferences?.agentContext === false) {
          delete step.target
          delete step.expect
          step.lowConfidence = true
        }
        const capturedSteps = [...(state.capturedSteps ?? [])]
        let navigation: typeof lastNavigation
        if (step.action === 'navigate') {
          navigation = {
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
        }
        if (
          step.action === 'navigate' &&
          capturedSteps.at(-1)?.type === 'action' &&
          state.captureReview?.preferences?.agentContext !== false
        ) {
          const previous = capturedSteps.at(-1)!
          if (previous.url !== step.url)
            previous.expect = { urlMatches: step.url! }
        }
        capturedSteps.push(step)
        const legacy = makeStep(legacyMeta(step, pending.event, frame.scene))
        // Privacy may change while the storage snapshot is being read. This is
        // the final synchronous fence before dispatching the source write.
        if (frame.privacyEpoch !== privacyEpoch) return false
        if (navigation) lastNavigation = navigation
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
        // The preview derives only from the now-committed masked source. A slow
        // or failed disposable-cache write cannot widen the privacy fence.
        if (frame.preview)
          await previews
            .put(pending.sessionId, step.id, frame.preview)
            .catch(() => {})
        await broadcast()
      }),
  )
  async function updateBadge() {
    const state = await browser.storage.local.get<LegacyStorage>([
      'recording',
      'capturedSteps',
      'captureError',
    ])
    await browser.action.setBadgeText({
      text: state.captureError
        ? '!'
        : state.recording
          ? String(state.capturedSteps?.length ?? 0)
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
      'captureReview',
      'capturedSteps',
    ])
    await updateBadge()
    await Promise.allSettled(
      (await browser.tabs.query({}))
        .filter((tab) => tab.id)
        .map((tab) => {
          const source = captureSourceState(state, tab.id!)
          return browser.tabs.sendMessage(tab.id!, {
            type: 'STATE',
            recording: source.recording,
            paused: source.paused,
            producerStopped: source.producerStopped,
            stepCount: source.stepCount,
            sessionId: source.captureSessionId,
            blurMode: source.captureBlurMode,
            manualCount: source.captureManualCount,
            capturePill: source.capturePill,
          })
        }),
    )
  }
  async function abort(
    sessionId: string,
    reason: 'metadata' | 'tab_changed' = 'metadata',
    recordingOnly = false,
  ) {
    await mutate(async () => {
      const state = await browser.storage.local.get<LegacyStorage>([
        'captureSessionId',
        'recording',
      ])
      if (
        state.captureSessionId !== sessionId ||
        (recordingOnly && !state.recording)
      )
        return
      queue.clear()
      await browser.storage.local.set({
        recording: false,
        captureReview: {
          ...(await browser.storage.local.get<LegacyStorage>('captureReview'))
            .captureReview,
          phase: 'review',
          clock: stopClock(
            (await browser.storage.local.get<LegacyStorage>('captureReview'))
              .captureReview?.clock,
          ),
        },
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
    const ownControls =
      sender.id === browser.runtime.id &&
      !!sender.url?.startsWith(browser.runtime.getURL(''))
    if (message.type === 'CAPTURE_PREVIEW') {
      const command = capturePreviewCommandSchema.safeParse(message)
      if (!ownControls || !command.success) {
        respond({ ok: false, error: 'forbidden' })
        return
      }
      // Only old retained captures or a failed disposable-cache write need recovery.
      // Serialize recovery so multiple visible rows never materialize the full
      // retained image array concurrently; replies contain no image bytes.
      const job = previewJobs.then(async () => {
        await recovered
        // A storage event can render a row before its preview write completes.
        // Join that writer before attempting old-capture cache recovery.
        await writes
        const current = await browser.storage.local.get<LegacyStorage>([
          'captureSessionId',
          'capturedSteps',
        ])
        const { sessionId, stepId } = command.data
        const index =
          current.capturedSteps?.findIndex((step) => step.id === stepId) ?? -1
        if (current.captureSessionId !== sessionId || index < 0)
          throw new Error()
        if (await previews.get(sessionId, stepId)) return
        const retained = await browser.storage.local.get<LegacyStorage>([
          'steps',
          'capturedSteps',
          'captureSessionId',
        ])
        const retainedIndex =
          retained.capturedSteps?.findIndex((step) => step.id === stepId) ?? -1
        if (retained.captureSessionId !== sessionId || retainedIndex < 0)
          throw new Error()
        const source = retained.steps?.[retainedIndex]?.screenshot
        if (!source) throw new Error()
        const file = await captureImageBlob(source, MAX_BLOB_BYTES, true)
        const preview = await previewImage(file)
        await mutate(async () => {
          const latest = await browser.storage.local.get<LegacyStorage>([
            'captureSessionId',
            'capturedSteps',
          ])
          if (
            latest.captureSessionId !== sessionId ||
            !latest.capturedSteps?.some((step) => step.id === stepId)
          )
            throw new Error()
          await previews.put(sessionId, stepId, preview)
        })
      })
      previewJobs = job.catch(() => {})
      void job.then(
        () => respond({ ok: true }),
        () => respond({ ok: false, error: 'Preview unavailable' }),
      )
      return true
    }
    if (['CANCEL', 'STOP', 'RETRY'].includes(message.type) && !ownControls) {
      respond({ ok: false, error: 'Capture operation failed' })
      return
    }
    if (message.type === 'CAPTURE_SERVER_RECENT') {
      const command = captureRecentCommandSchema.safeParse(message)
      if (!ownControls || !command.success) {
        respond({ ok: false, code: 'forbidden' })
        return
      }
      void destinations.recent(command.data.destination).then(
        (items) => respond({ ok: true, items }),
        (error: unknown) =>
          respond({ ok: false, code: destinationError(error).code }),
      )
      return true
    }
    if (message.type === 'CAPTURE_TARGETS') {
      if (
        !ownControls ||
        !captureTargetCommandSchema.safeParse(message).success
      ) {
        respond({ ok: false, code: 'forbidden' })
        return
      }
      void browser.storage.local
        .get<LegacyStorage>('captureSource')
        .then(async (state) => {
          const fullTab =
            new URL(sender.url!).searchParams.get('surface') === 'tab'
          respond({
            ok: true,
            state: await targets.list(fullTab, state.captureSource),
          })
        })
        .catch(() => respond({ ok: false, code: 'unavailable' }))
      return true
    }
    if (
      [
        'PAIR_STATUS',
        'PAIR_CONNECT',
        'PAIR_TEST',
        'PAIR_CANCEL',
        'PAIR_FORGET',
      ].includes(message.type)
    ) {
      const command = pairingCommandSchema.safeParse(message)
      if (!ownControls || !command.success) {
        respond({ ok: false, error: 'forbidden' })
        return
      }
      void pairing
        .handle(command.data)
        .then(respond, () =>
          respond({ ok: false, error: 'storage_unavailable' }),
        )
      return true
    }
    const privateCommands = [
      'START_CAPTURE',
      'CAPTURE_FOCUS_TARGET',
      'PAUSE_CAPTURE',
      'RESUME_CAPTURE',
      'STOP_REVIEW',
      'EDIT_REVIEW',
      'SAVE_CAPTURE',
      'DISCARD_CAPTURE',
      'SET_CAPTURE_PREFERENCES',
      'SET_CAPTURE_DESTINATION',
      'SHORTCUT',
      'GUIDE_START',
      'GUIDE_CLEAR',
      'CAPTURE_PILL_CONTROL',
      'OPEN_CAPTURE_REVIEW',
      'NARRATION_CLAIM',
      'NARRATION_RELEASE',
      'NARRATION_APPEND',
    ]
    const run = async () => {
      await recovered
      await guideRecovered
      let fromPill = false
      if (privateCommands.includes(message.type)) {
        if (
          !ownControls &&
          !['SHORTCUT', 'CAPTURE_PILL_CONTROL'].includes(message.type)
        )
          throw new Error('Invalid controls')
        if (message.type === 'CAPTURE_PILL_CONTROL') {
          const command = capturePillControlSchema.parse(message)
          const state = await browser.storage.local.get<LegacyStorage>([
            'captureTabId',
            'captureSessionId',
            'captureReview',
          ])
          if (
            sender.frameId !== 0 ||
            sender.tab?.id !== state.captureTabId ||
            command.sessionId !== state.captureSessionId
          )
            throw new Error('Invalid recording controls')
          if (command.action === 'open-review') {
            if (state.captureReview?.phase !== 'review')
              throw new Error('Review unavailable')
            await openReview()
            respond({ ok: true })
            return
          }
          fromPill = true
          message = {
            type: {
              pause: 'PAUSE_CAPTURE',
              resume: 'RESUME_CAPTURE',
              stop: 'STOP_REVIEW',
            }[command.action],
            sessionId: command.sessionId,
          }
        }
        if (message.type === 'SHORTCUT') {
          const tab =
            sender.tab?.id === undefined
              ? undefined
              : await browser.tabs.get(sender.tab.id)
          if (!tab?.active) throw new Error('Inactive shortcut')
          const state = await browser.storage.local.get<LegacyStorage>([
            'recording',
            'captureTabId',
            'captureReview',
            'captureSessionId',
          ])
          if (state.captureReview?.phase === 'review')
            throw new Error('Review pending')
          if (
            (state.recording || state.captureReview?.phase === 'paused') &&
            state.captureTabId !== tab.id
          )
            throw new Error('Wrong capture tab')
          message = {
            type:
              state.recording || state.captureReview?.phase === 'paused'
                ? 'STOP_REVIEW'
                : 'START_CAPTURE',
            sessionId: state.captureSessionId,
          }
        }
      }
      if (message.type.startsWith('NARRATION_')) {
        const command = narrationCommandSchema.parse(message)
        if (command.type === 'NARRATION_RELEASE') {
          if (narrationOwner?.owner === command.owner)
            narrationOwner = undefined
          respond({ ok: true })
          return
        }
        await mutate(async () => {
          const state = await browser.storage.local.get<LegacyStorage>([
            'recording',
            'captureSessionId',
            'captureReview',
            'capturedSteps',
          ])
          if (
            !state.recording ||
            state.captureReview?.phase !== 'recording' ||
            !state.captureReview.preferences?.voiceNarration ||
            state.captureSessionId !== command.sessionId
          )
            throw new Error('Narration inactive')
          if (command.type === 'NARRATION_CLAIM') {
            if (
              narrationOwner &&
              narrationOwner.expires > Date.now() &&
              narrationOwner.sessionId === command.sessionId &&
              narrationOwner.owner !== command.owner
            )
              throw new Error('Narration already active')
            narrationOwner = {
              owner: command.owner,
              sessionId: command.sessionId,
              expires: Date.now() + 8000,
              sequence:
                narrationOwner?.owner === command.owner &&
                narrationOwner.sessionId === command.sessionId
                  ? narrationOwner.sequence
                  : 0,
            }
          } else {
            if (
              !narrationOwner ||
              narrationOwner.owner !== command.owner ||
              narrationOwner.sessionId !== command.sessionId ||
              narrationOwner.expires <= Date.now()
            )
              throw new Error('Narration unavailable')
            if (command.sequence <= narrationOwner.sequence) return
            const step = state.capturedSteps?.find(
              (step) => step.id === command.stepId,
            )
            const text = narrationText(command.text)
            if (
              !step ||
              !text ||
              (step.notes?.length ?? 0) + text.length + 1 > 12000
            )
              throw new Error('Narration unavailable')
            step.notes = step.notes ? `${step.notes}\n${text}` : text
            await browser.storage.local.set({
              capturedSteps: state.capturedSteps,
            })
            narrationOwner.sequence = command.sequence
          }
        })
        respond({ ok: true })
      } else if (message.type === 'SET_CAPTURE_DESTINATION') {
        const parsed = captureDestinationCommandSchema.safeParse(message)
        if (!parsed.success) throw new DestinationFailure('forbidden')
        const command = parsed.data
        const state = await browser.storage.local.get<LegacyStorage>([
          'captureSessionId',
          'captureReview',
          'recording',
        ])
        const review = state.captureReview
        if (
          pairing.busy ||
          state.recording ||
          ![undefined, 'idle', 'review'].includes(review?.phase)
        )
          throw new DestinationFailure('busy')
        if (
          command.sessionId !== state.captureSessionId ||
          command.revision !== review?.revision
        )
          throw new DestinationFailure('stale')
        if (
          review?.phase === 'review' &&
          (review.savedId || review.remoteSaved || review.remoteAttempt)
        )
          throw new DestinationFailure('busy')
        const destination = await destinations.validate(command.destination)
        if (review?.phase === 'review')
          await browser.storage.local.set({
            captureReview: {
              ...review,
              destination,
              saveError: undefined,
              revision: (review.revision ?? 0) + 1,
            },
          })
        else
          await browser.storage.local.set({ captureDestination: destination })
        respond({ ok: true })
      } else if (message.type === 'CAPTURE_FOCUS_TARGET') {
        const command = captureTargetCommandSchema.parse(message)
        if (command.type !== 'CAPTURE_FOCUS_TARGET')
          throw new CaptureTargetError('forbidden')
        const state = await browser.storage.local.get<LegacyStorage>([
          'recording',
          'captureReview',
        ])
        const walkthrough = await guide.state()
        if (
          pairing.busy ||
          legacyStarting ||
          state.recording ||
          ![undefined, 'idle'].includes(state.captureReview?.phase) ||
          (walkthrough && walkthrough.phase !== 'complete')
        )
          throw new CaptureTargetError('busy')
        await targets.focus(command.target)
        respond({ ok: true })
      } else if (message.type === 'GUIDE_START') {
        if (pairing.busy) throw new Error('Pairing active')
        if (typeof message.id !== 'string') throw new Error('Invalid guide')
        const run = await guide.start(message.id)
        respond({ ok: true, runId: run.runId })
      } else if (message.type === 'GUIDE_CLEAR') {
        await guide.clear()
        respond({ ok: true })
      } else if (message.type === 'GUIDE_CONTROL') {
        await guide.control(message, { ownControls, tabId: sender.tab?.id })
        respond({ ok: true })
      } else if (message.type === 'GUIDE_MATCH') {
        await guide.match(message, sender.tab?.id, sender.frameId)
        respond({ ok: true })
      } else if (
        message.type === 'GUIDE_READY' ||
        message.type === 'GUIDE_REFRESH'
      ) {
        const run = await guide.state()
        if (
          run &&
          (ownControls || sender.tab?.id === run.tabId) &&
          (message.type === 'GUIDE_READY' ||
            (message.runId === run.runId && message.sequence === run.sequence))
        )
          await guide.refresh(run.tabId)
        respond({ ok: true })
      } else if (message.type === 'OPEN_CAPTURE_REVIEW') {
        const state = await browser.storage.local.get<LegacyStorage>([
          'captureSessionId',
          'captureReview',
        ])
        if (
          !state.captureSessionId ||
          message.sessionId !== state.captureSessionId ||
          state.captureReview?.phase !== 'review'
        )
          throw new Error('Review unavailable')
        await openReview(true)
        respond({ ok: true })
      } else if (message.type === 'START' || message.type === 'START_CAPTURE') {
        if (activeSave) throw new DestinationFailure('busy')
        if (pairing.busy) throw new Error('Pairing active')
        const local = message.type === 'START_CAPTURE'
        const start = local ? captureStartSchema.parse(message) : undefined
        if (local && legacyStarting) throw new CaptureTargetError('busy')
        if (
          local &&
          ownControls &&
          new URL(sender.url!).searchParams.get('surface') === 'tab' &&
          !start?.target
        )
          throw new CaptureTargetError('unavailable')
        const walkthrough = await guide.state()
        if (walkthrough && walkthrough.phase !== 'complete')
          throw new Error('Walkthrough active')
        const previous = await browser.storage.local.get<LegacyStorage>([
          'recording',
          'captureReview',
          'captureDestination',
        ])
        const destination = local
          ? await destinations.validate(
              destinationChoice(previous.captureDestination),
            )
          : { kind: 'browser' as const }
        if (
          local &&
          (previous.recording ||
            !['idle', undefined].includes(previous.captureReview?.phase))
        )
          throw new Error('Capture already active')
        const tab = local
          ? start?.target
            ? await targets.focus(start.target)
            : await targets.active()
          : (await browser.tabs.query({ active: true, currentWindow: true }))[0]
        if (!tab?.id) throw new Error('No capture tab')
        const startedUrl = safeUrl(tab.url ?? '')
        const captureSource = await targets.identity(tab)
        if (walkthrough) await guide.clear()
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
          expectationOwner = undefined
          await previews.clear().catch(() => {})
          await browser.storage.local.set({
            recording: false,
            steps: [],
            capturedSteps: [],
            captureSessionId,
            captureTabId: tab.id,
            captureSource,
            captureError: null,
            startedUrl,
            captureBlurMode: false,
            captureManualCount: 0,
            captureReview: {
              phase: 'starting',
              title: suggestedTitle(startedUrl),
              revision: 0,
              preferences:
                previous.captureReview?.preferences ??
                capturePreferencesSchema.parse({}),
              startedAt: new Date().toISOString(),
              clock: stopClock(),
              destination,
            },
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
        if (
          local &&
          new URL(primed.scene.top.url!).origin !== captureSource.origin
        ) {
          await abort(captureSessionId)
          throw new CaptureTargetError('changed')
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
          producerStopped = false
          const { captureReview } =
            await browser.storage.local.get<LegacyStorage>('captureReview')
          await browser.storage.local.set({
            recording: true,
            captureReview: {
              ...captureReview,
              phase: 'recording',
              clock: startClock(),
            },
          })
        })
        await broadcast()
        respond({ ok: true })
      } else if (
        message.type === 'CANCEL' ||
        message.type === 'DISCARD_CAPTURE'
      ) {
        if (message.type === 'CANCEL') activeSave?.controller.abort()
        if (
          message.type === 'DISCARD_CAPTURE' &&
          message.sessionId !==
            (await browser.storage.local.get<LegacyStorage>('captureSessionId'))
              .captureSessionId
        )
          throw new Error('Stale capture')
        await mutate(async () => {
          queue.clear()
          expectations.clear()
          manualCounts.clear()
          privacyEpoch++
          await previews.clear().catch(() => {})
          await browser.storage.local.set({
            recording: false,
            steps: [],
            capturedSteps: [],
            captureSessionId: crypto.randomUUID(),
            captureError: null,
            captureBlurMode: false,
            captureManualCount: 0,
            captureReview: {
              phase: 'idle',
              preferences: (
                await browser.storage.local.get<LegacyStorage>('captureReview')
              ).captureReview?.preferences,
            },
          })
        })
        await broadcast()
        respond({ ok: true })
      } else if (message.type === 'SET_CAPTURE_PREFERENCES') {
        const { captureReview } =
          await browser.storage.local.get<LegacyStorage>('captureReview')
        if (captureReview?.phase && captureReview.phase !== 'idle')
          throw new Error('Capture active')
        await browser.storage.local.set({
          captureReview: {
            ...captureReview,
            preferences: capturePreferencesSchema.parse(message.preferences),
          },
        })
        respond({ ok: true })
      } else if (
        ['PAUSE_CAPTURE', 'RESUME_CAPTURE', 'STOP_REVIEW'].includes(
          message.type,
        )
      ) {
        const state = await browser.storage.local.get<LegacyStorage>([
          'recording',
          'captureSessionId',
          'captureTabId',
          'captureError',
          'captureReview',
        ])
        const review = state.captureReview ?? {}
        if (message.sessionId !== state.captureSessionId)
          throw new Error('Stale session')
        if (message.type === 'RESUME_CAPTURE') {
          if (
            review.phase !== 'paused' ||
            state.captureError ||
            !state.captureTabId
          )
            throw new Error('Capture cannot resume')
          const tab = await browser.tabs.get(state.captureTabId)
          const frame = await takeFrame(
            {
              tabId: state.captureTabId,
              windowId: tab.windowId,
              sessionId: state.captureSessionId!,
            },
            true,
          )
          queue.primeFrame(frame)
          producerStopped = false
          await browser.storage.local.set({
            recording: true,
            captureReview: {
              ...review,
              phase: 'recording',
              clock: startClock(review.clock),
            },
          })
        } else {
          if (!state.recording && review.phase !== 'paused')
            throw new Error('Capture inactive')
          producerStopped = true
          await browser.storage.local.set({
            captureReview: {
              ...review,
              phase: message.type === 'PAUSE_CAPTURE' ? 'pausing' : 'stopping',
              clock: stopClock(review.clock),
            },
            captureBlurMode: false,
          })
          await broadcast()
          await queue.drain()
          await writes
          const latest = await browser.storage.local.get<LegacyStorage>([
            'captureError',
            'captureReview',
            'guideMe',
          ])
          await browser.storage.local.set({
            recording: false,
            captureReview: {
              ...latest.captureReview,
              phase:
                message.type === 'PAUSE_CAPTURE' && !latest.captureError
                  ? 'paused'
                  : 'review',
            },
          })
          queue.clear()
        }
        await broadcast()
        if (fromPill && message.type === 'STOP_REVIEW') await openReview()
        respond({ ok: true })
      } else if (
        message.type === 'EDIT_REVIEW' ||
        message.type === 'SAVE_CAPTURE'
      ) {
        const state = await browser.storage.local.get<LegacyStorage>([
          'captureSessionId',
          'captureReview',
          'captureError',
          'capturedSteps',
          'steps',
          'startedUrl',
        ])
        const review = state.captureReview
        if (
          review?.phase !== 'review' ||
          message.sessionId !== state.captureSessionId ||
          message.revision !== review.revision
        )
          throw new Error('Review changed')
        if (message.type === 'EDIT_REVIEW') {
          if (review.savedId || review.remoteSaved || review.remoteAttempt)
            throw new Error('Capture already committed')
          const edit = reviewEditSchema.parse(message.edit)
          if (edit.operation === 'title') review.title = edit.title
          else {
            const result = editReview(
              state.capturedSteps ?? [],
              state.steps ?? [],
              edit,
            )
            await browser.storage.local.set({
              capturedSteps: result.steps,
              steps: result.images,
            })
          }
          await browser.storage.local.set({
            captureReview: { ...review, revision: (review.revision ?? 0) + 1 },
          })
          respond({ ok: true })
        } else {
          const parsed = captureSaveCommandSchema.safeParse(message)
          if (!parsed.success) throw new DestinationFailure('forbidden')
          const command = parsed.data
          if (state.captureError)
            throw new DestinationFailure('invalid_capture')
          const operation = {
            sessionId: state.captureSessionId!,
            controller: new AbortController(),
          }
          activeSave = operation
          try {
            await mutate(async () => {
              const current = await browser.storage.local.get<LegacyStorage>([
                'captureSessionId',
                'captureReview',
              ])
              if (
                operation.controller.signal.aborted ||
                current.captureSessionId !== operation.sessionId ||
                current.captureReview?.phase !== 'review' ||
                current.captureReview.revision !== review.revision
              )
                throw new DestinationFailure('stale')
              await browser.storage.local.set({
                captureReview: {
                  ...review,
                  phase: 'saving',
                  saveError: undefined,
                },
              })
            })
          } catch (error) {
            if (activeSave === operation) activeSave = undefined
            throw destinationError(error)
          }
          const assertSaving = async () => {
            if (activeSave !== operation || operation.controller.signal.aborted)
              throw new DestinationFailure('cancelled')
            const current = await browser.storage.local.get<LegacyStorage>([
              'captureSessionId',
              'captureReview',
            ])
            if (
              current.captureSessionId !== operation.sessionId ||
              current.captureReview?.phase !== 'saving' ||
              current.captureReview.revision !== review.revision
            )
              throw new DestinationFailure('stale')
            return current.captureReview
          }
          const remember = (update: (current: ReviewState) => ReviewState) =>
            mutate(async () => {
              const current = await assertSaving()
              await browser.storage.local.set({
                captureReview: update(current),
              })
            })
          const draft = {
            sessionId: operation.sessionId,
            title: review.title!,
            startedAt: review.startedAt!,
            startedUrl: state.startedUrl!,
            steps: state.capturedSteps ?? [],
            images: state.steps ?? [],
          }
          try {
            const destination = command.keepLocal
              ? { kind: 'browser' as const }
              : destinationChoice(review.destination)
            let id: string, url: string
            if (destination.kind === 'browser') {
              const saved = await saveCapture(draft).catch(() => {
                throw new DestinationFailure('storage_unavailable')
              })
              id = saved.id
              await remember((current) => ({ ...current, savedId: id }))
              url = browser.runtime.getURL(
                `/app.html?route=${encodeURIComponent(`/g/${id}/edit?step=1`)}`,
              )
            } else {
              let receipt = review.remoteSaved
              if (!receipt) {
                receipt = await destinations.upload(draft, destination, {
                  signal: operation.controller.signal,
                  guard: async () => {
                    await assertSaving()
                  },
                  started: () =>
                    remember((current) => ({
                      ...current,
                      remoteAttempt: destination,
                    })),
                })
                await remember((current) => ({
                  ...current,
                  remoteSaved: receipt,
                }))
              }
              id = receipt.id
              url = await destinations.editor(receipt, operation.sessionId)
            }
            await assertSaving()
            if (command.openEditor !== false) {
              try {
                await browser.tabs.create({ url })
              } catch {
                throw new DestinationFailure('editor_unavailable')
              }
            }
            await mutate(async () => {
              await assertSaving()
              await previews.clear().catch(() => {})
              await browser.storage.local.set({
                recording: false,
                steps: [],
                capturedSteps: [],
                captureReview: {
                  phase: 'idle',
                  preferences: review.preferences,
                  ...(destination.kind === 'browser' && { savedId: id }),
                },
              })
            })
            respond({ ok: true, id })
          } catch (error) {
            const failure = destinationError(error)
            try {
              await remember((current) => ({
                ...current,
                phase: 'review',
                saveError: failure.code,
              }))
            } catch {}
            throw failure
          } finally {
            if (activeSave === operation) activeSave = undefined
          }
        }
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
          'captureReview',
        ])
        if (
          !sender.tab ||
          sender.tab.id !== state.captureTabId ||
          message.sessionId !== state.captureSessionId ||
          !state.recording ||
          producerStopped ||
          ['pausing', 'stopping', 'paused', 'review'].includes(
            state.captureReview?.phase ?? '',
          )
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
          // Frame renderers can deliver an old observation after another action
          // has already caused its UI. Such a guess cannot own that result.
          if (
            !expectationOwner ||
            expectationOwner.sessionId !== message.sessionId ||
            expectationOwner.id !== message.id ||
            expectationOwner.frameId !== (sender.frameId ?? 0)
          ) {
            respond({ ok: true })
            return
          }
          await mutate(async () => {
            const latest = await browser.storage.local.get<LegacyStorage>([
              'captureSessionId',
              'capturedSteps',
              'captureReview',
            ])
            if (latest.captureSessionId !== message.sessionId) return
            if (expectations.size >= 500 && !expectations.has(message.id))
              return
            expectations.set(message.id, expectation)
            const capturedSteps = latest.capturedSteps ?? []
            const step = capturedSteps.find((step) => step.id === message.id)
            if (
              step &&
              latest.captureReview?.preferences?.agentContext !== false
            ) {
              step.expect = expectation
              await browser.storage.local.set({ capturedSteps })
            }
          })
          respond({ ok: true })
          return
        }
        const event = localCaptureSchema.parse(message.event)
        expectationOwner = {
          sessionId: message.sessionId,
          id: event.step.id,
          frameId: sender.frameId ?? 0,
        }
        const pending: Pending = {
          event,
          sessionId: message.sessionId,
          tabId: sender.tab.id!,
          windowId: sender.tab.windowId,
          frameId: sender.frameId ?? 0,
        }
        // Acknowledge acceptance without holding a source message channel open
        // through the entire image queue. Large captures can outlive that channel.
        // Controls still drain the queue before pause, review or save; a failed
        // queued capture stops an active matching session through the same privacy
        // gate, preserving any specific error already reported by the camera path.
        void queue
          .enqueue(pending)
          .catch(() => abort(pending.sessionId, 'metadata', true))
          .catch(() => {})
        respond({ ok: true })
      } else if (message.type === 'STOP') {
        await queue.drain()
        await writes
        const state =
          await browser.storage.local.get<LegacyStorage>('captureError')
        await browser.storage.local.set({
          recording: false,
          captureReview: { phase: 'idle' },
        })
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
          'captureReview',
          'capturedSteps',
        ])
        respond(captureSourceState(state, sender.tab?.id))
      } else if (message.type === 'GET_STATE') {
        if (!ownControls) {
          respond({ ok: false, error: 'forbidden' })
          return
        }
        respond(
          captureControls(
            await browser.storage.local.get<LegacyStorage>([
              'recording',
              'capturedSteps',
              'captureSessionId',
              'captureError',
              'pendingSession',
              'captureBlurMode',
              'captureManualCount',
              'captureReview',
              'guideMe',
              'captureDestination',
            ]),
          ),
        )
      }
    }
    if (message.type === 'START') {
      if (!ownControls) {
        respond({ ok: false, error: 'Capture operation failed' })
        return
      }
      // Keep v1 cancellation/restart scheduling while excluding pairing during start.
      legacyStarting++
      void run()
        .finally(() => {
          legacyStarting--
        })
        .catch(() => respond({ ok: false, error: 'Capture operation failed' }))
    } else if (privateCommands.includes(message.type)) {
      const next = commands.then(async () => {
        privateRunning = true
        try {
          await run()
        } finally {
          privateRunning = false
        }
      })
      commands = next.then(
        () => {},
        () => {},
      )
      void next.catch((error: unknown) =>
        respond({
          ok: false,
          error: 'Capture operation failed',
          ...(error instanceof CaptureTargetError ? { code: error.code } : {}),
          ...(error instanceof DestinationFailure
            ? { destinationCode: error.code }
            : {}),
        }),
      )
    } else
      void run().catch(() =>
        respond({ ok: false, error: 'Capture operation failed' }),
      )
    return true
  })
  browser.tabs.onUpdated.addListener((id, info) => {
    if (info.status === 'complete' || info.url)
      void guide.refresh(id).catch(() => {})
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

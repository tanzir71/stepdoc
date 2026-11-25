import { browser } from 'wxt/browser'
import { makeStep } from './capture'
import { composite } from './image'
import { CaptureQueue } from '@stepdoc/core/capture-queue'
import type { ElementMeta } from '@stepdoc/schema/legacy-v1'
import tokens from '../../../docs/v2/design-tokens.json'

type Pending = {
  meta: ElementMeta
  sensitive: { x: number; y: number; width: number; height: number }[]
}
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
  startedUrl?: string
  appUrl?: string
  pendingSession?: SessionBody
}

export function startBackground() {
  if (import.meta.env.BROWSER !== 'firefox') {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  }
  let lastCapture = 0
  const queue = new CaptureQueue<Pending>(
    async () => {
      const wait = 550 - (Date.now() - lastCapture)
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      const frame = await browser.tabs.captureVisibleTab({ format: 'png' })
      lastCapture = Date.now()
      return frame
    },
    async ({ event, frame }) => {
      const shot = await composite(
        frame,
        event.sensitive,
        undefined,
        event.meta.devicePixelRatio,
      )
      const value = await browser.storage.local.get<LegacyStorage>('steps')
      const steps = [
        ...(value.steps ?? []),
        {
          ...makeStep(event.meta),
          position: (value.steps ?? []).length,
          screenshot: shot,
        },
      ]
      await browser.storage.local.set({ steps })
      await updateBadge()
    },
  )

  async function updateBadge() {
    const value = await browser.storage.local.get<LegacyStorage>([
      'recording',
      'steps',
    ])
    await browser.action.setBadgeText({
      text: value.recording ? String((value.steps ?? []).length) : '',
    })
    await browser.action.setBadgeBackgroundColor({
      color: tokens.color['accent/solid'].light,
    })
  }

  browser.runtime.onMessage.addListener((message, _sender, respond) => {
    void (async () => {
      if (message.type === 'START') {
        queue.clear()
        await browser.storage.local.set({
          recording: true,
          steps: [],
          startedUrl: message.url,
        })
        await broadcast(true)
        respond({ ok: true })
      }
      if (message.type === 'CANCEL') {
        queue.clear()
        await browser.storage.local.set({ recording: false, steps: [] })
        await broadcast(false)
        respond({ ok: true })
      }
      if (message.type === 'CAPTURE') {
        await queue.enqueue({
          meta: message.meta,
          sensitive: message.sensitive,
        })
        respond({ ok: true })
      }
      if (message.type === 'STOP') {
        await queue.drain()
        await browser.storage.local.set({ recording: false })
        await broadcast(false)
        respond(await upload())
      }
      if (message.type === 'RETRY') respond(await retry())
      if (message.type === 'GET_STATE')
        respond(
          await browser.storage.local.get<LegacyStorage>([
            'recording',
            'steps',
            'pendingSession',
          ]),
        )
      return true
    })().catch(() => respond({ ok: false, error: 'Capture operation failed' }))
    return true
  })

  browser.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === 'complete') {
      browser.storage.local.get<LegacyStorage>('recording').then((value) => {
        if (value.recording && tab.url?.startsWith('http')) {
          void queue.enqueue({
            meta: {
              event: 'navigation',
              tag: 'body',
              url: tab.url,
              pageTitle: tab.title,
            },
            sensitive: [],
          })
        }
      })
    }
  })

  async function broadcast(recording: boolean) {
    await updateBadge()
    const tabs = await browser.tabs.query({})
    for (const tab of tabs)
      if (tab.id)
        browser.tabs
          .sendMessage(tab.id, { type: 'STATE', recording })
          .catch(() => {})
  }

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

import { makeStep } from './capture'
import { composite } from './image'
import { CaptureQueue } from './queue'
import type { ElementMeta } from '@stepdoc/shared'

type Pending = { meta: ElementMeta; sensitive: { x: number; y: number; width: number; height: number }[] }
type SessionBody = { title: string; description: string; sourceUrl?: string; steps: unknown[] }

let lastCapture = 0
const queue = new CaptureQueue<Pending>(
  async () => {
    const wait = 550 - (Date.now() - lastCapture)
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    const frame = await chrome.tabs.captureVisibleTab({ format: 'png' })
    lastCapture = Date.now()
    return frame
  },
  async ({ event, frame }) => {
    const shot = await composite(frame, event.sensitive, undefined, event.meta.devicePixelRatio)
    const value = await chrome.storage.local.get('steps')
    const steps = [
      ...(value.steps ?? []),
      { ...makeStep(event.meta), position: (value.steps ?? []).length, screenshot: shot },
    ]
    await chrome.storage.local.set({ steps })
    await updateBadge()
  },
)

async function updateBadge() {
  const value = await chrome.storage.local.get(['recording', 'steps'])
  await chrome.action.setBadgeText({ text: value.recording ? String((value.steps ?? []).length) : '' })
  await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' })
}

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  void (async () => {
    if (message.type === 'START') {
      queue.clear()
      await chrome.storage.local.set({ recording: true, steps: [], startedUrl: message.url })
      await broadcast(true)
    }
    if (message.type === 'CANCEL') {
      queue.clear()
      await chrome.storage.local.set({ recording: false, steps: [] })
      await broadcast(false)
    }
    if (message.type === 'CAPTURE') void queue.enqueue({ meta: message.meta, sensitive: message.sensitive })
    if (message.type === 'STOP') {
      await queue.drain()
      await chrome.storage.local.set({ recording: false })
      await broadcast(false)
      respond(await upload())
    }
    if (message.type === 'RETRY') respond(await retry())
    if (message.type === 'GET_STATE') respond(await chrome.storage.local.get(['recording', 'steps', 'pendingSession']))
    return true
  })()
  return true
})

chrome.tabs.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete') {
    chrome.storage.local.get('recording').then((value) => {
      if (value.recording && tab.url?.startsWith('http')) {
        void queue.enqueue({
          meta: { event: 'navigation', tag: 'body', url: tab.url, pageTitle: tab.title },
          sensitive: [],
        })
      }
    })
  }
})

async function broadcast(recording: boolean) {
  await updateBadge()
  const tabs = await chrome.tabs.query({})
  for (const tab of tabs) if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'STATE', recording }).catch(() => {})
}

async function retry() {
  const value = await chrome.storage.local.get('pendingSession')
  return value.pendingSession ? upload(value.pendingSession) : { ok: false, error: 'No saved upload' }
}

async function upload(saved?: SessionBody) {
  const value = await chrome.storage.local.get(['steps', 'startedUrl', 'appUrl'])
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
    await chrome.storage.local.remove(['steps', 'pendingSession'])
    await chrome.tabs.create({ url: `${app}/guides/${data.id}/edit` })
    return { ok: true }
  } catch (error) {
    await chrome.storage.local.set({ pendingSession: body })
    const url = URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' }))
    await chrome.downloads.download({ url, filename: 'stepdoc-session.json' })
    return { ok: false, error: error instanceof Error ? error.message : 'Upload failed' }
  }
}

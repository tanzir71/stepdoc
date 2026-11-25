import './style.css'
import { browser } from 'wxt/browser'

const $ = (id: string) => document.getElementById(id)!

async function refresh() {
  const state = await browser.runtime.sendMessage({ type: 'GET_STATE' })
  $('status').textContent =
    state.captureError ??
    (state.recording
      ? `Recording - ${(state.steps ?? []).length} steps`
      : state.pendingSession
        ? 'Saved upload waiting'
        : 'Ready to capture')
  ;($('retry') as HTMLButtonElement).disabled = !state.pendingSession
}

$('start').onclick = async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
  await browser.runtime.sendMessage({ type: 'START', url: tab?.url })
  void refresh()
}

$('stop').onclick = async () => {
  $('status').textContent = 'Saving...'
  const result = await browser.runtime.sendMessage({ type: 'STOP' })
  $('status').textContent = result.ok
    ? 'Guide opened'
    : 'Saved locally; retry after app starts'
  void refresh()
}

$('retry').onclick = async () => {
  $('status').textContent = 'Retrying upload...'
  const result = await browser.runtime.sendMessage({ type: 'RETRY' })
  $('status').textContent = result.ok ? 'Guide opened' : 'Still saved locally'
  void refresh()
}

$('cancel').onclick = async () => {
  await browser.runtime.sendMessage({ type: 'CANCEL' })
  void refresh()
}

void refresh()

browser.storage.onChanged.addListener((changes, area) => {
  if (
    area === 'local' &&
    ['recording', 'steps', 'captureError', 'pendingSession'].some(
      (key) => key in changes,
    )
  )
    void refresh()
})

import { browser } from 'wxt/browser'
import type {
  StepDocExtension,
  WalkthroughResult,
} from '../../app/src/extension'
import { receiveCaptureNotice } from './control-notice'

const listeners = new Set<(result: WalkthroughResult) => void>()
const bridge: StepDocExtension = {
  async guideMe(id) {
    const response = await browser.runtime.sendMessage({
      type: 'GUIDE_START',
      id,
    })
    if (!response?.ok) throw new Error('Walkthrough could not start')
  },
  subscribeGuideMe(callback) {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  },
}
window.stepdocExtension = bridge
browser.runtime.onMessage.addListener((message: unknown, sender) => {
  const result = receiveCaptureNotice(message, sender)?.guideResult
  if (!result) return
  for (const listener of listeners) listener(result)
})
void import('../../app/src/main')

import { browser } from 'wxt/browser'
import type {
  StepDocExtension,
  WalkthroughResult,
} from '../../app/src/extension'
import type { GuideRun } from './guide-run'

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
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.guideMe?.newValue) return
  const run = changes.guideMe.newValue as GuideRun
  if (!['complete', 'conflict', 'save-error'].includes(run.phase)) return
  for (const listener of listeners)
    listener({ guideId: run.guideId, saved: run.phase === 'complete' })
})
void import('../../app/src/main')

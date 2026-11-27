import { afterEach, describe, expect, it, vi } from 'vitest'
import { browser } from 'wxt/browser'
import {
  notifyCaptureControls,
  receiveCaptureNotice,
} from './control-notice'

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'notice-extension',
      getURL: (path: string) =>
        'chrome-extension://notice-extension' + path,
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  },
}))
const sender = {
  id: 'notice-extension',
  url: 'chrome-extension://notice-extension/background.js',
}
afterEach(() => vi.mocked(browser.runtime.sendMessage).mockReset())
describe('private bounded control notifications', () => {
  it('publishes a data-free invalidation', () => {
    vi.mocked(browser.runtime.sendMessage).mockResolvedValue(undefined)
    notifyCaptureControls()
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_CHANGED',
    })
  })
  it('copies only terminal result fields without reading retained images', () => {
    vi.mocked(browser.runtime.sendMessage).mockResolvedValue(undefined)
    const result = { guideId: 'notice-guide', saved: true }
    Object.defineProperty(result, 'images', {
      enumerable: true,
      get() {
        throw new Error('Image read')
      },
    })
    notifyCaptureControls(result)
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'CAPTURE_CHANGED',
      guideResult: { guideId: 'notice-guide', saved: true },
    })
  })
  it('tolerates a closed reader without leaking a native error', async () => {
    vi.mocked(browser.runtime.sendMessage).mockRejectedValue(
      new Error('PRIVATE_NATIVE'),
    )
    expect(() => notifyCaptureControls()).not.toThrow()
    await Promise.resolve()
  })
  it('accepts a validated background notice', () => {
    expect(
      receiveCaptureNotice({ type: 'CAPTURE_CHANGED' }, sender),
    ).toEqual({ type: 'CAPTURE_CHANGED' })
  })
  it.each([
    { id: 'other', url: sender.url },
    { ...sender, tab: { id: 3 } },
    {
      id: sender.id,
      url: 'chrome-extension://notice-extension-evil/background.js',
    },
    { id: sender.id },
  ])('rejects an untrusted emitter %j', (untrusted) => {
    expect(
      receiveCaptureNotice({ type: 'CAPTURE_CHANGED' }, untrusted),
    ).toBeUndefined()
  })
  it('rejects a storage/image payload even from the owned origin', () => {
    expect(
      receiveCaptureNotice(
        { type: 'CAPTURE_CHANGED', steps: ['PRIVATE_IMAGE'] },
        sender,
      ),
    ).toBeUndefined()
  })
})

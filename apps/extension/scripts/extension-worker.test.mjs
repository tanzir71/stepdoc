import { describe, expect, it, vi } from 'vitest'
import { extensionWorker } from './extension-worker.mjs'

describe('loaded-extension verifier startup', () => {
  it('opens the installed private page before expecting a cold MV3 worker', async () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop'
    let awake = false
    let url = ''
    const worker = {
      url: () => `chrome-extension://${id}/background.js`,
      evaluate: vi.fn(async () => true),
    }
    const page = {
      goto: vi.fn(async (next) => {
        url = next
        if (next === `chrome-extension://${id}/options.html`) awake = true
      }),
      evaluate: vi.fn(async () =>
        url === 'chrome://extensions/'
          ? [{ id, name: 'StepDoc Capture' }]
          : awake,
      ),
      close: vi.fn(async () => {}),
    }
    const context = {
      serviceWorkers: vi.fn(() => (awake ? [worker] : [])),
      newPage: vi.fn(async () => page),
      waitForEvent: vi.fn(async () => {
        if (!awake) throw new Error('No event until the extension is activated')
        return worker
      }),
    }
    expect(await extensionWorker(context)).toBe(worker)
    expect(page.goto.mock.calls.map(([url]) => url)).toEqual([
      'chrome://extensions/',
      `chrome-extension://${id}/options.html`,
    ])
    expect(page.close).toHaveBeenCalledOnce()
    expect(worker.evaluate).toHaveBeenCalledOnce()
  })
})

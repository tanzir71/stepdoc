import { describe, it, expect, vi } from 'vitest'
import {
  CaptureTargets,
  CaptureTargetError,
  webCaptureTarget,
  type CaptureTab,
} from './capture-target'
import {
  readTargetChoice,
  writeTargetChoice,
  targetKey,
} from './capture-target-url'
import {
  captureStartSchema,
  captureTargetCommandSchema,
  captureTargetListSchema,
  captureTargetSchema,
} from '@stepdoc/schema/capture-target'

const session = crypto.randomUUID()
const target = {
  tabId: 4,
  origin: 'https://example.test',
  browserSession: session,
}
function setup() {
  const tabs: CaptureTab[] = [
    {
      id: 4,
      windowId: 1,
      active: true,
      status: 'complete',
      url: 'https://example.test/PRIVATE_PATH?PRIVATE_QUERY#PRIVATE_FRAGMENT',
    },
    {
      id: 5,
      windowId: 2,
      active: true,
      status: 'loading',
      url: 'https://other.test/page',
    },
    {
      id: 6,
      windowId: 2,
      active: false,
      status: 'complete',
      url: 'chrome-extension://private/popup.html',
    },
  ]
  const access = {
    browserSession: vi.fn(async () => session),
    tabs: vi.fn(async () => structuredClone(tabs)),
    active: vi.fn(async () => structuredClone(tabs[0])),
    get: vi.fn(async (id: number) => {
      const tab = tabs.find((value) => value.id === id)
      if (!tab) throw new Error('PRIVATE_BROWSER_ERROR')
      return structuredClone(tab)
    }),
    activate: vi.fn(async (id: number, _window: number) => {
      for (const tab of tabs) tab.active = tab.id === id
    }),
  }
  return { tabs, access, controller: new CaptureTargets(access) }
}
describe('browser-owned capture target resolution', () => {
  it('projects origins only, with readiness and an actual active-page suggestion', async () => {
    const f = setup(),
      result = await f.controller.list(false)
    expect(result.suggested).toEqual(target)
    expect(result.targets).toHaveLength(2)
    expect(result.targets[1]?.ready).toBe(false)
    expect(captureTargetListSchema.safeParse(result).success).toBe(true)
    expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  })
  it('does not pick an arbitrary active window for a full-tab control page', async () => {
    const f = setup()
    expect((await f.controller.list(true)).suggested).toBeNull()
    expect(f.access.active).not.toHaveBeenCalled()
    expect((await f.controller.list(true, target)).suggested).toEqual(target)
    expect(
      (
        await f.controller.list(true, {
          ...target,
          browserSession: crypto.randomUUID(),
        })
      ).suggested,
    ).toBeNull()
    expect(
      (await f.controller.list(true, { ...target, origin: 'https://old.test' }))
        .suggested,
    ).toBeNull()
  })
  it('allows authenticated web pages while discarding URL credentials from control data', () => {
    expect(
      webCaptureTarget(
        {
          id: 4,
          windowId: 1,
          active: true,
          url: 'https://PRIVATE_USER:PRIVATE_PASSWORD@example.test/PRIVATE_PATH',
        },
        session,
      ),
    ).toEqual(target)
  })
  it('resolves and focuses the exact browser-owned window, then revalidates', async () => {
    const f = setup()
    f.tabs[0]!.active = false
    expect((await f.controller.focus(target)).active).toBe(true)
    expect(f.access.activate).toHaveBeenCalledWith(4, 1)
    expect(f.access.get).toHaveBeenCalledTimes(2)
  })
  it.each(['closed', 'origin', 'loading', 'private', 'identity'])(
    'rejects a %s target before focus',
    async (mode) => {
      const f = setup()
      if (mode === 'closed') f.tabs.length = 0
      if (mode === 'origin') f.tabs[0]!.url = 'https://changed.test/PRIVATE'
      if (mode === 'loading') f.tabs[0]!.status = 'loading'
      if (mode === 'private') f.tabs[0]!.url = 'about:blank'
      if (mode === 'identity')
        f.access.get.mockResolvedValue({ ...f.tabs[0]!, id: 99 })
      await expect(f.controller.focus(target)).rejects.toBeInstanceOf(
        CaptureTargetError,
      )
      expect(f.access.activate).not.toHaveBeenCalled()
    },
  )
  it('rejects a recycled tab identity from an older browser session before reading it', async () => {
    const f = setup()
    await expect(
      f.controller.focus({ ...target, browserSession: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'expired' })
    expect(f.access.get).not.toHaveBeenCalled()
    expect(f.access.activate).not.toHaveBeenCalled()
  })
  it.each(['origin', 'window', 'focus', 'session'])(
    'revalidates %s after activation',
    async (mode) => {
      const f = setup()
      f.access.activate.mockImplementationOnce(async () => {
        if (mode === 'origin') f.tabs[0]!.url = 'https://changed.test/PRIVATE'
        if (mode === 'window') f.tabs[0]!.windowId = 8
        if (mode === 'focus') f.tabs[0]!.active = false
        if (mode === 'session')
          f.access.browserSession.mockResolvedValue(crypto.randomUUID())
      })
      await expect(f.controller.focus(target)).rejects.toBeInstanceOf(
        CaptureTargetError,
      )
    },
  )
  it('reports browser failures with fixed codes and never falls back from a non-web active tab', async () => {
    const f = setup()
    f.access.tabs.mockRejectedValue(new Error('PRIVATE_BROWSER_ERROR'))
    await expect(f.controller.list(false)).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Capture target operation failed: unavailable',
    })
    f.access.active.mockResolvedValue(f.tabs[2]!)
    await expect(f.controller.active()).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(f.access.get).not.toHaveBeenCalled()
  })
})
describe('private capture target protocol and deterministic URLs', () => {
  it('retains a selected target and the control route through reload', () => {
    const url = writeTargetChoice(
      new URL('chrome-extension://id/popup.html?surface=tab&view=pair'),
      { target, explicit: true, invalid: false },
    )
    expect(readTargetChoice(url.href)).toEqual({
      target,
      explicit: true,
      invalid: false,
    })
    expect(url.searchParams.get('view')).toBe('pair')
    expect(targetKey({ ...target })).toBe(targetKey(target))
  })
  it('keeps an explicit empty choice empty instead of suggesting a different tab', () => {
    const url = writeTargetChoice(new URL('moz-extension://id/popup.html'), {
      target: null,
      explicit: true,
      invalid: false,
    })
    expect(readTargetChoice(url.href)).toEqual({
      target: null,
      explicit: true,
      invalid: false,
    })
    expect(readTargetChoice('chrome-extension://id/popup.html')).toEqual({
      target: null,
      explicit: false,
      invalid: false,
    })
  })
  it.each(['0', '-1', '04', '4e0', '2147483648'])(
    'rejects ambiguous or unsupported tab ID %s',
    (id) => {
      const raw = `chrome-extension://id/popup.html?source=${id}&origin=https://example.test&browser-session=${session}`
      expect(readTargetChoice(raw).invalid).toBe(true)
    },
  )
  it('removes invalid address data and requires a fresh explicit selection', () => {
    const raw = new URL(
      `chrome-extension://id/popup.html?view=idle&source=4&origin=https://example.test/PRIVATE_PATH?PRIVATE_QUERY&browser-session=${session}`,
    )
    const choice = readTargetChoice(raw.href)
    expect(choice).toEqual({ target: null, explicit: true, invalid: true })
    const clean = writeTargetChoice(raw, choice)
    expect(clean.href).not.toContain('PRIVATE_')
    expect(readTargetChoice(clean.href).invalid).toBe(true)
  })
  it('accepts existing review fields but rejects unexpected values and URL credentials', () => {
    expect(
      captureStartSchema.safeParse({
        type: 'START_CAPTURE',
        target,
        sessionId: crypto.randomUUID(),
        revision: 0,
      }).success,
    ).toBe(true)
    expect(
      captureStartSchema.safeParse({
        type: 'START_CAPTURE',
        target,
        value: 'PRIVATE_TYPED_VALUE',
      }).success,
    ).toBe(false)
    expect(
      captureTargetCommandSchema.safeParse({
        type: 'CAPTURE_TARGETS',
        token: 'PRIVATE',
      }).success,
    ).toBe(false)
    for (const origin of [
      'chrome-extension://id',
      'file:///tmp',
      'https://user:PRIVATE@example.test',
      'https://example.test/PRIVATE',
      'https://example.test?PRIVATE',
    ])
      expect(captureTargetSchema.safeParse({ ...target, origin }).success).toBe(
        false,
      )
  })
})

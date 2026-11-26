import {
  captureTargetSchema,
  type CaptureTarget,
  type CaptureTargetErrorCode,
  type CaptureTargetList,
} from '@stepdoc/schema/capture-target'

export class CaptureTargetError extends Error {
  constructor(readonly code: CaptureTargetErrorCode) {
    super(`Capture target operation failed: ${code}`)
    this.name = 'CaptureTargetError'
  }
}
export interface CaptureTab {
  id?: number
  windowId: number
  url?: string
  status?: string
  active: boolean
}
type Access = {
  browserSession(): Promise<string>
  tabs(): Promise<CaptureTab[]>
  active(): Promise<CaptureTab | undefined>
  get(id: number): Promise<CaptureTab>
  activate(id: number, windowId: number): Promise<void>
}
export function webCaptureTarget(tab: CaptureTab, browserSession: string) {
  try {
    const url = new URL(tab.url ?? '')
    if (!['http:', 'https:'].includes(url.protocol)) return null
    return captureTargetSchema.parse({
      tabId: tab.id,
      origin: url.origin,
      browserSession,
    })
  } catch {
    return null
  }
}
/** Resolves browser-owned tab identities afresh before any recording mutation. */
export class CaptureTargets {
  constructor(private readonly access: Access) {}
  async list(
    fullTab: boolean,
    previous?: CaptureTarget,
  ): Promise<CaptureTargetList> {
    try {
      const browserSession = await this.access.browserSession()
      const previousTarget = captureTargetSchema.safeParse(previous)
      const tabs = await this.access.tabs()
      const targets = tabs
        .flatMap((tab) => {
          const target = webCaptureTarget(tab, browserSession)
          return target ? [{ ...target, ready: tab.status !== 'loading' }] : []
        })
        .sort((a, b) => a.origin.localeCompare(b.origin) || a.tabId - b.tabId)
      const active = fullTab
        ? null
        : webCaptureTarget(
            (await this.access.active()) ?? { windowId: -1, active: false },
            browserSession,
          )
      const suggested =
        targets.find(
          (target) =>
            active &&
            target.tabId === active.tabId &&
            target.origin === active.origin,
        ) ??
        targets.find(
          (target) =>
            previousTarget.success &&
            previousTarget.data.browserSession === browserSession &&
            target.tabId === previousTarget.data.tabId &&
            target.origin === previousTarget.data.origin,
        )
      return {
        targets,
        suggested: suggested
          ? { tabId: suggested.tabId, origin: suggested.origin, browserSession }
          : null,
      }
    } catch {
      throw new CaptureTargetError('unavailable')
    }
  }
  async resolve(target: CaptureTarget): Promise<CaptureTab> {
    if (target.browserSession !== (await this.access.browserSession()))
      throw new CaptureTargetError('expired')
    let tab: CaptureTab
    try {
      tab = await this.access.get(target.tabId)
    } catch {
      throw new CaptureTargetError('unavailable')
    }
    const current = webCaptureTarget(tab, target.browserSession)
    if (!current || current.tabId !== target.tabId)
      throw new CaptureTargetError('unavailable')
    if (current.origin !== target.origin)
      throw new CaptureTargetError('changed')
    if (tab.status === 'loading') throw new CaptureTargetError('loading')
    return tab
  }
  async active(): Promise<CaptureTab> {
    let active: CaptureTab | undefined
    try {
      active = await this.access.active()
    } catch {
      throw new CaptureTargetError('unavailable')
    }
    const target =
      active && webCaptureTarget(active, await this.access.browserSession())
    if (!target) throw new CaptureTargetError('unavailable')
    return this.resolve(target)
  }
  async focus(target: CaptureTarget): Promise<CaptureTab> {
    const before = await this.resolve(target)
    try {
      await this.access.activate(target.tabId, before.windowId)
    } catch {
      throw new CaptureTargetError('unavailable')
    }
    const after = await this.resolve(target)
    if (after.windowId !== before.windowId || !after.active)
      throw new CaptureTargetError('changed')
    return after
  }
  async identity(tab: CaptureTab): Promise<CaptureTarget> {
    const target = webCaptureTarget(tab, await this.access.browserSession())
    if (!target) throw new CaptureTargetError('unavailable')
    return target
  }
}

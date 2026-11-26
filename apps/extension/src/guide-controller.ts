import { browser } from 'wxt/browser'
import { IndexedDbAdapter, StorageError } from '@stepdoc/storage'
import { captureUrl } from '@stepdoc/core/capture'
import {
  transformRect,
  intersectRects,
  type FrameContext,
} from '@stepdoc/core/capture/geometry'
import {
  guideMeControlSchema,
  guideMeMatchSchema,
  guideMeLocatedSchema,
} from '@stepdoc/schema/guide-me'
import { FrameBroker, type FrameScene } from './frame-broker'
import {
  newGuideRun,
  advanceGuide,
  guideReport,
  type GuideRun,
} from './guide-run'

export class GuideController {
  private work = Promise.resolve()
  private refreshing = false
  constructor(private readonly broker: FrameBroker) {}
  async state() {
    return (await browser.storage.local.get<{ guideMe?: GuideRun }>('guideMe'))
      .guideMe
  }
  private async store(run: GuideRun) {
    await browser.storage.local.set({ guideMe: run })
  }
  private async show(run: GuideRun) {
    const step = run.steps[Math.min(run.index, run.steps.length - 1)]!
    await browser.tabs
      .sendMessage(run.tabId, {
        type: 'GUIDE_SHOW',
        view: {
          runId: run.runId,
          sequence: run.sequence,
          index: run.index,
          total: run.steps.length,
          phase: run.phase,
          title: step.title.slice(0, 5_000),
          description: step.description.slice(0, 20_000),
          reason: run.target.reason,
          rect: run.target.rect,
          report: run.report,
          confirmed: run.outcomes.filter((value) => value === 'confirmed')
            .length,
        },
      })
      .catch(() => {})
  }
  private serialize<T>(operation: () => Promise<T>) {
    const next = this.work.then(operation)
    this.work = next.then(
      () => {},
      () => {},
    )
    return next
  }
  async start(guideId: string) {
    return this.serialize(async () => {
      const active = await this.state()
      if (active && active.phase !== 'complete')
        throw new Error('Walkthrough active')
      if (active) await this.hide(active)
      const capture = await browser.storage.local.get<{
        recording?: boolean
        captureReview?: { phase?: string }
      }>(['recording', 'captureReview'])
      if (
        capture.recording ||
        ![undefined, 'idle'].includes(capture.captureReview?.phase)
      )
        throw new Error('Capture active')
      const storage = await IndexedDbAdapter.open()
      try {
        const guide = await storage.getGuide(guideId)
        const startPage = guide.preconditions
          .map((value) => /^Open (https?:\/\/\S+)$/u.exec(value)?.[1])
          .find(Boolean)
        const first =
          startPage ??
          guide.steps.find((step) => step.url && !step.target?.frame?.length)
            ?.url ??
          guide.app?.origin ??
          guide.steps.find((step) => step.url)?.url
        if (!first) throw new Error('No live page')
        const url = captureUrl(first)
        const tab = await browser.tabs.create({ url: 'about:blank' })
        if (!tab.id) throw new Error('Tab unavailable')
        const run = newGuideRun(guide, tab.id)
        await this.store(run)
        await browser.tabs.update(tab.id, { url })
        return run
      } finally {
        storage.close()
      }
    })
  }
  private async context(
    run: GuideRun,
    scene: FrameScene,
  ): Promise<FrameContext | undefined> {
    let context = scene.contexts.get(scene.top.documentId)
    for (const selector of run.steps[run.index]?.target?.frame ?? []) {
      if (!context) return
      const result: { documentId?: string; selector?: string } =
        await browser.tabs.sendMessage(
          run.tabId,
          { type: 'GUIDE_FRAME', selector },
          { frameId: scene.frameIds.get(context.documentId)! },
        )
      if (result.documentId !== context.documentId || !result.selector) return
      const path = [...context.frame, result.selector]
      context = [...scene.contexts.values()].find(
        (value) => JSON.stringify(value.frame) === JSON.stringify(path),
      )
    }
    return context
  }
  async refresh(tabId?: number) {
    if (this.refreshing) return
    this.refreshing = true
    try {
      await this.serialize(async () => {
        let run = await this.state()
        if (
          !run ||
          run.phase !== 'running' ||
          (tabId !== undefined && tabId !== run.tabId)
        )
          return
        const step = run.steps[run.index]!
        try {
          const tab = await browser.tabs.get(run.tabId)
          if (
            step.type === 'section' ||
            ((step.type === 'navigate' || step.action === 'navigate') &&
              step.url &&
              captureUrl(tab.url ?? '') === captureUrl(step.url))
          ) {
            run = advanceGuide(run, 'matched')
            await this.store(run)
            if (run.phase === 'saving') await this.finish(run)
            else {
              await this.show(run)
              setTimeout(() => {
                void this.refresh(run!.tabId)
              }, 0)
            }
            return
          }
          let scene = await this.broker.collect(run.tabId, true)
          let context = await this.context(run, scene)
          // Frame scrolling during path resolution changes projection geometry.
          scene = await this.broker.collect(run.tabId, true)
          context = context ? scene.contexts.get(context.documentId) : undefined
          if (!context) throw new Error('Context unavailable')
          if (
            step.url &&
            ![context.url, scene.top.url].includes(captureUrl(step.url))
          )
            throw new Error('Wrong live page')
          const frameId = scene.frameIds.get(context.documentId)!
          const located = guideMeLocatedSchema.parse(
            await browser.tabs.sendMessage(
              run.tabId,
              {
                type: 'GUIDE_LOCATE',
                runId: run.runId,
                sequence: run.sequence,
                step,
              },
              { frameId },
            ),
          )
          if (located.documentId !== context.documentId)
            throw new Error('Document changed')
          // Resolve again after scrollIntoView in the target document.
          scene = await this.broker.collect(run.tabId, true)
          context = scene.contexts.get(located.documentId)
          if (!context) throw new Error('Context changed')
          const rect = located.rect
            ? intersectRects(
                transformRect(context.transform, located.rect),
                context.clip,
              )
            : null
          run.target = {
            ...located,
            rect: rect && rect.width > 0 && rect.height > 0 ? rect : null,
            frameId,
          }
          if (located.rect && !run.target.rect)
            run.target.reason = 'unavailable'
          if (run.target.reason === 'matched')
            run.receipts = [
              ...(run.receipts ?? []).filter(
                (receipt) => receipt.token !== located.token,
              ),
              {
                sequence: run.sequence,
                frameId,
                documentId: located.documentId,
                token: located.token,
              },
            ].slice(-8)
        } catch {
          run.target = { reason: 'unavailable', rect: null }
        } finally {
          await this.broker.release(run.tabId)
        }
        await this.store(run)
        await this.show(run)
      })
    } finally {
      this.refreshing = false
    }
  }
  async control(
    raw: unknown,
    sender: { tabId?: number; ownControls: boolean },
  ) {
    return this.serialize(async () => {
      const command = guideMeControlSchema.parse(raw)
      let run = await this.state()
      if (
        !run ||
        run.runId !== command.runId ||
        run.sequence !== command.sequence ||
        (!sender.ownControls && sender.tabId !== run.tabId)
      )
        throw new Error('Stale walkthrough')
      if (
        command.action === 'dismiss' &&
        !['running', 'saving'].includes(run.phase)
      ) {
        await this.hide(run)
        await browser.storage.local.remove('guideMe')
        return
      }
      if (
        command.action === 'retry' &&
        ['save-error', 'conflict'].includes(run.phase)
      ) {
        await this.finish(run)
        return
      }
      if (run.phase !== 'running') throw new Error('Walkthrough ended')
      if (command.action === 'back') {
        if (run.index > 0) {
          run.index--
          run.sequence++
          run.outcomes.fill(null, run.index)
          run.target = { reason: 'missing', rect: null }
          run.receipts = []
        }
      } else if (command.action === 'stop') run.phase = 'saving'
      else if (command.action === 'skip' || command.action === 'confirm')
        run = advanceGuide(
          run,
          command.action === 'skip' ? 'skipped' : 'confirmed',
        )
      else throw new Error('Unsupported walkthrough action')
      await this.store(run)
      if (run.phase === 'saving') await this.finish(run)
      else {
        await this.show(run)
        setTimeout(() => {
          void this.refresh(run!.tabId)
        }, 0)
      }
    })
  }
  async match(raw: unknown, tabId?: number, frameId?: number) {
    return this.serialize(async () => {
      const match = guideMeMatchSchema.parse(raw)
      let run = await this.state()
      if (
        !run ||
        run.phase !== 'running' ||
        run.runId !== match.runId ||
        run.sequence !== match.sequence ||
        run.tabId !== tabId ||
        !(run.receipts ?? []).some(
          (receipt) =>
            receipt.sequence === match.sequence &&
            receipt.frameId === frameId &&
            receipt.documentId === match.documentId &&
            receipt.token === match.token,
        )
      )
        return
      run = advanceGuide(run, 'matched')
      await this.store(run)
      if (run.phase === 'saving') await this.finish(run)
      else {
        await this.show(run)
        setTimeout(() => {
          void this.refresh(run!.tabId)
        }, 0)
      }
    })
  }
  private async finish(run: GuideRun) {
    const report = run.report ?? guideReport(run)
    run.report = report
    let storage: IndexedDbAdapter | undefined
    try {
      run.phase = 'saving'
      await this.store(run)
      storage = await IndexedDbAdapter.open()
      const current = await storage.getGuide(run.guideId)
      if (current.version !== run.version) {
        // Retry after the report commit but before the extension acknowledged it.
        if (JSON.stringify(current.verification) !== JSON.stringify(report)) {
          run.phase = 'conflict'
          await this.store(run)
          await this.show(run)
          return
        }
      } else
        await storage.saveGuide(
          { ...current, verification: report },
          current.version,
        )
      run.phase = 'complete'
    } catch (error) {
      run.phase =
        error instanceof StorageError && error.code === 'conflict'
          ? 'conflict'
          : 'save-error'
    } finally {
      storage?.close()
    }
    await this.store(run)
    await this.show(run)
  }
  async closed(tabId: number) {
    return this.serialize(async () => {
      const run = await this.state()
      if (run?.tabId === tabId && run.phase === 'running') {
        run.phase = 'saving'
        await this.finish(run)
      }
    })
  }
  async recover() {
    return this.serialize(async () => {
      const run = await this.state()
      if (run?.phase === 'saving') await this.finish(run)
    })
  }
  async clear() {
    return this.serialize(async () => {
      const run = await this.state()
      if (!run) return
      if (run.phase === 'running' || run.phase === 'saving')
        throw new Error('Walkthrough active')
      await this.hide(run)
      await browser.storage.local.remove('guideMe')
    })
  }
  private async hide(run: GuideRun) {
    await Promise.allSettled(
      (
        (await browser.webNavigation
          .getAllFrames({ tabId: run.tabId })
          .catch(() => null)) ?? []
      ).map(({ frameId }) =>
        browser.tabs.sendMessage(
          run.tabId,
          { type: 'GUIDE_HIDE' },
          { frameId },
        ),
      ),
    )
  }
}

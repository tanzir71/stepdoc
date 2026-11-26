import type { Guide } from '@stepdoc/schema'
import { StorageError, type StorageAdapter } from '@stepdoc/storage'
import { validDraft } from './model'
import { visualKey } from './model'
import { mergeGuides } from './merge'

export type SaveFailure = 'conflict' | 'storage' | 'image'
export interface EditorState {
  guide: Guide
  dirty: boolean
  saving: boolean
  error: SaveFailure | null
  revision: number
  canUndo: boolean
  canRedo: boolean
}
export type Materialize = (
  draft: Guide,
  saved: Guide,
  force?: ReadonlySet<string>,
) => Promise<Guide>
/** One serialized optimistic writer. Edits arriving during a write keep their payload. */
export class EditorController {
  private state: EditorState
  private saved: Guide
  private listeners = new Set<() => void>()
  private undoStack: Guide[] = []
  private redoStack: Guide[] = []
  private running: Promise<boolean> | undefined
  private savedRevision = 0
  private discarding = false
  constructor(
    private adapter: StorageAdapter,
    guide: Guide,
    private materialize: Materialize = async (draft) => draft,
  ) {
    this.saved = structuredClone(guide)
    this.state = {
      guide: structuredClone(guide),
      dirty: false,
      saving: false,
      error: null,
      revision: 0,
      canUndo: false,
      canRedo: false,
    }
  }
  subscribe = (callback: () => void) => {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }
  snapshot = () => this.state
  private emit(patch: Partial<EditorState>) {
    this.state = {
      ...this.state,
      ...patch,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    }
    for (const listener of this.listeners) listener()
  }
  edit(change: (guide: Guide) => void) {
    const next = structuredClone(this.state.guide)
    change(next)
    const guide = validDraft(next)
    if (JSON.stringify(guide) === JSON.stringify(this.state.guide)) return
    this.undoStack.push(structuredClone(this.state.guide))
    this.redoStack = []
    // Replay results describe a prior document; editing never preserves a stale pass.
    if (guide.verification) guide.verification = { status: 'never-run' }
    this.emit({
      guide,
      dirty: true,
      error: this.state.error === 'conflict' ? 'conflict' : null,
      revision: this.state.revision + 1,
    })
  }
  undo() {
    const guide = this.undoStack.pop()
    if (!guide) return
    this.redoStack.push(structuredClone(this.state.guide))
    this.command(guide)
  }
  redo() {
    const guide = this.redoStack.pop()
    if (!guide) return
    this.undoStack.push(structuredClone(this.state.guide))
    this.command(guide)
  }
  private command(guide: Guide) {
    guide.version = this.saved.version
    guide.updatedAt = this.saved.updatedAt
    if (guide.verification) guide.verification = { status: 'never-run' }
    this.emit({
      guide,
      dirty: true,
      error: this.state.error === 'conflict' ? 'conflict' : null,
      revision: this.state.revision + 1,
    })
  }
  flush = (): Promise<boolean> => {
    if (this.running) return this.running
    if (!this.state.dirty && !this.state.error) return Promise.resolve(true)
    if (this.state.error === 'conflict') return Promise.resolve(false)
    this.running = this.drain().finally(() => {
      this.running = undefined
    })
    return this.running
  }
  private async drain() {
    this.emit({ saving: true, error: null })
    try {
      while (!this.discarding && this.savedRevision !== this.state.revision) {
        const revision = this.state.revision
        const draft = structuredClone(this.state.guide)
        draft.version = this.saved.version
        let prepared: Guide
        try {
          prepared = await this.materialize(
            structuredClone(draft),
            structuredClone(this.saved),
          )
        } catch {
          this.emit({ error: 'image' })
          return false
        }
        if (this.discarding) return false
        const stored = await this.adapter.saveGuide(
          prepared,
          this.saved.version,
        )
        this.saved = structuredClone(stored)
        for (const history of [...this.undoStack, ...this.redoStack])
          for (const item of history.steps) {
            const captured = draft.steps.find((s) => s.id === item.id),
              committed = stored.steps.find((s) => s.id === item.id)
            if (
              item.screenshot &&
              captured?.screenshot?.original &&
              committed?.screenshot?.original &&
              item.screenshot.original === captured.screenshot.original
            )
              item.screenshot.original = committed.screenshot.original
          }
        this.savedRevision = revision
        if (revision === this.state.revision)
          this.emit({ guide: stored, dirty: false })
        else {
          const next = structuredClone(this.state.guide)
          next.version = stored.version
          next.createdAt = stored.createdAt
          next.updatedAt = stored.updatedAt
          // Source pixels may only become more redacted. Adopt the committed safe
          // original without dropping newer title/layer edits from the working copy.
          for (const step of next.steps) {
            const savedStep = stored.steps.find((item) => item.id === step.id)
            const captured = draft.steps.find((item) => item.id === step.id)
            if (
              step.screenshot &&
              savedStep?.screenshot &&
              captured?.screenshot &&
              step.screenshot.original === captured.screenshot.original
            ) {
              if (visualKey(step) === visualKey(captured))
                step.screenshot = {
                  ...savedStep.screenshot,
                  alt: step.screenshot.alt,
                }
              else step.screenshot.original = savedStep.screenshot.original
            }
          }
          this.emit({ guide: next, dirty: true })
        }
      }
      return true
    } catch (error) {
      this.emit({
        error:
          error instanceof StorageError && error.code === 'conflict'
            ? 'conflict'
            : 'storage',
      })
      return false
    } finally {
      this.emit({ saving: false })
    }
  }
  async reload(onlyIfClean = false) {
    const revision = this.state.revision
    if (onlyIfClean && (this.state.dirty || this.state.saving)) return
    if (this.running) await this.running
    const guide = await this.adapter.getGuide(this.state.guide.id)
    if (
      onlyIfClean &&
      (this.state.dirty ||
        this.state.saving ||
        this.state.revision !== revision)
    )
      return
    this.saved = structuredClone(guide)
    this.savedRevision = this.state.revision + 1
    this.undoStack = []
    this.redoStack = []
    this.emit({
      guide,
      revision: this.savedRevision,
      dirty: false,
      error: null,
    })
  }
  async discard() {
    this.discarding = true
    if (this.running) await this.running
    this.savedRevision = this.state.revision + 1
    this.undoStack = []
    this.redoStack = []
    this.emit({
      guide: structuredClone(this.saved),
      revision: this.savedRevision,
      dirty: false,
      error: null,
    })
    this.discarding = false
  }
  async merge() {
    if (this.running) await this.running
    const remote = await this.adapter.getGuide(this.state.guide.id)
    const result = mergeGuides(this.saved, this.state.guide, remote)
    if (!result.guide) return result.conflicts
    this.saved = structuredClone(remote)
    this.undoStack = []
    this.redoStack = []
    this.emit({
      guide: result.guide,
      revision: this.state.revision + 1,
      dirty: true,
      error: null,
    })
    return (await this.flush()) ? [] : ['guide.changed-again']
  }
  /** Keep both documents; a conflict never writes over another tab's version. */
  async saveCopy() {
    if (this.running) await this.running
    const input = structuredClone(this.state.guide)
    input.id = `${input.id.slice(0, 60)}-${crypto.randomUUID().slice(0, 8)}`
    input.uuid = crypto.randomUUID()
    input.version = 1
    // New records cannot refer to blobs owned by another guide. Create the steps
    // first, then copy only adapter-validated raster blobs under the new owner.
    let copy = await this.adapter.createGuide({
      ...input,
      steps: input.steps.map((step) => ({ ...step, screenshot: undefined })),
    })
    try {
      for (const step of input.steps)
        if (step.screenshot) {
          const copied = copy.steps.find((item) => item.id === step.id)!
          const original = step.screenshot.original
            ? await this.adapter.getBlob(step.screenshot.original)
            : null
          const rendered = await this.adapter.getBlob(step.screenshot.rendered)
          copied.screenshot = {
            ...step.screenshot,
            original: original
              ? (
                  await this.adapter.putBlob(copy.id, {
                    file: original,
                    stepId: step.id,
                    kind: 'original',
                  })
                ).key
              : null,
            rendered: (
              await this.adapter.putBlob(copy.id, {
                file: rendered,
                stepId: step.id,
                kind: 'rendered',
              })
            ).key,
          }
        }
      // Apply any unsaved image edits after copying safe original pixels.
      const force = new Set(
        input.steps
          .filter((step) => {
            const saved = this.saved.steps.find((item) => item.id === step.id)
            return !saved || visualKey(saved) !== visualKey(step)
          })
          .map((step) => step.id),
      )
      const prepared = await this.materialize(
        copy,
        structuredClone(copy),
        force,
      )
      copy = await this.adapter.saveGuide(prepared, copy.version)
      return copy
    } catch (error) {
      await this.adapter.deleteGuide(copy.id).catch(() => {})
      throw error
    }
  }
}

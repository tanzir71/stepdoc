import { describe, expect, it } from 'vitest'
import { guideSchema, type Guide, type GuideInput } from '@stepdoc/schema'
import { StorageError, type StorageAdapter } from '@stepdoc/storage'
import { EditorController, type Materialize } from './controller'
import {
  addStep,
  changeAction,
  editorRoute,
  editorUrl,
  moveStep,
  removeStep,
  safePageUrl,
} from './model'
import { mergeGuides } from './merge'

function fixture(): Guide {
  return guideSchema.parse({
    schema: 'stepdoc/guide@1',
    id: 'editor-guide',
    title: 'Original title',
    steps: [
      {
        id: 'first-step',
        index: 1,
        type: 'manual',
        title: 'First instruction',
      },
      {
        id: 'second-step',
        index: 2,
        type: 'manual',
        title: 'Second instruction',
      },
    ],
    version: 1,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
    verification: { status: 'passed' },
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}
function store(initial = fixture()) {
  let saved = structuredClone(initial)
  const writes: { input: GuideInput; version: number }[] = []
  let failure: Error | undefined
  const unused = async () => {
    throw new Error('Unexpected test-store operation')
  }
  const adapter: StorageAdapter = {
    capabilities: {
      target: 'browser',
      readOnly: false,
      versions: true,
      maxUploadBytes: 64 * 1024 * 1024,
    },
    listGuides: unused,
    listVersions: unused,
    getVersion: unused,
    putBlob: unused,
    getBlob: unused,
    deleteGuide: unused,
    close() {},
    getGuide: async () => structuredClone(saved),
    createGuide: async (input) => {
      saved = { ...guideSchema.parse(input), version: 1 }
      return structuredClone(saved)
    },
    saveGuide: async (input, version) => {
      writes.push({ input: structuredClone(input), version })
      if (failure) throw failure
      if (version !== saved.version)
        throw new StorageError('conflict', saved.version)
      saved = { ...guideSchema.parse(input), version: version + 1 }
      return structuredClone(saved)
    },
  }
  return {
    adapter,
    writes,
    current: () => saved,
    remote(change: (guide: Guide) => void) {
      change(saved)
      saved.version++
    },
    fail(error?: Error) {
      failure = error
    },
  }
}
describe('serialized editor writes', () => {
  it('does not replace edits arriving while a clean external report reload is pending', async () => {
    const storage = store()
    const gate = deferred<Guide>()
    storage.adapter.getGuide = () => gate.promise
    const editor = new EditorController(storage.adapter, fixture())
    const loading = editor.reload(true)
    editor.edit((guide) => {
      guide.title = 'New unsaved edit'
    })
    gate.resolve({
      ...fixture(),
      version: 2,
      verification: { status: 'passed', runner: 'guide-me' },
    })
    await loading
    expect(editor.snapshot().guide.title).toBe('New unsaved edit')
    expect(editor.snapshot().dirty).toBe(true)
  })
  it('retains edits made while a save is rendering and uses the next version', async () => {
    const storage = store()
    const gate = deferred<void>()
    let first = true
    const materialize: Materialize = async (doc) => {
      if (first) {
        first = false
        await gate.promise
      }
      return doc
    }
    const editor = new EditorController(storage.adapter, fixture(), materialize)
    editor.edit((doc) => {
      doc.title = 'First edit'
    })
    const save = editor.flush()
    editor.edit((doc) => {
      doc.title = 'Latest edit'
      doc.steps[1]!.description = 'Arrived during image processing'
    })
    gate.resolve()
    expect(await save).toBe(true)
    expect(storage.writes.map((w) => w.version)).toEqual([1, 2])
    expect(storage.current()).toMatchObject({
      title: 'Latest edit',
      version: 3,
      verification: { status: 'never-run' },
    })
    expect(storage.current().steps[1]!.description).toBe(
      'Arrived during image processing',
    )
    expect(editor.snapshot()).toMatchObject({
      dirty: false,
      saving: false,
      error: null,
    })
  })
  it('adopts the safe rendered pixels as well as the source when a title changes in flight', async () => {
    const initial = fixture()
    initial.steps[0]!.screenshot = {
      original: 'source-old.png',
      rendered: 'render-old.png',
      width: 100,
      height: 100,
      devicePixelRatio: 1,
    }
    const storage = store(initial),
      gate = deferred<void>()
    let first = true
    const editor = new EditorController(
      storage.adapter,
      initial,
      async (doc) => {
        if (first) {
          first = false
          await gate.promise
          doc.steps[0]!.screenshot = {
            ...doc.steps[0]!.screenshot!,
            original: 'source-masked.png',
            rendered: 'render-masked.png',
            width: 80,
            height: 90,
          }
        }
        return doc
      },
    )
    editor.edit((doc) => {
      doc.steps[0]!.redactions.push({
        kind: 'field',
        source: 'manual',
        status: 'applied',
        rect: { x: 1, y: 1, width: 10, height: 10 },
      })
    })
    const saving = editor.flush()
    editor.edit((doc) => {
      doc.title = 'Concurrent title'
    })
    gate.resolve()
    await saving
    expect(storage.current().steps[0]!.screenshot).toMatchObject({
      original: 'source-masked.png',
      rendered: 'render-masked.png',
      width: 80,
      height: 90,
    })
    editor.undo()
    expect(editor.snapshot().guide.steps[0]!.screenshot!.original).toBe(
      'source-masked.png',
    )
  })
  it('keeps a conflicting working copy, refuses silent overwrite and reloads only explicitly', async () => {
    const storage = store(),
      editor = new EditorController(storage.adapter, fixture())
    editor.edit((doc) => {
      doc.title = 'This tab'
    })
    storage.remote((doc) => {
      doc.title = 'Other tab'
    })
    expect(await editor.flush()).toBe(false)
    expect(editor.snapshot()).toMatchObject({
      dirty: true,
      error: 'conflict',
      guide: { title: 'This tab' },
    })
    expect(await editor.flush()).toBe(false)
    expect(storage.writes).toHaveLength(1)
    await editor.reload()
    expect(editor.snapshot()).toMatchObject({
      dirty: false,
      error: null,
      guide: { title: 'Other tab', version: 2 },
    })
  })
  it('preserves quota failures and supports a deliberate retry', async () => {
    const storage = store(),
      editor = new EditorController(storage.adapter, fixture())
    editor.edit((doc) => {
      doc.description = 'Keep this text'
    })
    storage.fail(new StorageError('storage_full'))
    expect(await editor.flush()).toBe(false)
    expect(editor.snapshot()).toMatchObject({
      dirty: true,
      error: 'storage',
      guide: { description: 'Keep this text' },
    })
    storage.fail()
    expect(await editor.flush()).toBe(true)
    expect(storage.current().description).toBe('Keep this text')
  })
  it('never commits metadata when client image preparation fails', async () => {
    const storage = store(),
      editor = new EditorController(storage.adapter, fixture(), async () => {
        throw new Error('native-private-error')
      })
    editor.edit((doc) => {
      doc.title = 'Unsaved'
    })
    expect(await editor.flush()).toBe(false)
    expect(storage.writes).toHaveLength(0)
    expect(editor.snapshot()).toMatchObject({ dirty: true, error: 'image' })
    expect(JSON.stringify(editor.snapshot())).not.toContain(
      'native-private-error',
    )
  })
  it('discards pending edits without issuing a metadata write after image work completes', async () => {
    const storage = store(),
      gate = deferred<void>(),
      editor = new EditorController(storage.adapter, fixture(), async (doc) => {
        await gate.promise
        return doc
      })
    editor.edit((doc) => {
      doc.title = 'Discard me'
    })
    const save = editor.flush(),
      discard = editor.discard()
    gate.resolve()
    await save
    await discard
    expect(storage.writes).toHaveLength(0)
    expect(editor.snapshot()).toMatchObject({
      dirty: false,
      error: null,
      guide: { title: 'Original title' },
    })
  })
  it('undo/redo retain valid versions and never restore a stale replay pass', async () => {
    const storage = store(),
      editor = new EditorController(storage.adapter, fixture())
    editor.edit((doc) => {
      doc.title = 'Changed'
    })
    await editor.flush()
    editor.undo()
    await editor.flush()
    editor.redo()
    await editor.flush()
    expect(storage.current()).toMatchObject({
      title: 'Changed',
      version: 4,
      verification: { status: 'never-run' },
    })
    expect(editor.snapshot().canRedo).toBe(false)
  })
  it('merges independent changes against the latest version and reports same-field conflicts', async () => {
    const storage = store(),
      editor = new EditorController(storage.adapter, fixture())
    editor.edit((doc) => {
      doc.title = 'Local title'
    })
    storage.remote((doc) => {
      doc.description = 'Remote description'
    })
    await editor.flush()
    expect(await editor.merge()).toEqual([])
    expect(storage.current()).toMatchObject({
      title: 'Local title',
      description: 'Remote description',
      version: 3,
    })
    editor.edit((doc) => {
      doc.title = 'Another local title'
    })
    storage.remote((doc) => {
      doc.title = 'Another remote title'
    })
    await editor.flush()
    expect(await editor.merge()).toContain('guide.title')
    expect(storage.current().title).toBe('Another remote title')
    expect(editor.snapshot().guide.title).toBe('Another local title')
  })
})
describe('document commands and merge boundaries', () => {
  it('adds, reorders and removes steps with stable IDs and sequential indices', () => {
    const guide = fixture(),
      id = addStep(guide, guide.steps[0]!.id, 'section', 'Billing')
    expect(guide.steps.map((s) => s.index)).toEqual([1, 2, 3])
    moveStep(guide, id, 1)
    expect(guide.steps[2]!.id).toBe(id)
    removeStep(guide, id)
    expect(guide.steps.map((s) => s.index)).toEqual([1, 2])
    removeStep(guide, guide.steps[0]!.id)
    expect(() => removeStep(guide, guide.steps[0]!.id)).toThrow('last_step')
  })
  it('creates only variable/secret references for recorded fill/upload actions', () => {
    const guide = fixture()
    changeAction(guide, guide.steps[0]!.id, 'fill')
    expect(guide.steps[0]!.value).toEqual({
      kind: 'secret',
      variable: 'input_1',
    })
    changeAction(guide, guide.steps[0]!.id, 'select')
    expect(guide.steps[0]!.value).toEqual({ kind: 'literal', literal: '' })
    changeAction(guide, guide.steps[0]!.id, 'upload')
    expect(guide.steps[0]!.value?.kind).toBe('secret')
    expect(() => guideSchema.parse(guide)).not.toThrow()
  })
  it('strips unsafe URL components before persistence', () => {
    expect(
      safePageUrl(
        'https://owner:private@example.com/page?token=private#fragment',
      ),
    ).toBe('https://example.com/page')
    expect(safePageUrl('javascript:alert(1)')).toBeNull()
    expect(safePageUrl('/billing?token=private', 'https://example.com')).toBe(
      'https://example.com/billing',
    )
  })
  it('round-trips deterministic editor selection, panel, view and layer state', () => {
    const url = editorUrl('local-guide', '?step=3&panel=history', {
      view: 'agent',
      layer: 'redaction-1',
    })
    expect(editorRoute(url.slice(url.indexOf('?')))).toMatchObject({
      step: 3,
      panel: 'history',
      mode: 'agent',
    })
    expect(editorRoute('?step=NaN&panel=bad&view=bad')).toMatchObject({
      step: 1,
      panel: 'target',
      mode: 'edit',
    })
  })
  it('merges edits to different steps but treats a pixel source and its layers atomically', () => {
    const base = fixture(),
      local = structuredClone(base),
      remote = structuredClone(base)
    local.steps[0]!.title = 'Local instruction'
    remote.steps[1]!.description = 'Remote instruction'
    expect(mergeGuides(base, local, remote).guide?.steps).toMatchObject([
      { title: 'Local instruction' },
      { description: 'Remote instruction' },
    ])
    local.steps[0]!.edits = {
      annotations: [
        { type: 'text', x: 2, y: 2, text: 'Local', color: 'accent' },
      ],
    }
    remote.steps[0]!.redactions = [
      {
        kind: 'field',
        source: 'manual',
        status: 'applied',
        rect: { x: 2, y: 2, width: 3, height: 3 },
      },
    ]
    expect(mergeGuides(base, local, remote).conflicts).toContain(
      'steps.first-step.image',
    )
  })
  it('reports a deletion conflicting with an edited step and conflicting reorders', () => {
    const base = fixture(),
      local = structuredClone(base),
      remote = structuredClone(base)
    local.steps.shift()
    remote.steps[0]!.description = 'Must not lose this'
    expect(mergeGuides(base, local, remote).guide).toBeUndefined()
    expect(mergeGuides(base, local, remote).conflicts).toContain(
      'steps.first-step',
    )
  })
})

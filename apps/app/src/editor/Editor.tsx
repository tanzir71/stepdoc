import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Input,
  Logo,
  SegmentGroup,
  StepRow,
} from '@stepdoc/ui'
import { describeGuideStep } from '@stepdoc/core/describe-step'
import { exportGuideJson } from '@stepdoc/core/export/json'
import { exportMarkdown } from '@stepdoc/core/export/markdown'
import type { Guide, Step } from '@stepdoc/schema'
import { getStorage, changed } from '../repository'
import { navigate, guardNavigation } from '../navigation'
import { useActivity } from '../activity'
import { useBlob } from '../hooks'
import { StatePanel } from '../library'
import { StepImage } from '../preview'
import { humanize } from '../model'
import { useEditor, useEditorState, type EditorRuntime } from './hooks'
import {
  addStep,
  editorRoute,
  editorUrl,
  moveStep,
  moveBefore,
  changeStepType,
  removeStep,
  type EditorMode,
  type InspectorPanel,
} from './model'
import { TextField, SelectField } from './fields'
import { TargetPanel } from './target'
import { CanvasPanel } from './canvas'
import { ExportDialog } from '../exports/ExportDialog'
import './styles.css'

function Row({
  step,
  active,
  select,
  drop,
}: {
  step: Step
  active: boolean
  select: () => void
  drop: (id: string) => void
}) {
  const thumbnail = useBlob(step.screenshot?.rendered ?? null)
  return (
    <li
      role="presentation"
      id={`step-${step.index}`}
      data-sd-step={step.index}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('application/x-stepdoc-step', step.id)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('application/x-stepdoc-step')) {
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
        }
      }}
      onDrop={(event) => {
        event.preventDefault()
        drop(event.dataTransfer.getData('application/x-stepdoc-step'))
      }}
    >
      <StepRow
        data-section={step.type === 'section' || undefined}
        role="option"
        aria-selected={active}
        tabIndex={active ? 0 : -1}
        data-sd="editor-step-select"
        number={String(step.index).padStart(2, '0')}
        title={step.title}
        meta={`${step.action ?? step.type}${step.target?.role ? ` · ${step.target.role}` : ''}${step.value?.kind === 'secret' ? ' · secret' : step.value?.kind === 'variable' ? ` · {${step.value.variable}}` : ''}`}
        state={
          active
            ? 'active'
            : step.lowConfidence ||
                step.redactions.some((item) => item.status === 'open')
              ? 'flagged'
              : 'default'
        }
        thumbnail={thumbnail ?? undefined}
        onClick={select}
      />
    </li>
  )
}
function download(guide: Guide) {
  const url = URL.createObjectURL(
    new Blob([exportGuideJson(guide)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `${guide.id}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function Editor({
  id,
  search,
  online,
  exportOpen = false,
}: {
  id: string
  search: string
  online: boolean
  exportOpen?: boolean
}) {
  const [attempt, setAttempt] = useState(0)
  const state = useEditor(id, attempt)
  return state.runtime ? (
    <EditorLoaded
      id={id}
      search={search}
      online={online}
      exportOpen={exportOpen}
      runtime={state.runtime}
    />
  ) : (
    <div className="editor-shell">
      <header className="editor-topbar">
        <nav aria-label="Guide navigation">
          <a href="/" data-sd="editor-library">
            Library
          </a>
        </nav>
        <h1>Guide editor</h1>
      </header>
      <main id="main" tabIndex={-1}>
        {state.failed ? (
          <StatePanel
            title="Guide unavailable"
            action={
              <Button
                data-sd="editor-retry-load"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            }
          >
            This guide could not be read on this device. Return to the library
            or retry.
          </StatePanel>
        ) : (
          <p role="status" className="editor-loading">
            Loading guide…
          </p>
        )}
      </main>
    </div>
  )
}
function EditorLoaded({
  id,
  search,
  online,
  runtime,
  exportOpen,
}: {
  id: string
  search: string
  online: boolean
  runtime: EditorRuntime
  exportOpen: boolean
}) {
  const { controller, processor } = runtime
  useLayoutEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true })
  }, [])
  const state = useEditorState(controller)
  const guide = state.guide
  const selected = editorRoute(search)
  const step = guide.steps[Math.min(selected.step, guide.steps.length) - 1]!
  const route = (changes: Record<string, string | null>, replace = false) =>
    navigate(
      editorUrl(id, search, changes, exportOpen ? 'export' : 'edit'),
      replace,
    )
  const select = (step: Step) =>
    route({ step: String(step.index), layer: null })
  const announce = useActivity()
  const addDialog = useRef<HTMLDialogElement>(null)
  const detailsDialog = useRef<HTMLDialogElement>(null)
  const deleteDialog = useRef<HTMLDialogElement>(null)
  const conflictDialog = useRef<HTMLDialogElement>(null)
  const leaveDialog = useRef<HTMLDialogElement>(null)
  const cleanupDialog = useRef<HTMLDialogElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string | undefined>(undefined)
  const leave = useRef<(() => void) | undefined>(undefined)
  const pendingImage = useRef<Promise<void> | undefined>(undefined)
  const imageGeneration = useRef(0)
  const searchInput = useRef<HTMLInputElement>(null)
  const [imageBusy, setImageBusy] = useState(false)
  const imageBusyRef = useRef(false)
  const [searchOpen, setSearchOpen] = useState(!!selected.q)
  const [versions, setVersions] = useState<
    { version: number; at: string; by: string; summary: string }[]
  >([])
  const [historyError, setHistoryError] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [conflictOperation, setConflictOperation] = useState<string | null>(
    null,
  )
  const conflictBusy = useRef(false)
  const [mergeConflicts, setMergeConflicts] = useState(0)
  const [cleanup, setCleanup] = useState<
    ReadonlyArray<{
      id: string
      before: string
      after: string
      selected: boolean
    }>
  >([])
  const routeRef = useRef(route)
  routeRef.current = route
  useEffect(() => {
    if (new URLSearchParams(search).get('step') !== String(step.index))
      routeRef.current({ step: String(step.index) }, true)
  }, [search, step.index])
  useEffect(() => {
    document.title = `StepDoc · ${guide.title}`
  }, [guide.title])
  useEffect(
    () =>
      guardNavigation({
        dirty: () =>
          controller.snapshot().dirty ||
          imageBusyRef.current ||
          conflictBusy.current,
        ask: (proceed) => {
          if (conflictBusy.current) {
            announce('Wait for the conflict action to finish.')
            return
          }
          leave.current = proceed
          leaveDialog.current?.showModal()
        },
      }),
    [controller],
  )
  useEffect(() => {
    if (state.error === 'conflict') conflictDialog.current?.showModal()
    if (state.error)
      announce(
        state.error === 'conflict'
          ? 'Another tab saved a newer version. Your edits are still here.'
          : state.error === 'image'
            ? 'The image edits could not be saved. Your working copy is still here.'
            : 'Changes could not be saved on this device. Your working copy is still here.',
      )
  }, [state.error, announce])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void controller.flush().then((ok) => {
          if (ok) changed()
        })
        return
      }
      if (
        event.target instanceof Element &&
        event.target.closest('input,textarea,select,[contenteditable=true]')
      )
        return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) controller.redo()
        else controller.undo()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [controller])
  useEffect(() => {
    if (selected.panel !== 'history') return
    let active = true
    setHistoryBusy(true)
    setHistoryError(false)
    void getStorage()
      .then((adapter) => adapter.listVersions(id))
      .then((items) => {
        if (active) setVersions(items)
      })
      .catch(() => {
        if (active) setHistoryError(true)
      })
      .finally(() => {
        if (active) setHistoryBusy(false)
      })
    return () => {
      active = false
    }
  }, [id, selected.panel, guide.version])
  const editStep = (change: (step: Step) => void) =>
    controller.edit((doc) =>
      change(doc.steps.find((item) => item.id === step.id)!),
    )
  const move = (delta: -1 | 1) => {
    const index = step.index + delta
    if (index < 1 || index > guide.steps.length) return
    controller.edit((doc) => moveStep(doc, step.id, delta))
    route({ step: String(index) })
  }
  const openFile = (target = step.id) => {
    uploadTarget.current = target
    file.current?.click()
  }
  const chooseMode = async (mode: EditorMode) => {
    if (mode === 'agent') {
      route({ view: mode })
      return
    }
    if (await controller.flush()) {
      changed()
      route({ view: mode })
    } else announce('Resolve the save error before changing views.')
  }
  const upload = (image: File, target: string) => {
    if (imageBusyRef.current) return
    const generation = ++imageGeneration.current
    imageBusyRef.current = true
    setImageBusy(true)
    const job = (async () => {
      const stored = await (await getStorage()).getGuide(id)
      if (
        !stored.steps.some((item) => item.id === target) &&
        !(await controller.flush())
      )
        throw new Error('save_failed')
      const processed = await processor.process(image, { format: 'image/png' })
      if (generation !== imageGeneration.current) return
      const adapter = await getStorage()
      const original = await adapter.putBlob(id, {
        file: processed.original.blob,
        stepId: target,
        kind: 'original',
      })
      const rendered = await adapter.putBlob(id, {
        file: processed.rendered.blob,
        stepId: target,
        kind: 'rendered',
      })
      if (generation !== imageGeneration.current) return
      controller.edit((doc) => {
        const next = doc.steps.find((item) => item.id === target)
        if (!next) throw new Error('step_removed')
        next.screenshot = {
          original: original.key,
          rendered: rendered.key,
          width: processed.rendered.width,
          height: processed.rendered.height,
          devicePixelRatio: 1,
          alt: `Screenshot for ${next.title}`,
        }
        next.edits = undefined
        next.click = null
        next.redactions = []
      })
      if (!(await controller.flush())) throw new Error('save_failed')
      changed()
      announce('Image processed in this browser and saved.')
    })()
      .catch(() =>
        announce(
          'The image could not be saved. Your working copy is still here.',
        ),
      )
      .finally(() => {
        imageBusyRef.current = false
        setImageBusy(false)
        pendingImage.current = undefined
      })
    pendingImage.current = job
  }
  const runConflict = (message: string, action: () => Promise<void>) => {
    if (conflictBusy.current) return
    conflictBusy.current = true
    setConflictOperation(message)
    void action()
      .catch(() =>
        announce(
          'The conflict action could not finish. Your working copy is still here.',
        ),
      )
      .finally(() => {
        conflictBusy.current = false
        setConflictOperation(null)
      })
  }
  const mergeConflict = () =>
    runConflict('Merging changes…', async () => {
      const conflicts = await controller.merge()
      setMergeConflicts(conflicts.length)
      if (!conflicts.length) {
        conflictDialog.current?.close()
        changed()
        announce('Independent changes were merged and saved.')
      }
    })
  const copyConflict = () =>
    runConflict('Saving a separate copy…', async () => {
      const copy = await controller.saveCopy()
      await controller.discard()
      conflictDialog.current?.close()
      changed()
      navigate(`/g/${copy.id}/edit?step=${step.index}`, false, true)
    })
  const reloadConflict = () =>
    runConflict('Reloading the saved version…', async () => {
      await controller.reload()
      conflictDialog.current?.close()
      changed()
      announce('The saved version was reloaded.')
    })
  const downloadWorking = () => {
    try {
      download(controller.snapshot().guide)
      announce('Working-copy JSON downloaded. Image files are separate.')
    } catch {
      announce(
        'The working copy could not be exported. Check its URLs and metadata.',
      )
    }
  }
  const visible = selected.q
    ? guide.steps.filter((item) =>
        `${item.title} ${item.description}`
          .toLowerCase()
          .includes(selected.q.toLowerCase()),
      )
    : guide.steps
  return (
    <div className="editor-shell">
      <a className="skip-link" href="#main">
        Skip to editor
      </a>
      <header className="editor-topbar">
        <nav className="editor-breadcrumb" aria-label="Guide navigation">
          <a href="/" data-sd="editor-library" aria-label="Library">
            <Logo markOnly size="m" />
          </a>
          <a
            href={
              guide.collectionId
                ? `/?collection=${encodeURIComponent(guide.collectionId)}`
                : '/'
            }
            data-sd="editor-collection"
          >
            {guide.collectionId ? humanize(guide.collectionId) : 'Library'}
          </a>
          <Icon name="chevron-right" />
        </nav>
        <h1>
          <button
            type="button"
            data-sd="editor-guide-details"
            onClick={() => detailsDialog.current?.showModal()}
          >
            {guide.title}
          </button>
        </h1>
        <Badge>{humanize(guide.status)}</Badge>
        <button
          className="editor-save-status"
          data-sd="editor-save-status"
          type="button"
          aria-label={`${state.error ? 'Save failed' : state.saving ? 'Saving' : state.dirty ? 'Unsaved changes' : 'Saved'}, version ${guide.version}. Open history.`}
          onClick={() => route({ panel: 'history' })}
        >
          <Icon name="history" />
          <span role="status">
            {state.error
              ? 'Save failed'
              : state.saving
                ? 'Saving…'
                : state.dirty
                  ? 'Unsaved'
                  : `Saved · v${guide.version}`}
          </span>
        </button>
        <SegmentGroup<EditorMode>
          value={selected.mode}
          options={[
            { value: 'edit', label: 'Edit' },
            { value: 'preview', label: 'Preview' },
            { value: 'agent', label: 'Agent view' },
          ]}
          label="Editor mode"
          controls="editor-mode-panel"
          hook="editor-mode"
          onChange={(value) => {
            void chooseMode(value)
          }}
        />
        <Button
          kind="secondary"
          icon="target"
          data-sd="editor-read-guide"
          onClick={() => {
            void chooseMode('preview')
          }}
        >
          Read guide
        </Button>
        <Button
          kind="secondary"
          icon="share"
          data-sd="editor-copy-link"
          onClick={() => {
            void navigator.clipboard
              .writeText(`${location.origin}${editorUrl(id, search, {})}`)
              .then(() =>
                announce(
                  'Local editor link copied. This library stays on this device.',
                ),
              )
              .catch(() =>
                announce(
                  'Clipboard unavailable. The editor URL is in the address bar.',
                ),
              )
          }}
        >
          Copy link
        </Button>
        <Button
          icon="download"
          data-sd="export-open"
          disabled={imageBusy}
          onClick={() => {
            void controller.flush().then((ok) => {
              if (!ok) return
              navigate(editorUrl(id, search, {}, 'export'))
            })
          }}
        >
          Export &amp; publish
        </Button>
      </header>
      {exportOpen ? (
        <ExportDialog
          guide={guide}
          search={search}
          close={() => navigate(editorUrl(id, search, { formats: null }), true)}
        />
      ) : null}
      {!online ? (
        <p role="status" className="offline-banner">
          <Icon name="offline" />
          Offline · edits save to browser storage.
        </p>
      ) : null}
      {imageBusy ? (
        <p role="status" className="editor-progress">
          Processing image in this browser…
        </p>
      ) : null}
      {state.error ? (
        <div className="editor-save-error" role="alert">
          <span>
            {state.error === 'conflict'
              ? 'A newer version was saved in another tab.'
              : state.error === 'image'
                ? 'Image changes could not be saved. Replace a missing source image or undo the image edit.'
                : 'Browser storage could not save these changes.'}{' '}
            Your working copy is still here.
          </span>
          <Button
            kind="secondary"
            size="s"
            data-sd="editor-retry-save"
            onClick={() => {
              if (state.error === 'conflict')
                conflictDialog.current?.showModal()
              else
                void controller.flush().then((ok) => {
                  if (ok) changed()
                })
            }}
          >
            {state.error === 'conflict' ? 'Resolve conflict' : 'Retry save'}
          </Button>
        </div>
      ) : null}
      <main id="main" tabIndex={-1} className="editor-main">
        <div
          id="editor-mode-panel"
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`editor-mode-${selected.mode}`}
          className={`editor-mode-panel ${selected.mode !== 'edit' ? 'document-mode' : ''}`}
        >
          {selected.mode === 'edit' ? (
            <>
              <aside className="editor-step-list" aria-label="Guide steps">
                <div className="steps-header">
                  <h2>Steps</h2>
                  <Badge dot={false}>{guide.steps.length}</Badge>
                  <Button
                    kind="secondary"
                    size="s"
                    icon="sparkle"
                    data-sd="ai-cleanup"
                    onClick={() => {
                      setCleanup(
                        guide.steps
                          .filter(
                            (s) => s.type !== 'manual' && s.type !== 'section',
                          )
                          .map((s) => ({
                            id: s.id,
                            before: s.title,
                            after: describeGuideStep(s).text,
                            selected: true,
                          }))
                          .filter((item) => item.before !== item.after),
                      )
                      cleanupDialog.current?.showModal()
                    }}
                  >
                    Clean up
                  </Button>
                  <IconButton
                    icon="add"
                    data-sd="editor-add-step"
                    aria-label="Add step"
                    disabled={guide.steps.length >= 500}
                    onClick={() => addDialog.current?.showModal()}
                  />
                </div>
                <div className="step-search-controls">
                  <Button
                    kind="ghost"
                    size="s"
                    data-sd="editor-search-open"
                    onClick={() => {
                      setSearchOpen((value) => !value)
                      requestAnimationFrame(() => searchInput.current?.focus())
                    }}
                  >
                    {searchOpen ? 'Hide step search' : 'Search steps'}
                  </Button>
                  {searchOpen ? (
                    <Input
                      ref={searchInput}
                      label="Search steps"
                      type="search"
                      data-sd="editor-search"
                      value={selected.q}
                      onChange={(event) =>
                        route({ q: event.target.value || null }, true)
                      }
                    />
                  ) : null}
                </div>
                <ol
                  role="listbox"
                  aria-label="Guide steps"
                  className="step-options"
                  onKeyDown={(event) => {
                    if (
                      event.altKey &&
                      ['ArrowUp', 'ArrowDown'].includes(event.key)
                    ) {
                      event.preventDefault()
                      move(event.key === 'ArrowUp' ? -1 : 1)
                      return
                    }
                    if (
                      ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                        event.key,
                      )
                    ) {
                      event.preventDefault()
                      const index = visible.findIndex((s) => s.id === step.id)
                      const next =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? visible.length - 1
                            : Math.max(
                                0,
                                Math.min(
                                  visible.length - 1,
                                  index + (event.key === 'ArrowDown' ? 1 : -1),
                                ),
                              )
                      if (visible[next]) {
                        select(visible[next])
                        event.currentTarget
                          .querySelectorAll<HTMLButtonElement>('[role=option]')
                          [next]?.focus()
                      }
                    }
                  }}
                >
                  {visible.map((item) => (
                    <Row
                      key={item.id}
                      step={item}
                      active={item.id === step.id}
                      select={() => select(item)}
                      drop={(id) => {
                        controller.edit((doc) => moveBefore(doc, id, item.id))
                        const moved = controller
                          .snapshot()
                          .guide.steps.find((s) => s.id === id)
                        if (moved) select(moved)
                      }}
                    />
                  ))}
                </ol>
                {!visible.length ? (
                  <p className="field-help">No matching steps.</p>
                ) : null}
                <div className="step-list-footer">
                  <Button
                    kind="ghost"
                    size="s"
                    icon="plus-small"
                    data-sd="editor-add-step-footer"
                    disabled={guide.steps.length >= 500}
                    onClick={() => addDialog.current?.showModal()}
                  >
                    Add step
                  </Button>
                  <Button
                    kind="ghost"
                    size="s"
                    icon="record-small"
                    data-sd="editor-add-image"
                    disabled={imageBusy || guide.steps.length >= 500}
                    onClick={() => {
                      let target = ''
                      controller.edit((doc) => {
                        target = addStep(
                          doc,
                          step.id,
                          'manual',
                          'New image step',
                        )
                      })
                      route({ step: String(step.index + 1) })
                      openFile(target)
                    }}
                  >
                    Add image
                  </Button>
                </div>
              </aside>
              <CanvasPanel
                key={step.id}
                guide={guide}
                step={step}
                controller={controller}
                processor={processor}
                upload={() => openFile()}
                query={new URLSearchParams(search)}
                route={route}
              />
              <aside className="editor-inspector" aria-label="Step inspector">
                <SegmentGroup<InspectorPanel>
                  value={selected.panel}
                  options={[
                    { value: 'step', label: 'Step' },
                    { value: 'target', label: 'Target' },
                    { value: 'redact', label: 'Redact' },
                    { value: 'history', label: 'History' },
                  ]}
                  label="Inspector"
                  controls="inspector-panel"
                  hook="inspector"
                  onChange={(value) => route({ panel: value })}
                />
                <div
                  id="inspector-panel"
                  role="tabpanel"
                  aria-labelledby={`inspector-${selected.panel}`}
                >
                  {selected.panel === 'target' ? (
                    <TargetPanel
                      key={step.id}
                      guide={guide}
                      step={step}
                      controller={controller}
                    />
                  ) : selected.panel === 'step' ? (
                    <>
                      <TextField
                        label="Step title"
                        hook="inspector-step-title"
                        value={step.title}
                        required
                        maxLength={1000}
                        onChange={(value) =>
                          editStep((s) => {
                            s.title = value
                          })
                        }
                      />
                      <TextField
                        label="Step description"
                        hook="inspector-step-description"
                        value={step.description}
                        multiline
                        onChange={(value) =>
                          editStep((s) => {
                            s.description = value
                          })
                        }
                      />
                      <SelectField
                        label="Step type"
                        hook="step-type"
                        value={step.type}
                        onChange={(value) =>
                          controller.edit((doc) =>
                            changeStepType(doc, step.id, value as Step['type']),
                          )
                        }
                      >
                        {[
                          'action',
                          'navigate',
                          'section',
                          'manual',
                          'assert',
                        ].map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </SelectField>
                      <TextField
                        label="Screenshot alt text"
                        disabled={!step.screenshot}
                        hook="step-image-alt"
                        value={step.screenshot?.alt ?? ''}
                        onChange={(value) =>
                          editStep((s) => {
                            if (s.screenshot) s.screenshot.alt = value
                          })
                        }
                      />
                      <TextField
                        label="Notes"
                        hook="step-notes"
                        value={step.notes ?? ''}
                        multiline
                        onChange={(value) =>
                          editStep((s) => {
                            s.notes = value
                          })
                        }
                      />
                      <div className="step-management">
                        <Button
                          kind="secondary"
                          size="s"
                          data-sd="step-move-up"
                          disabled={step.index === 1}
                          onClick={() => move(-1)}
                        >
                          Move up
                        </Button>
                        <Button
                          kind="secondary"
                          size="s"
                          data-sd="step-move-down"
                          disabled={step.index === guide.steps.length}
                          onClick={() => move(1)}
                        >
                          Move down
                        </Button>
                        <Button
                          kind="danger"
                          size="s"
                          data-sd="step-delete"
                          disabled={guide.steps.length === 1}
                          onClick={() => deleteDialog.current?.showModal()}
                        >
                          Delete step
                        </Button>
                        <Button
                          kind="secondary"
                          size="s"
                          data-sd="step-image-upload"
                          disabled={imageBusy}
                          onClick={() => openFile()}
                        >
                          Upload image
                        </Button>
                      </div>
                    </>
                  ) : selected.panel === 'redact' ? (
                    <>
                      <h2>Redaction review</h2>
                      <p className="field-help">
                        Masks are applied in this browser before either image is
                        saved. Saved masks are burned into the source; removing
                        a layer cannot recover those pixels.
                      </p>
                      {step.redactions.length ? (
                        <ul className="redaction-list">
                          {step.redactions.map((item, index) => (
                            <li key={index}>
                              <strong>
                                {humanize(item.kind)} · {item.status}
                              </strong>
                              <p>
                                {item.source} · x {item.rect.x}, y {item.rect.y}
                                , {item.rect.width} × {item.rect.height}
                              </p>
                              <Button
                                kind="secondary"
                                size="s"
                                data-sd="redaction-apply"
                                disabled={item.status === 'applied'}
                                onClick={() =>
                                  editStep((s) => {
                                    s.redactions[index]!.status = 'applied'
                                  })
                                }
                              >
                                Apply mask
                              </Button>
                              <Button
                                kind="ghost"
                                size="s"
                                data-sd="redaction-select"
                                onClick={() =>
                                  route({ layer: `redaction-${index}` })
                                }
                              >
                                Edit numbers
                              </Button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>No redaction layers in this step.</p>
                      )}
                      <Button
                        size="s"
                        kind="secondary"
                        icon="blur"
                        data-sd="redaction-add"
                        onClick={() => route({ tool: 'blur' })}
                      >
                        Choose blur tool
                      </Button>
                    </>
                  ) : (
                    <>
                      <h2>Version history</h2>
                      <p className="field-help">
                        Every saved change creates a version on this device.
                        Inspect or download any saved version.
                      </p>
                      {historyBusy ? (
                        <p role="status">Loading history…</p>
                      ) : historyError ? (
                        <p role="alert">Version history could not be read.</p>
                      ) : (
                        <ol
                          className="history-list"
                          aria-label="Saved versions"
                        >
                          {versions.map((version) => (
                            <li key={version.version}>
                              <strong>Version {version.version}</strong>
                              <time dateTime={version.at}>
                                {new Date(version.at).toLocaleString()}
                              </time>
                              <span>
                                {version.by} · {version.summary}
                              </span>
                              <Button
                                kind="ghost"
                                size="s"
                                data-sd="history-download"
                                onClick={() => {
                                  void getStorage()
                                    .then((adapter) =>
                                      adapter.getVersion(id, version.version),
                                    )
                                    .then((doc) => {
                                      download(doc)
                                      announce(
                                        `Version ${version.version} JSON downloaded.`,
                                      )
                                    })
                                    .catch(() =>
                                      announce(
                                        'That version could not be downloaded.',
                                      ),
                                    )
                                }}
                              >
                                Download JSON
                              </Button>
                            </li>
                          ))}
                        </ol>
                      )}
                    </>
                  )}
                </div>
              </aside>
            </>
          ) : selected.mode === 'agent' ? (
            <section
              className="editor-agent-view"
              aria-labelledby="agent-heading"
            >
              <h2 id="agent-heading">Agent text view</h2>
              <p>
                Guide text and runtime input references. Screenshots are
                omitted.
              </p>
              <pre>
                {(() => {
                  try {
                    return exportMarkdown(guide)
                  } catch {
                    return 'The text export is unavailable. Check this guide’s URLs and metadata.'
                  }
                })()}
              </pre>
            </section>
          ) : (
            <article className="editor-document">
              <p>{guide.description}</p>
              <ol className="preview-steps">
                {guide.steps.map((item) => (
                  <li
                    key={item.id}
                    id={`step-${item.index}`}
                    data-sd-step={item.index}
                  >
                    <h2>{item.title}</h2>
                    {item.description ? <p>{item.description}</p> : null}
                    <StepImage step={item} />
                  </li>
                ))}
              </ol>
            </article>
          )}
        </div>
      </main>
      <input
        ref={file}
        className="sd-sr-only"
        aria-label="Upload screenshot"
        data-sd="editor-image-file"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const image = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (image) upload(image, uploadTarget.current ?? step.id)
        }}
      />
      <dialog
        ref={addDialog}
        className="app-dialog"
        aria-labelledby="add-step-heading"
      >
        <h2 id="add-step-heading">Add step</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            let target = ''
            controller.edit((doc) => {
              target = addStep(
                doc,
                step.id,
                String(data.get('type')) as Step['type'],
                String(data.get('title')),
              )
            })
            const next = controller
              .snapshot()
              .guide.steps.find((s) => s.id === target)!
            select(next)
            addDialog.current?.close()
            event.currentTarget.reset()
          }}
        >
          <label className="sd-input editor-field">
            <span className="sd-input-label">Step type</span>
            <select
              name="type"
              aria-label="New step type"
              data-sd="step-add-type"
            >
              <option value="manual">Manual instruction</option>
              <option value="section">Section heading</option>
              <option value="action">Action</option>
              <option value="navigate">Navigation</option>
              <option value="assert">Assertion</option>
            </select>
          </label>
          <Input
            name="title"
            label="Instruction"
            data-sd="step-add-title"
            required
            maxLength={1000}
          />
          <div className="dialog-actions">
            <Button
              kind="ghost"
              data-sd="step-add-cancel"
              onClick={() => addDialog.current?.close()}
            >
              Cancel
            </Button>
            <Button type="submit" data-sd="step-add-save">
              Add step
            </Button>
          </div>
        </form>
      </dialog>
      <dialog
        ref={detailsDialog}
        className="app-dialog"
        aria-labelledby="guide-details-heading"
      >
        <h2 id="guide-details-heading">Guide details</h2>
        <TextField
          label="Guide title"
          hook="editor-guide-title"
          required
          maxLength={200}
          value={guide.title}
          onChange={(value) =>
            controller.edit((doc) => {
              doc.title = value
            })
          }
        />
        <TextField
          label="Guide description"
          hook="editor-guide-description"
          multiline
          value={guide.description}
          onChange={(value) =>
            controller.edit((doc) => {
              doc.description = value
            })
          }
        />
        <div className="dialog-actions">
          <Button
            data-sd="editor-guide-details-close"
            onClick={() => detailsDialog.current?.close()}
          >
            Done
          </Button>
        </div>
      </dialog>
      <dialog
        ref={deleteDialog}
        className="app-dialog"
        aria-labelledby="delete-step-heading"
      >
        <h2 id="delete-step-heading">Delete this step?</h2>
        <p>
          The step will be removed from the current guide. Undo can bring it
          back.
        </p>
        <div className="dialog-actions">
          <Button
            kind="ghost"
            data-sd="step-delete-cancel"
            onClick={() => deleteDialog.current?.close()}
          >
            Cancel
          </Button>
          <Button
            kind="danger"
            data-sd="step-delete-confirm"
            onClick={() => {
              controller.edit((doc) => removeStep(doc, step.id))
              deleteDialog.current?.close()
              route({
                step: String(Math.min(step.index, guide.steps.length - 1)),
                layer: null,
              })
            }}
          >
            Delete step
          </Button>
        </div>
      </dialog>
      <dialog
        ref={conflictDialog}
        className="app-dialog"
        aria-labelledby="conflict-heading"
        onCancel={(event) => {
          if (conflictBusy.current) event.preventDefault()
        }}
      >
        <h2 id="conflict-heading">Another tab saved a newer version</h2>
        <p>
          Your working copy was kept. Save it as a separate guide, or discard it
          and reload the saved version.
        </p>
        {conflictOperation ? <p role="status">{conflictOperation}</p> : null}
        {mergeConflicts ? (
          <p role="alert">
            {mergeConflicts} fields changed in both copies. Keep a separate copy
            or reload the saved version.
          </p>
        ) : null}
        <div className="dialog-actions">
          <Button
            kind="secondary"
            data-sd="editor-conflict-merge"
            disabled={!!conflictOperation}
            onClick={mergeConflict}
          >
            Merge independent changes
          </Button>
          <Button
            data-sd="editor-conflict-copy"
            disabled={!!conflictOperation}
            onClick={copyConflict}
          >
            Save a separate copy
          </Button>
          <Button
            kind="secondary"
            data-sd="editor-conflict-reload"
            disabled={!!conflictOperation}
            onClick={reloadConflict}
          >
            Discard edits and reload
          </Button>
          <Button
            kind="ghost"
            data-sd="editor-conflict-close"
            disabled={!!conflictOperation}
            onClick={() => conflictDialog.current?.close()}
          >
            Keep editing
          </Button>
          <Button
            kind="ghost"
            disabled={!!conflictOperation}
            data-sd="editor-conflict-download"
            onClick={downloadWorking}
          >
            Download working JSON
          </Button>
        </div>
      </dialog>
      <dialog
        ref={leaveDialog}
        className="app-dialog"
        aria-labelledby="leave-heading"
      >
        <h2 id="leave-heading">Save before leaving?</h2>
        <p>There are unsaved edits in this guide.</p>
        <div className="dialog-actions">
          <Button
            data-sd="editor-leave-save"
            onClick={() => {
              void (async () => {
                await pendingImage.current
                if (await controller.flush()) {
                  changed()
                  leaveDialog.current?.close()
                  leave.current?.()
                }
              })()
            }}
          >
            Save and leave
          </Button>
          <Button
            kind="danger"
            data-sd="editor-leave-discard"
            onClick={() => {
              imageGeneration.current++
              void (async () => {
                await pendingImage.current
                await controller.discard()
                leaveDialog.current?.close()
                leave.current?.()
              })()
            }}
          >
            Discard unsaved edits
          </Button>
          <Button
            kind="ghost"
            data-sd="editor-leave-stay"
            onClick={() => leaveDialog.current?.close()}
          >
            Stay
          </Button>
        </div>
      </dialog>
      <dialog
        ref={cleanupDialog}
        className="app-dialog"
        aria-labelledby="cleanup-heading"
      >
        <h2 id="cleanup-heading">Review suggested step titles</h2>
        <p>
          These suggestions use local text rules and captured target metadata.
          Nothing is sent to an AI provider.
        </p>
        {cleanup.length ? (
          <ul className="cleanup-list">
            {cleanup.map((item, index) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.selected}
                    data-sd="cleanup-select"
                    onChange={(event) =>
                      setCleanup((previous) =>
                        previous.map((entry, i) =>
                          i === index
                            ? { ...entry, selected: event.target.checked }
                            : entry,
                        ),
                      )
                    }
                  />
                  <span>
                    {item.before} → {item.after}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p>There are no suggested title changes.</p>
        )}
        <div className="dialog-actions">
          <Button
            kind="ghost"
            data-sd="cleanup-cancel"
            onClick={() => cleanupDialog.current?.close()}
          >
            Cancel
          </Button>
          <Button
            data-sd="cleanup-apply"
            disabled={!cleanup.some((item) => item.selected)}
            onClick={() => {
              controller.edit((doc) => {
                for (const item of cleanup.filter((entry) => entry.selected)) {
                  const target = doc.steps.find((s) => s.id === item.id)
                  if (target) target.title = item.after
                }
              })
              cleanupDialog.current?.close()
              announce('Selected local title suggestions applied.')
            }}
          >
            Apply selected
          </Button>
        </div>
      </dialog>
    </div>
  )
}

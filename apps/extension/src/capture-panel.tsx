import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { browser } from 'wxt/browser'
import {
  Badge,
  Button,
  Checkbox,
  Icon,
  Input,
  Kbd,
  Logo,
  Toggle,
} from '@stepdoc/ui'
import { IndexedDbAdapter, type GuideSummary } from '@stepdoc/storage'
import {
  capturePreferencesSchema,
  type ReviewEdit,
} from '@stepdoc/schema/capture'
import type { LegacyStorage } from './background'
import '@stepdoc/ui/styles.css'
import './capture-panel.css'
import { GuidePanel } from './guide-panel'
import { CaptureTime } from './capture-time'
import { PairingPanel } from './pairing-panel'
import { CaptureTargetPicker, targetMessages } from './capture-target-picker'
import {
  readTargetChoice,
  writeTargetChoice,
  type TargetChoice,
} from './capture-target-url'
import {
  captureTargetErrorSchema,
  captureTargetListSchema,
  type CaptureTarget,
} from '@stepdoc/schema/capture-target'
import { CaptureTargetError } from './capture-target'
import {
  applyPreferences,
  preferenceKey,
  readPreferences,
} from '../../app/src/preferences'

const popup = location.pathname.endsWith('popup.html')
const fullTab = new URL(location.href).searchParams.get('surface') === 'tab'
const compact = popup && !fullTab
document.body.dataset.captureSurface = compact ? 'popup' : 'tab'

function Confirm({
  title,
  children,
  onConfirm,
  onClose,
}: {
  title: string
  children: ReactNode
  onConfirm: () => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-labelledby="confirm-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <h2 id="confirm-title">{title}</h2>
      <p>{children}</p>
      <div className="capture-actions">
        <Button
          data-sd="capture-confirm-cancel"
          kind="secondary"
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button data-sd="capture-confirm" onClick={onConfirm}>
          Confirm
        </Button>
      </div>
    </dialog>
  )
}
function CapturePanel() {
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () => applyPreferences(readPreferences())
    const stored = (event: StorageEvent) => {
      if (event.key === preferenceKey || event.key === null) update()
    }
    update()
    window.addEventListener('storage', stored)
    media.addEventListener('change', update)
    return () => {
      window.removeEventListener('storage', stored)
      media.removeEventListener('change', update)
    }
  }, [])
  const [state, setState] = useState<LegacyStorage>({})
  const latest = useRef(state)
  const refreshNumber = useRef(0)
  const [ready, setReady] = useState(false)
  const [pairView, setPairView] = useState(
    new URL(location.href).searchParams.get('view') === 'pair',
  )
  const [busy, setBusy] = useState(false)
  const [targetChoice, setTargetChoice] = useState<TargetChoice>(() =>
    readTargetChoice(location.href),
  )
  const [targetReady, setTargetReady] = useState(false)
  const [notice, setNotice] = useState<{ text: string; phase: string } | null>(
    null,
  )
  const [activity, setActivity] = useState<string[]>([])
  const [recent, setRecent] = useState<GuideSummary[]>([])
  const [title, setTitle] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [confirm, setConfirm] = useState<'discard' | 'merge' | null>(null)
  const review = state.captureReview
  const phase = state.captureError
    ? 'review'
    : (review?.phase ?? (state.recording ? 'recording' : 'idle'))
  const recording = phase === 'recording' || phase === 'paused'
  const reviewing = phase === 'review' || phase === 'saving'
  const committed = reviewing && !!review?.savedId
  const steps = state.capturedSteps ?? []
  const preferences = review?.preferences ?? capturePreferencesSchema.parse({})
  const transition = ['starting', 'pausing', 'stopping', 'saving'].includes(
    phase,
  )
  const disabled = !ready || busy || transition
  const announce = (text: string) => {
    const current = latest.current
    setNotice({
      text,
      phase: current.captureError
        ? 'review'
        : (current.captureReview?.phase ??
          (current.recording ? 'recording' : 'idle')),
    })
    setActivity((items) => [...items.slice(-99), text])
  }
  async function refresh() {
    const n = ++refreshNumber.current
    const next: LegacyStorage = await browser.runtime.sendMessage({
      type: 'GET_STATE',
    })
    if (n !== refreshNumber.current) return
    latest.current = next
    setState(next)
    setReady(true)
  }
  async function loadRecent() {
    let storage: IndexedDbAdapter | undefined
    try {
      storage = await IndexedDbAdapter.open()
      setRecent((await storage.listGuides()).items.slice(0, compact ? 2 : 3))
    } catch {
      announce('Recent captures are unavailable. Open the library to retry.')
    } finally {
      storage?.close()
    }
  }
  useEffect(() => {
    void refresh().catch(() =>
      announce('Capture controls are unavailable. Reopen this panel to retry.'),
    )
    void loadRecent()
    const changed = (_changes: unknown, area: string) => {
      if (area === 'local') void refresh()
    }
    browser.storage.onChanged.addListener(changed)
    return () => browser.storage.onChanged.removeListener(changed)
  }, [])
  useEffect(() => {
    const url = new URL(location.href)
    if (fullTab) writeTargetChoice(url, targetChoice)
    url.searchParams.set(
      'view',
      state.guideMe
        ? 'guide-me'
        : pairView && phase === 'idle'
          ? 'pair'
          : reviewing
            ? 'review'
            : recording
              ? phase
              : 'idle',
    )
    if (state.guideMe) {
      url.searchParams.set(
        'step',
        String(Math.min(state.guideMe.index + 1, state.guideMe.steps.length)),
      )
      url.searchParams.set('guide', state.guideMe.guideId)
    } else {
      url.searchParams.delete('step')
      url.searchParams.delete('guide')
    }
    history.replaceState(null, '', url)
  }, [
    phase,
    pairView,
    state.guideMe?.index,
    state.guideMe?.guideId,
    targetChoice,
  ])
  useEffect(() => {
    setTitle(review?.title ?? '')
    setSelected([])
  }, [review?.title, state.captureSessionId])
  useEffect(() => {
    void loadRecent()
  }, [review?.savedId])
  const invoke = async (type: string, extra: Record<string, unknown> = {}) => {
    const current = latest.current
    const result: { ok: boolean; id?: string; code?: unknown } =
      await browser.runtime.sendMessage({
        type,
        sessionId: current.captureSessionId,
        revision: current.captureReview?.revision,
        ...extra,
      })
    await refresh()
    if (!result.ok) {
      const code = captureTargetErrorSchema.safeParse(result.code)
      if (code.success) throw new CaptureTargetError(code.data)
      throw new Error('Command failed')
    }
    return result
  }
  async function command(
    type: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    if (busy) return
    setBusy(true)
    try {
      await invoke(type, extra)
      if (compact && type === 'STOP_REVIEW') await invoke('OPEN_CAPTURE_REVIEW')
      announce(message)
      if (fullTab && type === 'START_CAPTURE') {
        try {
          const current = await browser.tabs.getCurrent()
          if (!current?.id) throw new Error()
          await browser.tabs.remove(current.id)
        } catch {
          announce(
            'Capture started on the selected web page. This controls tab could not close; use the controls on that page to pause or stop.',
          )
        }
      }
    } catch (error) {
      announce(
        error instanceof CaptureTargetError
          ? targetMessages[error.code]
          : 'Operation could not finish. The capture is retained; refresh and retry.',
      )
    } finally {
      setBusy(false)
    }
  }
  const edit = (edit: ReviewEdit) =>
    command('EDIT_REVIEW', 'Review updated.', { edit })
  async function save(openEditor: boolean) {
    setBusy(true)
    try {
      if (!title.trim()) {
        announce('Enter a guide title before saving.')
        return
      }
      if (title.trim() !== latest.current.captureReview?.title)
        await invoke('EDIT_REVIEW', {
          edit: { operation: 'title', title: title.trim() },
        })
      await invoke('SAVE_CAPTURE', { openEditor })
      announce(
        openEditor
          ? 'Saved locally and opened the editor.'
          : 'Saved to this browser.',
      )
    } catch {
      announce(
        latest.current.captureReview?.savedId
          ? 'Guide is saved locally. Retry opening the editor or keep it local.'
          : 'Local save could not finish. Your review is retained; retry saving.',
      )
    } finally {
      setBusy(false)
    }
  }
  const status =
    state.captureError ??
    (transition
      ? `${phase[0]!.toUpperCase()}${phase.slice(1)}…`
      : (notice?.phase === phase ? notice.text : '') ||
        (phase === 'recording'
          ? `Recording - ${steps.length} steps`
          : phase === 'paused'
            ? `Paused - ${steps.length} steps`
            : reviewing
              ? `Review ${steps.length} captured steps`
              : state.pendingSession
                ? 'Saved upload waiting'
                : 'Ready to capture'))
  const positions = selected
    .map((id) => steps.findIndex((step) => step.id === id))
    .sort((a, b) => a - b)
  const canMerge =
    positions.length > 1 && positions.every((at, i) => at === positions[0]! + i)
  if (state.guideMe) return <GuidePanel run={state.guideMe} />
  const openPair = () => {
    if (!compact) {
      setPairView(true)
      return
    }
    setBusy(true)
    void (async () => {
      const url = new URL(
        browser.runtime.getURL('/popup.html') + '?surface=tab&view=pair',
      )
      let target: CaptureTarget | null = null
      try {
        const reply: { ok: boolean; state?: unknown } =
          await browser.runtime.sendMessage({ type: 'CAPTURE_TARGETS' })
        const parsed = captureTargetListSchema.safeParse(reply.state)
        if (reply.ok && parsed.success) target = parsed.data.suggested
      } catch {}
      writeTargetChoice(url, { target, explicit: true, invalid: false })
      await browser.tabs.create({ url: url.href })
    })()
      .catch(() =>
        announce('Pairing controls could not open. Retry opening them.'),
      )
      .finally(() => setBusy(false))
  }
  if (ready && pairView && phase === 'idle')
    return <PairingPanel fullTab={fullTab} onExit={() => setPairView(false)} />
  return (
    <div
      className="capture-panel"
      data-compact={compact}
      data-full-tab={fullTab}
      data-phase={phase}
    >
      <header className="capture-header">
        <h1 className="sd-sr-only">StepDoc</h1>
        <Logo />
        <Badge
          className={recording ? 'capture-recording-badge' : undefined}
          tone={phase === 'recording' ? 'danger' : 'neutral'}
          dot={compact && phase === 'idle'}
        >
          {phase === 'recording' ? <Icon name="pill-dot" /> : null}
          {phase === 'recording'
            ? 'REC'
            : phase === 'paused'
              ? 'Paused'
              : reviewing
                ? 'Stopped'
                : 'Local'}
          {recording ? <CaptureTime clock={review?.clock} /> : null}
        </Badge>
        {!compact ? (
          <a
            href="options.html"
            target="_blank"
            className="capture-settings"
            aria-label="Settings"
            data-sd="capture-settings"
          >
            <Icon name="sliders" />
          </a>
        ) : null}
      </header>
      <main id="capture-main" className="capture-main">
        {phase === 'idle' || phase === 'starting' ? (
          <>
            {!compact ? (
              <div className="capture-destination">
                <span>Save captures to</span>
                <span>This browser</span>
                <Button
                  kind="ghost"
                  size="s"
                  icon="popup-pair"
                  data-sd="capture-pair"
                  disabled={phase !== 'idle' || disabled}
                  onClick={openPair}
                >
                  Pair server
                </Button>
              </div>
            ) : null}
            {fullTab ? (
              <CaptureTargetPicker
                choice={targetChoice}
                onChoice={setTargetChoice}
                onAvailable={setTargetReady}
                onNotice={announce}
                disabled={disabled}
              />
            ) : null}
            <div className="capture-start-card">
              <Button
                className="capture-record"
                aria-label="Start capture"
                data-sd="capture-start"
                disabled={disabled || (fullTab && !targetReady)}
                onClick={() => {
                  setNotice(null)
                  void command(
                    'START_CAPTURE',
                    'Capture started.',
                    fullTab ? { target: targetChoice.target } : {},
                  )
                }}
              >
                <Icon name={compact ? 'popup-record' : 'capture-record'} />
              </Button>
              <div>
                <h2>Start capture</h2>
                {!compact ? (
                  <p>
                    Records clicks, selects, navigation and page structure.
                    Typed values are never recorded.
                  </p>
                ) : null}
                {compact ? (
                  <p className="capture-popup-shortcut">Alt + Shift + S</p>
                ) : (
                  <div className="capture-shortcut">
                    <Kbd>Alt</Kbd>
                    <Kbd>Shift</Kbd>
                    <Kbd>S</Kbd>
                  </div>
                )}
              </div>
            </div>
            <section className="capture-options" aria-label="Capture options">
              <div>
                <div>
                  <h3>Smart blur</h3>
                  {!compact ? (
                    <p>
                      Pixelate detected text before screenshots are stored.
                      Typed fields are always masked.
                    </p>
                  ) : null}
                </div>
                <Toggle
                  on={preferences.smartBlur}
                  aria-label="Smart blur"
                  data-sd="capture-smart-blur"
                  disabled={disabled}
                  onChange={(on) =>
                    void command(
                      'SET_CAPTURE_PREFERENCES',
                      'Smart blur preference updated.',
                      { preferences: { ...preferences, smartBlur: on } },
                    )
                  }
                />
              </div>
              <div>
                <div>
                  <h3>
                    Agent context{' '}
                    {!compact ? (
                      <Badge tone="agent" dot={false}>
                        Agent
                      </Badge>
                    ) : null}
                  </h3>
                  {!compact ? (
                    <p>
                      Save role, accessible name, selectors and expected result
                      per step.
                    </p>
                  ) : null}
                </div>
                <Toggle
                  on={preferences.agentContext}
                  aria-label="Agent context"
                  data-sd="capture-agent-context"
                  disabled={disabled}
                  onChange={(on) =>
                    void command(
                      'SET_CAPTURE_PREFERENCES',
                      'Agent context preference updated.',
                      { preferences: { ...preferences, agentContext: on } },
                    )
                  }
                />
              </div>
            </section>
            <section className="capture-recent" aria-labelledby="recent-title">
              <div className="capture-section-label">
                <h2 id="recent-title">
                  {compact ? 'Recent' : 'Recent captures'}
                </h2>
              </div>
              {recent.length ? (
                recent.map((guide, index) => (
                  <a
                    className="capture-recent-card"
                    data-sd="capture-recent"
                    key={guide.id}
                    href={`app.html?route=${encodeURIComponent(`/g/${guide.id}/edit`)}`}
                    target="_blank"
                  >
                    {!compact ? (
                      <span className="capture-number">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                    ) : null}
                    <Icon name="popup-file" />
                    <span>
                      {guide.title}
                      {!compact ? (
                        <small>{guide.stepCount} steps · this browser</small>
                      ) : null}
                    </span>
                  </a>
                ))
              ) : (
                <p>No local guides yet. Start a capture to create one.</p>
              )}
            </section>
          </>
        ) : null}
        {recording || phase === 'pausing' || phase === 'stopping' ? (
          <>
            <aside className="capture-privacy" aria-label="Capture privacy">
              <Icon name="export-shield" />
              <span>
                {preferences.smartBlur
                  ? 'Smart blur active'
                  : 'Typed fields masked'}{' '}
                · {state.captureManualCount ?? 0} manual selections
              </span>
            </aside>
            <div className="capture-section-label">
              <h2>Steps · {phase === 'paused' ? 'paused' : 'live'}</h2>
              <span>{steps.length}</span>
            </div>
            <ol className="capture-steps">
              {steps.map((step, i) => (
                <li
                  id={`step-${i + 1}`}
                  data-sd-step={i + 1}
                  key={step.id}
                  className="capture-live-row"
                >
                  <span className="capture-number">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  {state.steps?.[i]?.screenshot ? (
                    <img
                      src={state.steps[i]!.screenshot}
                      alt=""
                      width="56"
                      height="36"
                    />
                  ) : null}
                  <span>
                    {step.title}
                    <small>
                      {step.action ?? step.type}
                      {step.target?.role ? ` · ${step.target.role}` : ''}
                    </small>
                  </span>
                </li>
              ))}
            </ol>
            {!steps.length ? (
              <p className="capture-waiting">
                <Icon name="capture-pointer" />
                {phase === 'paused'
                  ? 'Resume to capture more steps.'
                  : 'Interact with the page to add your first step.'}
              </p>
            ) : null}
            <Button
              kind="ghost"
              size="s"
              data-sd="capture-blur"
              disabled={disabled || phase !== 'recording'}
              onClick={() =>
                void command(
                  'SET_BLUR_MODE',
                  state.captureBlurMode
                    ? 'Finished choosing blur.'
                    : 'Choose an element on the page to blur.',
                  { on: !state.captureBlurMode },
                )
              }
            >
              {state.captureBlurMode
                ? 'Finish choosing blur'
                : 'Choose element to blur (Alt+B)'}
            </Button>
          </>
        ) : null}
        {reviewing && compact ? (
          <section
            className="capture-popup-review"
            aria-labelledby="popup-review-heading"
          >
            <h2 id="popup-review-heading">Review your capture</h2>
            <p>{review?.title}</p>
            <p>{steps.length} captured steps retained in this browser.</p>
            <p>Review, edit and save in a full tab.</p>
          </section>
        ) : null}
        {reviewing && !compact ? (
          <>
            <Input
              label="Guide title"
              data-sd="capture-title"
              value={title}
              maxLength={200}
              disabled={disabled || committed}
              onChange={(event) => setTitle(event.target.value)}
            />
            <p className="capture-hint">
              {committed
                ? 'Saved locally. Continue editing in the native editor.'
                : 'Suggested from the page origin. Edit before saving.'}
            </p>
            <div className="capture-counts">
              <Badge dot={false}>{steps.length} steps</Badge>
              <Badge tone="success" dot={false}>
                {steps.reduce((sum, step) => sum + step.redactions.length, 0)}{' '}
                masks applied
              </Badge>
              <Badge tone="warning" dot={false}>
                {steps.filter((step) => step.lowConfidence).length} unclear
              </Badge>
            </div>
            <p className="capture-hint">
              Select adjacent steps to merge, or delete selected steps.
              Alt+Up/Down reorders the focused row.
            </p>
            <ol className="capture-steps">
              {steps.map((step, i) => (
                <li
                  id={`step-${i + 1}`}
                  data-sd-step={i + 1}
                  key={step.id}
                  className="capture-review-row"
                  onKeyDown={(event) => {
                    if (
                      event.altKey &&
                      ['ArrowUp', 'ArrowDown'].includes(event.key)
                    ) {
                      event.preventDefault()
                      if (!disabled && !committed)
                        void edit({
                          operation: 'move',
                          id: step.id,
                          direction: event.key === 'ArrowUp' ? 'up' : 'down',
                        })
                    }
                  }}
                >
                  <Checkbox
                    checked={selected.includes(step.id)}
                    disabled={disabled || committed}
                    aria-label={`Select step ${i + 1}: ${step.title}`}
                    data-sd="capture-select-step"
                    onChange={(event) =>
                      setSelected((ids) =>
                        event.target.checked
                          ? [...ids, step.id]
                          : ids.filter((id) => id !== step.id),
                      )
                    }
                  />
                  <span className="capture-number">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span>
                    {step.title}
                    <small>
                      {step.action ?? step.type}
                      {step.value?.kind === 'secret'
                        ? ' · secret'
                        : step.value?.kind === 'variable'
                          ? ` · {${step.value.variable}}`
                          : step.target?.role
                            ? ` · ${step.target.role}`
                            : ''}
                    </small>
                  </span>
                  {step.lowConfidence ? (
                    <Badge tone="warning" dot={false}>
                      Review
                    </Badge>
                  ) : null}
                </li>
              ))}
            </ol>
            {!steps.length ? (
              <p>All steps were removed. Discard this review to start again.</p>
            ) : null}
            <div className="capture-actions">
              <Button
                data-sd="capture-merge"
                kind="ghost"
                size="s"
                icon="capture-merge"
                disabled={disabled || committed || !canMerge}
                onClick={() => setConfirm('merge')}
              >
                Merge selected
              </Button>
              <Button
                data-sd="capture-delete"
                kind="ghost"
                size="s"
                icon="capture-trash"
                disabled={disabled || committed || !selected.length}
                onClick={() => {
                  void edit({ operation: 'delete', ids: selected })
                  setSelected([])
                }}
              >
                Delete
              </Button>
            </div>
          </>
        ) : null}
      </main>
      <footer className="capture-footer">
        {recording || phase === 'pausing' || phase === 'stopping' ? (
          <div className="capture-actions">
            <Button
              kind="secondary"
              icon="capture-pause"
              data-sd="capture-pause"
              disabled={disabled}
              onClick={() =>
                void command(
                  phase === 'paused' ? 'RESUME_CAPTURE' : 'PAUSE_CAPTURE',
                  phase === 'paused' ? 'Capture resumed.' : 'Capture paused.',
                )
              }
            >
              {phase === 'paused' ? 'Resume' : 'Pause'}
            </Button>
            <Button
              icon="capture-stop"
              data-sd="capture-review"
              disabled={disabled}
              onClick={() =>
                void command(
                  'STOP_REVIEW',
                  'Capture stopped. Review before saving.',
                )
              }
            >
              Stop &amp; review
            </Button>
          </div>
        ) : null}
        {reviewing && compact ? (
          <Button
            data-sd="capture-open-review"
            disabled={disabled}
            icon="capture-next"
            onClick={() =>
              void command(
                'OPEN_CAPTURE_REVIEW',
                'Opened review in a full tab.',
              )
            }
          >
            Open review in a tab
          </Button>
        ) : null}
        {reviewing && !compact ? (
          <>
            <div className="capture-destination">
              <span>Save to</span>
              <span>This browser</span>
            </div>
            <div className="capture-actions">
              <Button
                kind="ghost"
                data-sd="capture-keep-local"
                disabled={disabled || !steps.length || !!state.captureError}
                onClick={() => void save(false)}
              >
                Keep local
              </Button>
              <Button
                icon="capture-next"
                data-sd="capture-save"
                disabled={disabled || !steps.length || !!state.captureError}
                onClick={() => void save(true)}
              >
                Save &amp; open editor
              </Button>
            </div>
          </>
        ) : null}
        <p
          id="status"
          role="status"
          className={
            state.captureError
              ? 'capture-error'
              : compact && phase === 'idle' && !notice
                ? 'sd-sr-only'
                : 'capture-hint'
          }
        >
          {status}
        </p>
        <nav aria-label="StepDoc">
          {compact ? (
            <>
              <Button
                kind="secondary"
                size="s"
                icon="popup-library"
                data-sd="capture-library"
                disabled={recording || transition || busy}
                onClick={() => {
                  void browser.tabs
                    .create({ url: browser.runtime.getURL('/app.html') })
                    .catch(() =>
                      announce('The library could not open. Retry opening it.'),
                    )
                }}
              >
                Open library
              </Button>
              <Button
                kind="ghost"
                size="s"
                icon="popup-pair"
                data-sd="capture-pair"
                disabled={phase !== 'idle' || disabled}
                onClick={openPair}
              >
                Pair server
              </Button>
            </>
          ) : (
            <a href="app.html" target="_blank" data-sd="capture-library">
              <Icon name="popup-library" />
              Open library
            </a>
          )}
          {phase !== 'idle' ? (
            <Button
              kind="ghost"
              size="s"
              data-sd="capture-discard"
              disabled={disabled}
              onClick={() => setConfirm('discard')}
            >
              Discard capture
            </Button>
          ) : null}
        </nav>
        {state.pendingSession ? (
          <Button
            data-sd="capture-retry"
            kind="secondary"
            size="s"
            disabled={disabled}
            onClick={() => void command('RETRY', 'Upload retry finished.')}
          >
            Retry saved upload
          </Button>
        ) : null}
        {compact ? (
          <p className="capture-hint">
            No side panel here: the popup starts and stops capture; the editor
            opens in a full tab.
          </p>
        ) : null}
      </footer>
      <aside
        className="capture-activity"
        aria-label="Capture activity"
        data-sd="capture-activity"
      >
        <details>
          <summary>Activity log</summary>
          <ol aria-label="Capture activity">
            {activity.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ol>
        </details>
      </aside>
      {confirm ? (
        <Confirm
          title={
            confirm === 'merge'
              ? 'Merge selected steps?'
              : 'Discard this capture?'
          }
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm === 'merge') {
              void edit({ operation: 'merge', ids: selected })
              setSelected([])
            } else void command('DISCARD_CAPTURE', 'Capture discarded.')
            setConfirm(null)
          }}
        >
          {confirm === 'merge'
            ? 'Combine instructions into one manual step and retain the first screenshot. The combined step will be marked for review and will require manual completion.'
            : 'The unsaved steps and screenshots will be removed from this browser.'}
        </Confirm>
      ) : null}
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<CapturePanel />)

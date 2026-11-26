import { createRoot, type Root } from 'react-dom/client'
import { AssetUrlProvider, Button, Icon, IconButton } from '@stepdoc/ui'
import { ownCaptureUi } from '@stepdoc/core/capture'
import {
  capturePillViewSchema,
  type CapturePillControl,
  type CapturePillView,
} from '@stepdoc/schema/capture'
import { browser } from 'wxt/browser'
import { captureSheet, loadCaptureFonts } from './capture-styles'
import { CaptureTime } from './capture-time'

/** The E02 pill is never a capture target or part of stored screenshot pixels. */
export class RecordingControls {
  private host?: HTMLElement
  private root?: Root
  private view?: CapturePillView
  private signature = ''
  private show = true
  private suspended = false
  private releaseTimer?: ReturnType<typeof setTimeout>
  private busy = false
  private notice = ''
  private activity: string[] = []
  constructor(
    private readonly document: Document,
    private readonly request: (
      command: CapturePillControl,
    ) => Promise<{ ok: boolean }>,
  ) {}
  private ensure() {
    if (this.host?.isConnected) return
    this.root?.unmount()
    const host = this.document.createElement('stepdoc-recording-controls')
    ownCaptureUi(host)
    host.hidden = true
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [
      captureSheet(`
      :host{all:initial;position:fixed;inset:0;z-index:2147483645;pointer-events:none;contain:strict;font:var(--sd-type-label-s);--sd-recording-dot:var(--sd-danger-solid)}
      :host([hidden]){display:none!important}
      .recording-pill{position:fixed;top:var(--sd-space-4);left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:var(--sd-space-2) var(--sd-space-2) var(--sd-space-2) 14px;width:max-content;max-width:calc(100vw - 32px);min-height:48px;box-sizing:border-box;border-radius:var(--sd-radius-full);background:var(--sd-bg-surface);color:var(--sd-text-on-overlay);box-shadow:var(--sd-shadow-float);pointer-events:auto}
      .recording-pill p{font:var(--sd-type-label-s);min-width:0;margin:0;overflow-wrap:anywhere}
      .recording-pill>.sd-icon{color:var(--sd-recording-dot)}
      .recording-pill[data-paused=true]>.sd-icon{color:var(--sd-text-secondary)}
      .recording-pill button{flex-shrink:0}
    `),
    ]
    const mount = this.document.createElement('div')
    shadow.append(mount)
    this.document.documentElement.append(host)
    this.host = host
    this.root = createRoot(mount)
    loadCaptureFonts(this.document)
  }
  update(raw: unknown, show = true) {
    if (this.document.defaultView !== this.document.defaultView!.top) return
    const result = capturePillViewSchema.safeParse(raw)
    const view = result.success ? result.data : undefined
    const signature = JSON.stringify([view, show])
    if (signature === this.signature && (!view || this.host?.isConnected))
      return
    const previous = this.view
    this.view = view
    this.show = show
    this.signature = signature
    if (previous?.sessionId !== view?.sessionId) {
      this.notice = ''
      this.busy = false
      this.activity = []
    }
    const message = this.status()
    if (message && message !== this.activity.at(-1))
      this.activity = [...this.activity.slice(-99), message]
    this.render()
  }
  private status() {
    if (!this.view) return ''
    const { phase, count } = this.view
    return (
      this.notice ||
      `${phase === 'recording' ? 'Recording' : phase === 'paused' ? 'Paused' : phase === 'pausing' ? 'Pausing…' : phase === 'stopping' ? 'Stopping…' : 'Capture stopped'} · ${count} ${count === 1 ? 'step' : 'steps'}`
    )
  }
  private async act(action: CapturePillControl['action']) {
    const view = this.view
    if (!view || this.busy) return
    this.busy = true
    this.notice = ''
    this.render()
    try {
      const result = await this.request({
        type: 'CAPTURE_PILL_CONTROL',
        sessionId: view.sessionId,
        action,
      })
      if (!result.ok) throw new Error()
    } catch {
      if (this.view?.sessionId === view.sessionId) {
        this.notice =
          this.view.phase === 'review'
            ? 'Capture retained. Retry opening review.'
            : 'Capture retained. Retry this action.'
        this.activity = [...this.activity.slice(-99), this.notice]
      }
    } finally {
      if (this.view?.sessionId === view.sessionId) {
        this.busy = false
        this.render()
      }
    }
  }
  private render() {
    const view = this.view
    const active =
      !!view &&
      ['recording', 'paused', 'pausing', 'stopping'].includes(view.phase)
    if ((!active && !this.notice) || !this.show) {
      this.root?.render(null)
      if (this.host) this.host.hidden = true
      return
    }
    this.ensure()
    this.host!.hidden = this.suspended
    const paused = view?.phase === 'paused'
    const disabled = this.busy || !['recording', 'paused'].includes(view!.phase)
    this.root!.render(
      <AssetUrlProvider
        resolve={(url) =>
          browser.runtime.getURL('/') +
          new URL(url, browser.runtime.getURL('/')).pathname.slice(1)
        }
      >
        <aside
          className="recording-pill"
          data-theme="dark"
          data-paused={paused}
          aria-label="Recording controls"
          data-sd="capture-pill"
        >
          <Icon name="pill-dot" />
          <p role="status" aria-live="polite">
            {this.status()}
          </p>
          {view?.phase === 'review' ? (
            <Button
              kind="ghost"
              size="s"
              data-sd="capture-pill-open-review"
              disabled={this.busy}
              onClick={(event) => {
                if (event.isTrusted) void this.act('open-review')
              }}
            >
              Open review
            </Button>
          ) : (
            <>
              {paused ? (
                <Button
                  kind="ghost"
                  size="s"
                  data-sd="capture-pill-resume"
                  disabled={disabled}
                  onClick={(event) => {
                    if (event.isTrusted) void this.act('resume')
                  }}
                >
                  Resume
                </Button>
              ) : (
                <IconButton
                  icon="pill-pause"
                  aria-label="Pause recording"
                  data-sd="capture-pill-pause"
                  disabled={disabled}
                  onClick={(event) => {
                    if (event.isTrusted) void this.act('pause')
                  }}
                />
              )}
              <IconButton
                icon="pill-stop"
                aria-label="Stop and review"
                data-sd="capture-pill-stop"
                disabled={disabled}
                onClick={(event) => {
                  if (event.isTrusted) void this.act('stop')
                }}
              />
            </>
          )}
        </aside>
        <aside className="sd-sr-only" aria-label="Recording activity">
          <CaptureTime clock={view?.clock} />
          <ol>
            {this.activity.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ol>
        </aside>
      </AssetUrlProvider>,
    )
  }
  async suspend() {
    const visible = this.host && !this.host.hidden
    this.suspended = true
    if (this.host) this.host.hidden = true
    clearTimeout(this.releaseTimer)
    this.releaseTimer = setTimeout(() => this.release(), 5_000)
    if (visible)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 80)
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            clearTimeout(timeout)
            resolve()
          }),
        )
      })
  }
  release() {
    clearTimeout(this.releaseTimer)
    this.suspended = false
    this.render()
  }
}

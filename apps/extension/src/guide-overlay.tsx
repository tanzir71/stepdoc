import { createRoot, type Root } from 'react-dom/client'
import { AssetUrlProvider, Button, IconButton, StepPin } from '@stepdoc/ui'
import { ownCaptureUi } from '@stepdoc/core/capture'
import type { GuideMeView, GuideMeControl } from '@stepdoc/schema/guide-me'
import { browser } from 'wxt/browser'
import { captureSheet, loadCaptureFonts } from './capture-styles'

export class GuideOverlay {
  private host?: HTMLElement
  private root?: Root
  private view?: GuideMeView
  private resize = () => this.render()
  constructor(
    private readonly document: Document,
    private readonly control: (command: GuideMeControl) => void,
  ) {
    document.defaultView!.addEventListener('resize', this.resize)
  }
  private ensure() {
    if (this.host?.isConnected) return
    this.root?.unmount()
    const host = this.document.createElement('stepdoc-guide-me')
    ownCaptureUi(host)
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [
      captureSheet(`
      :host{all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;contain:strict;font:var(--sd-type-body-s);color:var(--sd-text-primary)}
      .guide-shade{position:fixed;inset:0;width:100%;height:100%;pointer-events:none}
      .guide-ring{position:fixed;box-sizing:border-box;border:1px solid var(--sd-accent-solid);border-radius:var(--sd-radius-lg);pointer-events:none}
      .guide-tooltip{position:fixed;box-sizing:border-box;width:330px;max-width:calc(100vw - 32px);overflow-y:auto;padding:var(--sd-space-4);border-radius:var(--sd-radius-lg);background:var(--sd-bg-surface);box-shadow:var(--sd-shadow-float);display:flex;flex-direction:column;gap:10px;pointer-events:auto}
      .guide-tooltip header{display:flex;align-items:center;gap:var(--sd-space-2)}
      .guide-tooltip>[role=dialog]{display:flex;flex-direction:column;gap:10px}
      .guide-tooltip header .sd-button{margin-left:auto}
      .guide-count{font:var(--sd-type-mono-s);color:var(--sd-text-secondary)}
      .guide-tooltip h2{font:var(--sd-type-heading-s);letter-spacing:var(--sd-tracking-heading-s);margin:0;overflow-wrap:anywhere}
      .guide-tooltip p{font:var(--sd-type-body-s);color:var(--sd-text-secondary);margin:0;overflow-wrap:anywhere}
      .guide-tooltip nav{display:flex;align-items:center;gap:var(--sd-space-2)}
      .guide-tooltip nav button:first-child{margin-right:auto}
    `),
    ]
    const mount = this.document.createElement('div')
    shadow.append(mount)
    this.document.documentElement.append(host)
    this.host = host
    this.root = createRoot(mount)
    loadCaptureFonts(this.document)
  }
  show(view: GuideMeView) {
    this.view = view
    this.ensure()
    this.render()
  }
  hide() {
    this.view = undefined
    this.root?.render(null)
    if (this.host) this.host.hidden = true
  }
  private render() {
    const view = this.view
    if (!view) return
    this.ensure()
    this.host!.hidden = false
    const width = this.document.defaultView!.innerWidth,
      height = this.document.defaultView!.innerHeight
    const rect =
      view.phase === 'running' && view.rect
        ? {
            x: Math.max(0, view.rect.x - 8),
            y: Math.max(0, view.rect.y - 8),
            width:
              Math.min(width, view.rect.x + view.rect.width + 8) -
              Math.max(0, view.rect.x - 8),
            height:
              Math.min(height, view.rect.y + view.rect.height + 8) -
              Math.max(0, view.rect.y - 8),
          }
        : null
    const left = Math.max(
      16,
      Math.min(
        width - 346,
        rect ? rect.x + rect.width - 326 : (width - 330) / 2,
      ),
    )
    const top = Math.max(
      16,
      Math.min(
        height - 250,
        rect && rect.y + rect.height + 220 < height
          ? rect.y + rect.height + 20
          : rect
            ? rect.y - 220
            : 32,
      ),
    )
    const act = (action: GuideMeControl['action']) =>
      this.control({
        type: 'GUIDE_CONTROL',
        runId: view.runId,
        sequence: view.sequence,
        action,
      })
    const complete = view.phase === 'complete'
    const result = complete
      ? view.report?.status === 'passed'
        ? 'Walkthrough complete'
        : 'Walkthrough ended with incomplete steps'
      : view.phase === 'conflict'
        ? 'Guide changed during the walkthrough'
        : view.phase === 'save-error'
          ? 'Report could not be saved'
          : 'Saving walkthrough report…'
    this.root!.render(
      <AssetUrlProvider
        resolve={(url) =>
          browser.runtime.getURL('/') +
          new URL(url, browser.runtime.getURL('/')).pathname.slice(1)
        }
      >
        {view.phase === 'running' && (
          <>
            <svg
              className="guide-shade"
              aria-hidden="true"
              viewBox={`0 0 ${width} ${height}`}
            >
              <defs>
                <mask
                  id="stepdoc-guide-cutout"
                  maskUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width={width}
                  height={height}
                >
                  <rect width={width} height={height} fill="white" />
                  {rect && (
                    <rect
                      x={rect.x}
                      y={rect.y}
                      width={rect.width}
                      height={rect.height}
                      rx="12"
                      fill="black"
                    />
                  )}
                </mask>
              </defs>
              <rect
                width={width}
                height={height}
                fill="var(--sd-bg-overlay)"
                mask="url(#stepdoc-guide-cutout)"
              />
            </svg>
            {rect && (
              <div
                className="guide-ring"
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                }}
              />
            )}
          </>
        )}
        <aside
          aria-label="Guide Me controls"
          className="guide-tooltip"
          style={{ left, top, maxHeight: Math.max(0, height - top - 16) }}
          data-sd="guide-me-overlay"
          data-theme="light"
        >
          <div
            role="dialog"
            aria-labelledby="guide-title"
            aria-describedby="guide-description"
            aria-modal="false"
          >
            <header>
              <StepPin>{Math.min(view.index + 1, view.total)}</StepPin>
              <span className="guide-count">
                Step {Math.min(view.index + 1, view.total)} of {view.total}
              </span>
              <IconButton
                icon="export-close"
                aria-label={
                  view.phase === 'running'
                    ? 'End walkthrough'
                    : 'Close walkthrough'
                }
                data-sd="guide-me-close"
                disabled={view.phase === 'saving'}
                onClick={(event) => {
                  if (event.isTrusted)
                    act(view.phase === 'running' ? 'stop' : 'dismiss')
                }}
              />
            </header>
            <h2 id="guide-title">
              {view.phase === 'running' ? view.title : result}
            </h2>
            <p id="guide-description">
              {view.phase === 'running'
                ? view.description || 'Follow this step on the page.'
                : complete
                  ? `Report saved to the local guide. ${view.confirmed} steps manually confirmed.`
                  : view.phase === 'conflict'
                    ? 'The saved guide was not overwritten. End this walkthrough and start again from the editor.'
                    : 'Your report is retained. Retry saving from the panel or here.'}
            </p>
            {view.phase === 'running' && (
              <p
                role="status"
                className={view.reason === 'matched' ? 'sd-sr-only' : undefined}
              >
                {view.reason === 'matched'
                  ? 'Interact with the highlighted target to advance.'
                  : view.reason === 'ambiguous'
                    ? 'Several targets match. Confirm manually or skip.'
                    : 'Target unavailable. Find it on the page, confirm manually or skip.'}
              </p>
            )}
            {view.phase === 'running' ? (
              <nav aria-label="Walkthrough actions">
                <Button
                  kind="ghost"
                  size="s"
                  data-sd="guide-me-back"
                  disabled={view.index === 0}
                  onClick={(event) => {
                    if (event.isTrusted) act('back')
                  }}
                >
                  Back
                </Button>
                <Button
                  kind="secondary"
                  size="s"
                  data-sd="guide-me-skip"
                  onClick={(event) => {
                    if (event.isTrusted) act('skip')
                  }}
                >
                  Skip
                </Button>
                <Button
                  size="s"
                  icon="guide-check"
                  data-sd="guide-me-confirm"
                  onClick={(event) => {
                    if (event.isTrusted) act('confirm')
                  }}
                >
                  I did it
                </Button>
              </nav>
            ) : view.phase === 'save-error' ? (
              <Button
                data-sd="guide-me-retry"
                size="s"
                onClick={(event) => {
                  if (event.isTrusted) act('retry')
                }}
              >
                Retry saving report
              </Button>
            ) : null}
          </div>
        </aside>
      </AssetUrlProvider>,
    )
  }
}

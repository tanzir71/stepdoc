import { createRoot, type Root } from 'react-dom/client'
import { Button } from '@stepdoc/ui'
import uiStyles from '@stepdoc/ui/styles.css?inline'
import fontData from '../../../packages/ui/assets/fonts/GeistSans.woff2?inline'
import { ownCaptureUi, rectOf } from '@stepdoc/core/capture'

// A dedicated family cannot change a third-party page's fonts. Loading the
// bundled bytes avoids remote requests, page font CSP and public app resources.
let font: FontFace | undefined
function loadFont(document: Document) {
  if (!font) {
    const encoded = fontData.slice(fontData.indexOf(',') + 1)
    font = new FontFace(
      'StepDoc Capture',
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
      { weight: '100 900' },
    )
    void font
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => {})
  }
}
const sheet = () => {
  const value = new CSSStyleSheet()
  value.replaceSync(
    uiStyles
      .replace(/@font-face\s*\{[^}]*\}/g, '')
      .replaceAll(':root', ':host')
      .replaceAll('Geist', 'StepDoc Capture') +
      `
    :host{all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:strict;overflow:clip;}
    :host([hidden]){display:none!important}
    .capture-blur-pill{position:fixed;top:var(--sd-space-4);left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:var(--sd-space-2) var(--sd-space-2) var(--sd-space-2) 14px;width:max-content;max-width:calc(100vw - 32px);min-height:48px;border-radius:var(--sd-radius-full);background:var(--sd-bg-surface);color:var(--sd-text-on-overlay);box-shadow:var(--sd-shadow-float);font:var(--sd-type-label-s);pointer-events:auto;}
    .capture-blur-pill [role=status]{min-width:0;margin:0;}
    .capture-blur-pill button{flex-shrink:0;}
    .capture-blur-preview{position:fixed;box-sizing:border-box;border:1px solid var(--sd-accent-solid);pointer-events:none;}
  `,
  )
  return value
}

/** Alt+B is an additional privacy state, using E02's floating-pill geometry and
 * shared Button/tokens. The complete E02 recording controls remain separate. */
export class BlurControls {
  private host?: HTMLElement
  private preview?: HTMLElement
  private root?: Root
  private active = false
  private suspended = false
  private releaseTimer?: ReturnType<typeof setTimeout>
  private cursor?: CSSStyleSheet
  constructor(
    private readonly document: Document,
    private readonly done: () => void,
  ) {}
  private ensure() {
    if (this.host?.isConnected) return
    this.root?.unmount()
    const host = this.document.createElement('stepdoc-privacy-controls')
    ownCaptureUi(host)
    host.hidden = true
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.adoptedStyleSheets = [sheet()]
    const mount = this.document.createElement('div')
    const preview = this.document.createElement('div')
    preview.className = 'capture-blur-preview'
    preview.setAttribute('aria-hidden', 'true')
    preview.hidden = true
    shadow.append(mount, preview)
    this.document.documentElement.append(host)
    this.host = host
    this.preview = preview
    this.root = createRoot(mount)
    loadFont(this.document)
  }
  update(active: boolean, count: number, busy: boolean, showControls = true) {
    this.active = active
    if (active) {
      this.ensure()
      if (!this.cursor) {
        this.cursor = new CSSStyleSheet()
        this.cursor.replaceSync('html,body,body *{cursor:crosshair!important}')
        this.document.adoptedStyleSheets = [
          ...this.document.adoptedStyleSheets,
          this.cursor,
        ]
      }
      this.root!.render(
        showControls ? (
          <aside
            aria-label="Capture privacy controls"
            data-theme="dark"
            className="capture-blur-pill"
            data-sd="capture-blur-controls"
          >
            <p role="status" aria-live="polite">
              {busy
                ? 'Applying blur…'
                : `Choose an element to blur · ${count} added. Click, or focus and press Enter. Esc to finish.`}
            </p>
            <Button
              kind="ghost"
              size="s"
              data-sd="capture-blur-done"
              onClick={(event) => {
                if (event.isTrusted) this.done()
              }}
            >
              Done
            </Button>
          </aside>
        ) : null,
      )
    } else {
      this.root?.render(null)
      if (this.cursor)
        this.document.adoptedStyleSheets =
          this.document.adoptedStyleSheets.filter(
            (item) => item !== this.cursor,
          )
      this.cursor = undefined
      if (this.preview) this.preview.hidden = true
    }
    if (this.host) this.host.hidden = !active || this.suspended
  }
  hover(element?: Element) {
    if (!this.active || !element) {
      if (this.preview) this.preview.hidden = true
      return
    }
    this.ensure()
    const rect = rectOf(element)
    const preview = this.preview!
    preview.style.left = `${rect.x}px`
    preview.style.top = `${rect.y}px`
    preview.style.width = `${rect.width}px`
    preview.style.height = `${rect.height}px`
    preview.hidden = false
  }
  async suspend(): Promise<void> {
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
    if (this.host) this.host.hidden = !this.active
  }
}

import uiStyles from '@stepdoc/ui/styles.css?inline'
import sans from '../../../packages/ui/assets/fonts/GeistSans.woff2?inline'
import mono from '../../../packages/ui/assets/fonts/GeistMono.woff2?inline'

const fonts = new Map<string, FontFace>()
export function loadCaptureFonts(document: Document) {
  for (const [family, data] of [
    ['StepDoc Capture', sans],
    ['StepDoc Capture Mono', mono],
  ]) {
    let font = fonts.get(family!)
    if (!font) {
      font = new FontFace(
        family!,
        Uint8Array.from(atob(data!.slice(data!.indexOf(',') + 1)), (value) =>
          value.charCodeAt(0),
        ),
        { weight: '100 900' },
      )
      fonts.set(family!, font)
    }
    void font
      .load()
      .then((loaded) => document.fonts.add(loaded))
      .catch(() => {})
  }
}
export function captureSheet(extra: string): CSSStyleSheet {
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(
    uiStyles
      .replace(/@font-face\s*\{[^}]*\}/g, '')
      .replaceAll(':root', ':host')
      .replaceAll('Geist', 'StepDoc Capture') + extra,
  )
  return sheet
}

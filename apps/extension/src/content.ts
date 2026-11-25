import { browser } from 'wxt/browser'
import { metaFromEvent, sensitiveRects } from './capture'
export function startContent() {
  let recording = false
  const send = (meta: ReturnType<typeof metaFromEvent>) =>
    browser.runtime.sendMessage({
      type: 'CAPTURE',
      meta,
      sensitive: sensitiveRects(),
    })
  browser.runtime.onMessage.addListener((m) => {
    if (m.type === 'STATE') recording = m.recording
  })
  browser.storage.local
    .get('recording')
    .then((v) => (recording = Boolean(v.recording)))
  addEventListener(
    'mousedown',
    (e) => {
      if (recording && e.isTrusted && e.target instanceof Element)
        send(
          metaFromEvent('click', e.target, {
            click: { x: e.clientX, y: e.clientY },
          }),
        )
    },
    true,
  )
  addEventListener(
    'blur',
    (e) => {
      if (
        recording &&
        e.target instanceof HTMLInputElement &&
        !['button', 'submit', 'checkbox', 'radio'].includes(e.target.type)
      )
        send(metaFromEvent('input', e.target))
    },
    true,
  )
  addEventListener(
    'change',
    (e) => {
      if (recording && e.target instanceof HTMLSelectElement)
        send(
          metaFromEvent('select', e.target, {
            optionLabel: e.target.selectedOptions[0]?.text,
          }),
        )
    },
    true,
  )
  addEventListener(
    'keydown',
    (e) => {
      if (recording && e.key === 'Enter' && e.target instanceof Element)
        send(metaFromEvent('submit', e.target))
    },
    true,
  )
}

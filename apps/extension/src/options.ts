import { browser } from 'wxt/browser'
import './style.css'
const input = document.getElementById('url') as HTMLInputElement
browser.storage.local
  .get('appUrl')
  .then(
    (v) =>
      (input.value =
        typeof v.appUrl === 'string' ? v.appUrl : 'http://localhost:3000'),
  )
document.getElementById('save')!.onclick = () =>
  browser.storage.local
    .set({ appUrl: input.value.replace(/\/$/, '') })
    .then(() => (document.getElementById('status')!.textContent = 'Saved'))

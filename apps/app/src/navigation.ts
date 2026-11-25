import { useSyncExternalStore } from 'react'
const eventName = 'stepdoc:navigate'
export function navigate(url: string, replace = false) {
  const target = new URL(url, location.origin)
  if (target.origin !== location.origin) return
  history[replace ? 'replaceState' : 'pushState'](
    {},
    '',
    target.pathname + target.search + target.hash,
  )
  window.dispatchEvent(new Event(eventName))
}
function subscribe(callback: () => void) {
  window.addEventListener('popstate', callback)
  window.addEventListener(eventName, callback)
  return () => {
    window.removeEventListener('popstate', callback)
    window.removeEventListener(eventName, callback)
  }
}
export function useLocation() {
  return useSyncExternalStore(
    subscribe,
    () => location.pathname + location.search,
    () => '/',
  )
}

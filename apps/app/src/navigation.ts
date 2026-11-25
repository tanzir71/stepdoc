import { useSyncExternalStore } from 'react'
import { appHref, readAppRoute, routeLocation } from './app-url'
const eventName = 'stepdoc:navigate'
interface Guard {
  dirty: () => boolean
  ask: (proceed: () => void) => void
}
let guard: Guard | undefined
let index =
  typeof history !== 'undefined' ? Number(history.state?.sdIndex ?? 0) : 0
let currentPath =
  typeof location !== 'undefined' ? routeLocation().pathname : '/'
let restoring: (() => void) | undefined
let approvedPop = false
const listeners = new Set<() => void>()
const publish = () => {
  for (const callback of listeners) callback()
}
export function guardNavigation(next: Guard) {
  guard = next
  return () => {
    if (guard === next) guard = undefined
  }
}
export function navigate(url: string, replace = false, approved = false) {
  const target = new URL(appHref(url), location.href)
  if (target.protocol !== location.protocol || target.host !== location.host)
    return
  const targetPath = new URL(readAppRoute(target), 'https://stepdoc.invalid')
    .pathname
  if (!approved && targetPath !== routeLocation().pathname && guard?.dirty()) {
    guard.ask(() => navigate(url, replace, true))
    return
  }
  if (!replace) index++
  history[replace ? 'replaceState' : 'pushState'](
    { sdIndex: index },
    '',
    target.pathname + target.search + target.hash,
  )
  currentPath = targetPath
  window.dispatchEvent(new Event(eventName))
}
function subscribe(callback: () => void) {
  if (!listeners.size) {
    history.replaceState({ ...history.state, sdIndex: index }, '')
    window.addEventListener('popstate', pop)
    window.addEventListener(eventName, publish)
  }
  listeners.add(callback)
  return () => {
    listeners.delete(callback)
    if (!listeners.size) {
      window.removeEventListener('popstate', pop)
      window.removeEventListener(eventName, publish)
    }
  }
}
function pop(event: PopStateEvent) {
  const targetIndex = Number(event.state?.sdIndex ?? 0)
  if (restoring) {
    if (targetIndex !== index) {
      history.go(index - targetIndex)
      return
    }
    const ask = restoring
    restoring = undefined
    ask()
    return
  }
  if (
    !approvedPop &&
    currentPath !== routeLocation().pathname &&
    guard?.dirty() &&
    targetIndex !== index
  ) {
    const delta = index - targetIndex
    const activeGuard = guard
    restoring = () =>
      activeGuard.ask(() => {
        approvedPop = true
        history.go(-delta)
      })
    history.go(delta)
    return
  }
  approvedPop = false
  index = targetIndex
  currentPath = routeLocation().pathname
  publish()
}
export function useLocation() {
  return useSyncExternalStore(
    subscribe,
    () => readAppRoute(),
    () => '/',
  )
}

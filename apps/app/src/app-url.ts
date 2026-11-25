const routeBase = 'https://stepdoc.invalid'

export function isExtensionUrl(url: URL): boolean {
  return (
    url.protocol === 'chrome-extension:' || url.protocol === 'moz-extension:'
  )
}

function localRoute(route: string): URL {
  const url = new URL(route, routeBase)
  if (url.origin !== routeBase) throw new Error('Invalid local app route')
  return url
}

// Extension resources are files, so a logical route must survive a full reload
// without requesting /g/:id from the extension's resource server.
export function readAppRoute(url = new URL(location.href)): string {
  if (!isExtensionUrl(url)) return url.pathname + url.search
  try {
    const route = localRoute(url.searchParams.get('route') ?? '/')
    return route.pathname + route.search
  } catch {
    return '/'
  }
}

export function appHref(route: string, base = new URL(location.href)): string {
  if (!isExtensionUrl(base) || route.startsWith('#')) return route
  const url = localRoute(route)
  return `/app.html?route=${encodeURIComponent(url.pathname + url.search)}${url.hash}`
}

export function absoluteAppHref(route: string): string {
  return new URL(appHref(route), location.href).href
}

export function routeLocation(): URL {
  return new URL(readAppRoute(), routeBase)
}

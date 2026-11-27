import { StorageError } from '@stepdoc/storage'

export interface HostedConfig {
  api: string
  base: string
}
export function parseHostedConfig(value: string, page: URL): HostedConfig {
  const url = new URL(value, page)
  if (
    url.origin !== page.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/(?:[a-zA-Z0-9_-]+\/)*api\/v1\/$/.test(url.pathname) ||
    !['http:', 'https:'].includes(url.protocol)
  )
    throw new StorageError('invalid_options')
  return { api: url.href, base: url.pathname.slice(0, -'/api/v1/'.length) }
}
export function hostedConfig(): HostedConfig | null {
  if (typeof document === 'undefined') return null
  const meta = document.querySelector('meta[name="stepdoc-api"]')
  return meta
    ? parseHostedConfig(
        meta.getAttribute('content') ?? '',
        new URL(location.href),
      )
    : null
}

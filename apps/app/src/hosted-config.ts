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

export function parseClientBase(value: string): string {
  if (!/^(?:\/[a-zA-Z0-9_-]+)*$/.test(value) || value.length > 200)
    throw new StorageError('invalid_options')
  return value
}
export function clientBase(): string {
  const hosted = hostedConfig()
  if (hosted) return hosted.base
  const meta =
    typeof document === 'undefined'
      ? null
      : document.querySelector('meta[name="stepdoc-base"]')
  return meta ? parseClientBase(meta.getAttribute('content') ?? '') : ''
}
export function setupEndpoint(): string | null {
  if (typeof document === 'undefined') return null
  const meta = document.querySelector('meta[name="stepdoc-install"]')
  if (!meta) return null
  const url = new URL(meta.getAttribute('content') ?? '', location.href)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== location.origin ||
    url.pathname !== clientBase() + '/install.php' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new StorageError('invalid_options')
  return url.href
}

import { describe, expect, it } from 'vitest'
import { parseHostedConfig } from './hosted-config'
import { appHref, readAppRoute } from './app-url'

describe('hosted installation routing', () => {
  it('keeps deep links, anchors and worker entry paths within the selected installation', () => {
    const page = new URL(
      'https://example.test/tools/g/sample-guide/edit?step=4',
    )
    const config = parseHostedConfig('/tools/api/v1/', page)
    expect(config).toEqual({
      api: 'https://example.test/tools/api/v1/',
      base: '/tools',
    })
    expect(readAppRoute(page, config.base)).toBe('/g/sample-guide/edit?step=4')
    expect(
      appHref('/g/sample-guide/export?format=json#main', page, config.base),
    ).toBe('/tools/g/sample-guide/export?format=json#main')
    expect(appHref('/', page, config.base)).toBe('/tools/')
    expect(appHref('#main', page, config.base)).toBe('#main')
  })
  it('supports a root installation without changing browser or extension URLs', () => {
    expect(
      parseHostedConfig('/api/v1/', new URL('https://example.test/')).base,
    ).toBe('')
  })
  it('rejects credentials, cross-origin APIs, queries, fragments and malformed mount paths', () => {
    const page = new URL('https://example.test/tools/')
    for (const value of [
      'https://other.test/api/v1/',
      'https://user:password@example.test/api/v1/',
      '/tools/api/v1/?token=private',
      '/tools/api/v1/#private',
      '/tools/%2f/api/v1/',
      '/api/v1',
      '',
      '/not-an-api/',
    ]) {
      expect(() => parseHostedConfig(value, page)).toThrow()
    }
  })
})

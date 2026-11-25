import { describe, expect, it } from 'vitest'
import { appHref, readAppRoute } from './app-url'

describe('portable app URLs', () => {
  const route = '/g/example-guide/edit?step=4&panel=history'
  for (const protocol of ['chrome-extension:', 'moz-extension:']) {
    const base = new URL(`${protocol}//example/app.html`)
    it(`${protocol} round-trips deep links, queries and native anchors`, () => {
      const href = appHref(route, base)
      expect(href).toBe(`/app.html?route=${encodeURIComponent(route)}`)
      expect(readAppRoute(new URL(href, base))).toBe(route)
      expect(appHref('#main', base)).toBe('#main')
      expect(appHref(`${route}#step-4`, base)).toBe(`${href}#step-4`)
      expect(readAppRoute(base)).toBe('/')
    })
    it(`${protocol} rejects external routes and recovers invalid links`, () => {
      for (const route of [
        'https://outside.test',
        '//outside.test',
        '/\\outside.test',
      ]) {
        expect(() => appHref(route, base)).toThrow('Invalid local app route')
        const malformed = new URL(base)
        malformed.searchParams.set('route', route)
        expect(readAppRoute(malformed)).toBe('/')
      }
    })
  }
  it('keeps deployed web URLs unchanged', () => {
    const base = new URL('https://example.test/')
    expect(appHref(route, base)).toBe(route)
    expect(readAppRoute(new URL(route, base))).toBe(route)
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSelector, cssEscape, rankLocators } from '../src'

beforeEach(() => {
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function selected(
  html: string,
  query: string,
): { target: Element; selector: string } {
  document.body.innerHTML = html
  const target = document.querySelector(query)!
  return { target, selector: buildSelector(target) }
}

describe('CSS selector fallbacks', () => {
  it.each([
    [
      '<button id="same">First</button><button id="same">Second</button>',
      'button:nth-of-type(2)',
    ],
    [
      '<button data-testid="same">First</button><button data-testid="same">Second</button>',
      'button:nth-of-type(2)',
    ],
    [
      '<form><input name="choice"><input name="choice"></form>',
      'input:nth-of-type(2)',
    ],
  ])('distinguishes repeated identities in %s', (html, query) => {
    const { target, selector } = selected(html, query)
    expect([...document.querySelectorAll(selector)]).toEqual([target])
  })

  it.each([
    '123',
    '-1',
    '-',
    'save:now',
    'a b',
    'a[b]',
    'a"b',
    'a\\b',
    'éclair',
    '😀button',
    'a\nb',
  ])('escapes the actual ID %s into a working selector', (id) => {
    const target = document.createElement('button')
    target.id = id
    document.body.append(target)
    expect(document.querySelector(buildSelector(target))).toBe(target)
  })

  it('escapes attribute values and anchors paths at a unique ancestor', () => {
    document.body.innerHTML =
      '<section id="settings"><form><input></form></section>'
    const target = document.querySelector('input')!
    target.setAttribute('name', 'a"b\\c [d]')
    const selector = buildSelector(target)
    expect(selector).toMatch(/^#settings > form > input/)
    expect(document.querySelector(selector)).toBe(target)
  })

  it('uses the target document when it lives in an iframe', () => {
    document.body.innerHTML = '<button id="save"></button><iframe></iframe>'
    const frameDocument = document.querySelector('iframe')!.contentDocument!
    frameDocument.body.innerHTML = '<button id="save">Save</button>'
    const target = frameDocument.querySelector('button')!
    expect(buildSelector(target)).toBe('#save')
    expect(frameDocument.querySelector(buildSelector(target))).toBe(target)
  })

  it('scopes identity and sibling positions to an open shadow root', () => {
    document.body.innerHTML = '<button id="save"></button><div id="host"></div>'
    const root = document.querySelector('#host')!.attachShadow({ mode: 'open' })
    root.innerHTML =
      '<button id="save">Save</button><span></span><span>Second</span>'
    const target = root.querySelector('button')!
    expect(buildSelector(target)).toBe('#save')
    const second = root.querySelectorAll('span')[1]!
    expect(buildSelector(second)).toBe('span:nth-of-type(2)')
    expect(root.querySelector(buildSelector(second))).toBe(second)
  })

  it('does not read .value while constructing selectors for sensitive fields', () => {
    document.body.innerHTML =
      '<form><input type="password" name="password"></form>'
    const target = document.querySelector('input')!
    Object.defineProperty(target, 'value', {
      get() {
        throw new Error('Typed value was read')
      },
    })
    expect(document.querySelector(buildSelector(target))).toBe(target)
  })

  it('supports detached roots and the document element', () => {
    const root = document.createElement('div')
    root.innerHTML = '<button id="save"></button>'
    expect(root.querySelector(buildSelector(root.firstElementChild!))).toBe(
      root.firstElementChild,
    )
    expect(buildSelector(document.documentElement)).toBe('html')
  })

  it('uses native escaping when available and falls back when CSS.escape is absent', () => {
    const escape = vi.fn(() => 'native-result')
    vi.stubGlobal('CSS', { escape })
    expect(cssEscape('value')).toBe('native-result')
    expect(escape).toHaveBeenCalledWith('value')
    vi.stubGlobal('CSS', {})
    expect(cssEscape('1')).toBe('\\31 ')
    expect(cssEscape('\0')).toBe('\uFFFD')
  })

  it('ranks observed selectors using real DOM counts and drops invalid/missing selectors', () => {
    document.body.innerHTML =
      '<button id="first">Save</button><button id="second">Save</button>'
    const ranked = rankLocators(
      [
        { strategy: 'css', value: 'button' },
        { strategy: 'css', value: '#second' },
        { strategy: 'css', value: '#missing' },
        { strategy: 'css', value: '[' },
      ],
      (locator) => document.querySelectorAll(locator.value).length,
    )
    expect(ranked).toEqual([
      { strategy: 'css', value: '#second', exact: true, unique: true },
      { strategy: 'css', value: 'button', exact: true, unique: false },
    ])
  })
})

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveGuideTarget, guideCss } from './guide-target'
import { ownCaptureUi } from './owned-ui'

beforeEach(() => {
  document.body.innerHTML = ''
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 10,
    y: 20,
    width: 100,
    height: 30,
    left: 10,
    right: 110,
    top: 20,
    bottom: 50,
    toJSON() {},
  })
})
describe('live guide target resolution', () => {
  it('prefers unique role/name before a stale CSS locator', () => {
    document.body.innerHTML =
      '<button>Save</button><button id="old">Old target</button>'
    expect(
      resolveGuideTarget(document, {
        role: 'button',
        name: 'Save',
        locators: [{ strategy: 'css', value: '#old', exact: true }],
      }).element?.textContent,
    ).toBe('Save')
  })
  it('uses a unique fallback when semantic matches are ambiguous', () => {
    document.body.innerHTML =
      '<button id="one">Save</button><button>Save</button>'
    expect(
      resolveGuideTarget(document, {
        role: 'button',
        name: 'Save',
        locators: [{ strategy: 'css', value: '#one', exact: true }],
      }).element?.id,
    ).toBe('one')
    expect(
      resolveGuideTarget(document, { role: 'button', name: 'Save' }).reason,
    ).toBe('ambiguous')
  })
  it('supports CSS children, quoted spaces/commas and open-shadow descendants', () => {
    document.body.innerHTML = '<div id="host"></div>'
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' })
    root.innerHTML =
      '<div data-label="a, b"><button id="inside">Apply</button></div>'
    expect(
      guideCss(document, '#host > [data-label="a, b"] > button')[0]?.id,
    ).toBe('inside')
    expect(
      resolveGuideTarget(document, {
        shadowPath: ['#host'],
        role: 'button',
        name: 'Apply',
      }).element?.id,
    ).toBe('inside')
    expect(
      resolveGuideTarget(document, { shadowPath: ['#missing'], role: 'button' })
        .reason,
    ).toBe('missing')
  })
  it('supports safe XPath and semantic labels without typed values or editable text', () => {
    document.body.innerHTML =
      '<label for="private">Password</label><input id="private" type="password"><textarea id="note">PRIVATE_TYPED</textarea><div contenteditable="true">PRIVATE_EDITED</div>'
    const input = document.getElementById('private')!
    Object.defineProperty(input, 'value', {
      get() {
        throw new Error('Value read')
      },
    })
    Object.defineProperty(document.getElementById('note')!, 'textContent', {
      get() {
        throw new Error('Editable text read')
      },
    })
    expect(
      resolveGuideTarget(document, {
        locators: [{ strategy: 'label', value: 'Password', exact: true }],
      }).element,
    ).toBe(input)
    expect(
      resolveGuideTarget(document, {
        locators: [
          { strategy: 'xpath', value: '//input[@id="private"]', exact: true },
        ],
      }).element,
    ).toBe(input)
    expect(
      resolveGuideTarget(document, {
        locators: [
          {
            strategy: 'xpath',
            value: '//textarea[contains(.,"PRIVATE_TYPED")]',
            exact: true,
          },
        ],
      }).reason,
    ).toBe('missing')
    expect(
      resolveGuideTarget(document, {
        locators: [{ strategy: 'text', value: 'PRIVATE_EDITED', exact: true }],
      }).reason,
    ).toBe('missing')
  })
  it('preserves CSS hex escapes through shadow boundaries and local :scope', () => {
    document.body.innerHTML = '<div id="123"></div>'
    const root = document.getElementById('123')!.attachShadow({ mode: 'open' })
    root.innerHTML =
      '<section><button id="go">Go</button></section><div id="nested"></div>'
    root.getElementById('nested')!.attachShadow({ mode: 'open' }).innerHTML =
      '<button>Other</button>'
    expect(guideCss(document, '#\\31 23 #go')[0]?.id).toBe('go')
    expect(guideCss(document, '#\\31 23\n#go')[0]?.id).toBe('go')
    expect(guideCss(root, ':scope > button')).toHaveLength(0)
  })
  it('ignores hidden elements, zero rectangles and owned UI', () => {
    document.body.innerHTML =
      '<button hidden>Save</button><button id="owned">Save</button>'
    ownCaptureUi(document.getElementById('owned')!)
    expect(
      resolveGuideTarget(document, { role: 'button', name: 'Save' }).reason,
    ).toBe('missing')
    document.body.innerHTML = '<button>Save</button>'
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      toJSON() {},
    })
    expect(
      resolveGuideTarget(document, { role: 'button', name: 'Save' }).reason,
    ).toBe('missing')
  })
  it('continues after invalid selectors and fails closed at resource limits', () => {
    document.body.innerHTML = '<button id="save">Save</button>'
    expect(
      resolveGuideTarget(document, {
        locators: [
          { strategy: 'css', value: '[broken', exact: true },
          { strategy: 'testId', value: 'missing', exact: true },
          { strategy: 'css', value: '#save', exact: true },
        ],
      }).element?.id,
    ).toBe('save')
    expect(
      resolveGuideTarget(document, {
        locators: Array.from({ length: 101 }, () => ({
          strategy: 'css' as const,
          value: '#save',
          exact: true,
        })),
      }).reason,
    ).toBe('matched')
    vi.spyOn(document, 'querySelectorAll').mockReturnValue(
      Array.from({ length: 12_001 }, () =>
        document.createElement('div'),
      ) as unknown as NodeListOf<Element>,
    )
    expect(resolveGuideTarget(document, { role: 'button' }).reason).toBe(
      'unavailable',
    )
  })
})

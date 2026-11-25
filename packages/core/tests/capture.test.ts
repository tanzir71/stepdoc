// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureTarget,
  captureStep,
  captureUrl,
  navigationStep,
  observePage,
  guessExpectation,
  fieldMasks,
  CaptureMetadataError,
} from '../src/capture'
import { stepSchema } from '@stepdoc/schema'

beforeEach(() => {
  document.body.innerHTML = ''
  history.replaceState(null, '', '/fixture?private=discard#fragment')
})
afterEach(() => vi.restoreAllMocks())
function target(html: string, selector: string) {
  document.body.innerHTML = html
  return document.querySelector(selector)!
}
function rect(element: Element, x = 10) {
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({
    x,
    y: 20,
    width: 150,
    height: 32,
    top: 20,
    left: x,
    bottom: 52,
    right: x + 150,
    toJSON: () => ({}),
  })
}
describe('privacy-safe DOM capture', () => {
  it('covers opaque custom hosts that may contain closed-shadow form fields', () => {
    const host = target('<opaque-host></opaque-host>', 'opaque-host')
    host.attachShadow({ mode: 'closed' }).innerHTML =
      '<input value="PRIVATE_CLOSED_VALUE">'
    rect(host)
    expect(fieldMasks(document)).toEqual([
      { x: 10, y: 20, width: 150, height: 32 },
    ])
  })
  it('aborts bounded mask traversal instead of retaining incomplete privacy geometry', () => {
    document.body.innerHTML = '<span></span>'.repeat(12_001)
    expect(() => fieldMasks(document)).toThrow(
      'Capture metadata unavailable: dom_limit',
    )
  })
  it.each([
    ['<button>Save</button>', 'button', 'button', 'Save'],
    ['<a href="/next?token=never">Continue</a>', 'a', 'link', 'Continue'],
    [
      '<label for="email">Invoice email</label><input id="email" type="email">',
      'input',
      'textbox',
      'Invoice email',
    ],
    [
      '<label>Project <input placeholder="Project name"></label>',
      'input',
      'textbox',
      'Project',
    ],
    [
      '<span id="label">Workspace title</span><div role="textbox" aria-labelledby="label" contenteditable>Never store this typed text</div>',
      '[role=textbox]',
      'textbox',
      'Workspace title',
    ],
    [
      '<span role="switch" aria-label="Alerts">Ignored content</span>',
      'span',
      'switch',
      'Alerts',
    ],
    [
      '<button><span>Save</span><span hidden>Hidden</span></button>',
      'button',
      'button',
      'Save',
    ],
  ])(
    'captures names and implicit/explicit roles for %s',
    (html, selector, role, name) => {
      const element = target(html, selector)
      const captured = captureTarget(element)
      expect(captured).toMatchObject({
        role,
        name,
        tag: element.localName,
        frame: [],
        shadowPath: [],
      })
      expect(captured.locators?.[0]).toMatchObject({
        strategy: 'role',
        value: role,
        name,
        unique: true,
      })
    },
  )
  it('measures CSS uniqueness and promotes a unique fallback over ambiguous semantics', () => {
    const element = target(
      '<button>Save</button><button id="save">Save</button>',
      '#save',
    )
    const query = vi.spyOn(document, 'querySelectorAll')
    const result = captureTarget(element)
    expect(result.locators?.[0]).toMatchObject({
      strategy: 'css',
      value: '#save',
      unique: true,
    })
    expect(result.locators).toContainEqual({
      strategy: 'role',
      value: 'button',
      name: 'Save',
      exact: true,
      unique: false,
    })
    expect(query).toHaveBeenCalledWith('#save')
  })
  it('uses test ID, labels, placeholders, alt and title without recording value attributes', () => {
    const element = target(
      '<label for="field">Project</label><input id="field" data-testid="project" placeholder="Project title" title="Name the project" value="TYPED_PRIVATE">',
      'input',
    )
    const result = captureTarget(element)
    expect(result.locators?.map((item) => item.strategy)).toEqual([
      'role',
      'testId',
      'label',
      'placeholder',
      'title',
      'css',
    ])
    const image = target(
      '<img alt="Documentation diagram" title="Guide diagram">',
      'img',
    )
    expect(
      captureTarget(image).locators?.map((item) => item.strategy),
    ).toContain('altText')
    expect(JSON.stringify(result)).not.toContain('TYPED_PRIVATE')
  })
  it.each(['text', 'password', 'email', 'number', 'range', 'file'])(
    'never reads original %s .value, including embedded controls',
    (type) => {
      const element = target(
        `<label>Amount <input id="field" type="${type}"><input aria-label="Embedded" value="PRIVATE" type="text"></label><button aria-labelledby="field">Go</button>`,
        '#field',
      )
      for (const input of document.querySelectorAll('input')) {
        Object.defineProperty(input, 'value', {
          get: () => {
            throw new Error('Original value getter read')
          },
          configurable: true,
        })
      }
      const result = captureStep(element, type === 'file' ? 'upload' : 'fill', {
        id: 'captured',
        index: 3,
      })
      expect(result.value).toEqual({
        kind: ['password', 'email'].includes(type) ? 'secret' : 'variable',
        variable: 'field_3',
      })
      expect(result.target?.name).toBe('Amount')
      expect(() =>
        captureTarget(document.querySelector('button')!),
      ).not.toThrow()
      expect(stepSchema.safeParse(result).success).toBe(true)
    },
  )
  it.each(['cc-number', 'cc-csc', 'new-password', 'email', 'payment'])(
    'classifies autocomplete=%s as secret',
    (autocomplete) => {
      const element = target(
        `<input aria-label="Payment" autocomplete="${autocomplete}">`,
        'input',
      )
      expect(
        captureStep(element, 'fill', { id: 'fill', index: 1 }).value?.kind,
      ).toBe('secret')
    },
  )
  it('omits editable descendants from ancestor names and supports textarea labels', () => {
    const button = target(
      '<button>Send <span contenteditable>PRIVATE_TYPED_TEXT</span></button><label for="message">Message</label><textarea id="message">PRIVATE_DEFAULT</textarea>',
      'button',
    )
    const editable = document.querySelector('[contenteditable]')!
    Object.defineProperty(editable, 'textContent', {
      get: () => {
        throw new Error('Editable text read')
      },
    })
    const textarea = document.querySelector('textarea')!
    Object.defineProperty(textarea, 'value', {
      get: () => {
        throw new Error('Textarea value read')
      },
    })
    expect(captureTarget(button).name).toBe('Send')
    expect(
      captureStep(textarea, 'fill', { id: 'fill', index: 1 }).target?.name,
    ).toBe('Message')
  })
  it('stores only permitted select labels and key names', () => {
    const select = target(
      '<label>Plan <select><option value="backend-id" selected>Team plan</option></select></label>',
      'select',
    )
    Object.defineProperty(select, 'value', {
      get: () => {
        throw new Error('Select value read')
      },
    })
    expect(
      captureStep(select, 'select', { id: 'select', index: 1 }).value,
    ).toEqual({ kind: 'literal', literal: 'Team plan' })
    const enter = captureStep(select, 'press', {
      id: 'press',
      index: 2,
      key: 'Enter',
    })
    expect(enter.key).toBe('Enter')
    expect(enter.value).toBeUndefined()
  })
  it('records scoped open-shadow locators and same-origin frame chains', () => {
    const host = target('<div id="outer"></div>', '#outer')
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<div id="inner"></div>'
    const inner = shadow.querySelector('#inner')!.attachShadow({ mode: 'open' })
    inner.innerHTML = '<button id="save">Save inside</button>'
    expect(captureTarget(inner.querySelector('button')!)).toMatchObject({
      shadowPath: ['#outer', '#inner'],
      name: 'Save inside',
      locators: expect.arrayContaining([
        expect.objectContaining({ strategy: 'role', unique: true }),
      ]),
    })
    const frame = document.createElement('iframe')
    frame.id = 'frame'
    document.body.append(frame)
    frame.contentDocument!.body.innerHTML = '<button>Frame button</button>'
    expect(
      captureTarget(frame.contentDocument!.querySelector('button')!).frame,
    ).toEqual(['#frame'])
    expect(observePage(frame.contentDocument!).url).toBe(
      `${location.origin}/fixture`,
    )
  })
  it('strips credentials, queries and fragments and rejects non-web URLs', () => {
    expect(
      captureUrl(
        'https://user:private@example.test/path?token=PRIVATE#PRIVATE',
      ),
    ).toBe('https://example.test/path')
    expect(
      navigationStep('https://example.test/next?private=discard', 'nav', 1),
    ).toMatchObject({
      url: 'https://example.test/next',
      expect: { urlMatches: 'https://example.test/next' },
    })
    for (const url of ['javascript:alert(1)', 'file:///private', 'not a URL'])
      expect(() => captureUrl(url)).toThrow('invalid_url')
  })
  it('never puts detected secrets into labels/locators or generated text', () => {
    const element = target('<button>Send alice@example.test</button>', 'button')
    const result = captureStep(element, 'click', { id: 'click', index: 1 })
    expect(JSON.stringify(result)).not.toContain('alice@example.test')
    expect(result.target?.name).toBe('Send [REDACTED]')
    expect(
      result.target?.locators?.some((item) => item.strategy === 'role'),
    ).toBe(false)
  })
  it('guesses new visible dialogs/headings and SPA navigation without query metadata', () => {
    document.body.innerHTML = '<h1>Dashboard</h1><h2 hidden>Next step</h2>'
    const before = observePage(document)
    document.querySelector('h2')!.removeAttribute('hidden')
    expect(guessExpectation(before, observePage(document))).toEqual({
      visible: { role: 'heading', name: 'Next step' },
    })
    document.body.insertAdjacentHTML(
      'beforeend',
      '<div role="dialog" aria-label="Confirm change"></div>',
    )
    expect(guessExpectation(before, observePage(document))).toEqual({
      visible: { role: 'dialog', name: 'Confirm change' },
    })
    history.pushState(null, '', '/next?secret=discard#discard')
    expect(guessExpectation(before, observePage(document))).toEqual({
      urlMatches: `${location.origin}/next`,
    })
  })
  it('masks ordinary fields, contenteditable, open shadows and every frame without reading values', () => {
    document.body.innerHTML =
      '<input><input type="checkbox"><textarea></textarea><div contenteditable>PRIVATE</div><div id="host"></div><iframe></iframe>'
    document.querySelector('#host')!.attachShadow({ mode: 'open' }).innerHTML =
      '<input type="password">'
    for (const element of [
      ...document.querySelectorAll('*'),
      document.querySelector('#host')!.shadowRoot!.querySelector('input')!,
    ])
      rect(element)
    for (const element of document.querySelectorAll(
      'input,textarea,[contenteditable]',
    ))
      Object.defineProperty(element, 'value', {
        get: () => {
          throw new Error('Value read')
        },
      })
    expect(fieldMasks(document)).toHaveLength(5)
  })
  it('fails closed with data-free errors on limits, geometry and DOM failures', () => {
    const button = target('<button>Save</button>', 'button')
    button.setAttribute('aria-label', 'PRIVATE'.repeat(100))
    expect(() => captureTarget(button)).toThrow('metadata_limit')
    button.removeAttribute('aria-label')
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      x: NaN,
    } as DOMRect)
    expect(() => captureTarget(button)).toThrow(CaptureMetadataError)
    vi.restoreAllMocks()
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
      throw new Error('PRIVATE_DOM_ERROR')
    })
    expect(() => captureTarget(button)).toThrow(
      'Capture metadata unavailable: dom_failure',
    )
  })
})

import { describe, expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { guideSchema, type GuideInput } from '@stepdoc/schema'
import minimal from '../../../schema/tests/fixtures/minimal.json'
import complete from '../../../schema/tests/fixtures/complete.json'
import {
  exportGuideJson,
  exportHtml,
  exportJsonLd,
  exportMarkdown,
  exportPlaywright,
  exportSkill,
  GuideExportError,
} from '../../src/export'

const guide = guideSchema.parse(complete)
const options = {
  canonicalUrl: 'https://docs.example.com/billing/change-plan/',
}
const exporters = {
  json: exportGuideJson,
  html: exportHtml,
  jsonLd: exportJsonLd,
  markdown: exportMarkdown,
  playwright: exportPlaywright,
  skill: exportSkill,
}

describe('guide@1 export snapshots', () => {
  for (const [name, render] of Object.entries(exporters)) {
    it(`${name}: complete guide`, () =>
      expect(render(guide, options)).toMatchSnapshot())
    it(`${name}: minimal guide`, () =>
      expect(render(guideSchema.parse(minimal))).toMatchSnapshot())
  }
})

describe('shared export contract', () => {
  it('exports validated copies, orders/renumbers steps and never mutates input', () => {
    const input = structuredClone(guide)
    input.steps.reverse()
    for (const step of input.steps) step.index *= 2
    const before = structuredClone(input)
    const output = guideSchema.parse(JSON.parse(exportGuideJson(input)))
    expect(input).toEqual(before)
    expect(output.steps.map((step) => step.id)).toEqual(
      guide.steps.map((step) => step.id),
    )
    expect(output.steps.map((step) => step.index)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ])
    expect(output.steps[0]!.screenshot).toMatchObject({
      rendered: 'img/step-1.webp',
    })
    expect(output.steps[0]!.screenshot).not.toHaveProperty('original')
  })
  it('strips credentials, query secrets and fragments in every format', () => {
    const input = structuredClone(guide)
    input.app!.origin =
      'https://owner:private-password@example.com/?api=private-query#private-fragment'
    input.steps[0]!.url =
      'https://owner:private-password@example.com/settings?api=private-query#private-fragment'
    input.steps[0]!.expect!.urlMatches =
      'https://owner:private-password@example.com/settings?api=private-query#private-fragment'
    const config = {
      canonicalUrl:
        'https://owner:private-password@docs.example.com/guide/?api=private-query#private-fragment',
    }
    for (const render of Object.values(exporters)) {
      const output = render(input, config)
      expect(output).not.toMatch(
        /private-password|private-query|private-fragment|owner:/,
      )
      expect(output).not.toContain('original.webp')
    }
  })
  it.each([
    '/settings?api=private-query#private-fragment',
    '^https://example\\.com/settings\\?api=private-query#private-fragment',
    '^https://example\\.com/settings[?]api=private-query',
  ])('strips query tails from prefix/regex expectations: %s', (pattern) => {
    const input = structuredClone(guide)
    input.steps[0]!.expect!.urlMatches = pattern
    expect(exportGuideJson(input)).not.toMatch(/private-query|private-fragment/)
  })
  it('resolves relative capture URLs and rejects executable navigation', () => {
    const input = structuredClone(guide)
    input.steps[0]!.url = '/settings?token=private-query'
    input.steps[6]!.url = 'javascript:alert(1)'
    const output = guideSchema.parse(JSON.parse(exportGuideJson(input)))
    expect(output.steps[0]!.url).toBe('https://example.com/settings')
    expect(output.steps[6]!.url).toBeNull()
    expect(exportPlaywright(input)).not.toContain('alert(1)')
  })
  it('maps only flattened images, including portable embedded raster data', () => {
    const image =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    for (const path of ['images/plan.png', image]) {
      const config = { images: { 'open-plan': path } }
      expect(
        JSON.parse(exportGuideJson(guide, config)).steps[0].screenshot.rendered,
      ).toBe(path)
      expect(
        new JSDOM(exportHtml(guide, config)).window.document
          .querySelector('img')!
          .getAttribute('src'),
      ).toBe(path)
    }
  })
  it('does not use inherited image map keys and handles punctuation in Markdown assets', () => {
    const input = structuredClone(guide)
    input.steps[0]!.id = '__proto__'
    expect(
      JSON.parse(exportGuideJson(input, { images: {} })).steps[0].screenshot
        .rendered,
    ).toBe('img/step-1.webp')
    expect(
      exportMarkdown(guide, { images: { 'open-plan': 'img/plan(v2).webp' } }),
    ).toContain('](<img/plan(v2).webp>)')
  })
  it.each([
    '[invalid',
    '//owner:private@example.com',
    '^https:\\/\\/owner:private@example.com',
  ])('rejects invalid or credential-bearing URL regexes: %s', (pattern) => {
    const input = structuredClone(guide)
    input.steps[0]!.expect!.urlMatches = pattern
    expect(() => exportGuideJson(input)).toThrow(GuideExportError)
  })
  it('rejects undeclared variables and invalid screenshot geometry', () => {
    const input = structuredClone(guide)
    input.variables = []
    expect(() => exportGuideJson(input)).toThrow(GuideExportError)
    const image = structuredClone(guide)
    image.steps[0]!.screenshot!.width = 0
    expect(() => exportGuideJson(image)).toThrow(GuideExportError)
  })
  it.each([
    'https://example.com/raw.webp?token=private',
    '//example.com/img.webp',
    '../raw.webp',
    'image.svg',
    'data:image/svg+xml;base64,abc',
    'img/%2e%2e/raw.webp',
    'img\\raw.webp',
    'img/a b.webp',
    'img/a.webp#token',
  ])('rejects unsafe image references: %s', (path) => {
    expect(() => exportHtml(guide, { images: { 'open-plan': path } })).toThrow(
      GuideExportError,
    )
  })
  it.each(['javascript:alert(1)', 'file:///tmp/guide', '//private.example/'])(
    'rejects non-HTTP canonical URLs: %s',
    (canonicalUrl) => {
      expect(() => exportHtml(guide, { canonicalUrl })).toThrow(
        GuideExportError,
      )
    },
  )
  it('rejects ambiguous guide identity/variable declarations', () => {
    const inputs = [
      structuredClone(guide),
      structuredClone(guide),
      structuredClone(guide),
      structuredClone(guide),
    ]
    inputs[0]!.steps[1]!.id = inputs[0]!.steps[0]!.id
    inputs[1]!.steps[1]!.index = inputs[1]!.steps[0]!.index
    inputs[2]!.variables.push(inputs[2]!.variables[0]!)
    inputs[3]!.variables[0]!.kind = 'variable'
    for (const input of inputs)
      expect(() => exportGuideJson(input)).toThrow(GuideExportError)
  })
  it('rejects invalid data without returning raw validation issues or causes', () => {
    const input = structuredClone(guide) as unknown as Record<string, unknown>
    input['private-field'] = 'private-value'
    for (const render of Object.values(exporters)) {
      try {
        render(input as unknown as GuideInput)
        throw new Error('Missing rejection')
      } catch (error) {
        expect(error).toBeInstanceOf(GuideExportError)
        expect(String(error) + JSON.stringify(error)).not.toMatch(
          /private-field|private-value/,
        )
        expect(error).not.toHaveProperty('cause')
      }
    }
  })
  it('rejects stored fill literals and secret examples in all exporters', () => {
    const input = structuredClone(guide)
    for (const invalid of [
      {
        ...input,
        steps: [
          {
            ...input.steps[1],
            value: { kind: 'literal', literal: 'private-typed-value' },
          },
        ],
      },
      {
        ...input,
        variables: [{ ...input.variables[0], example: 'private-typed-value' }],
      },
    ])
      for (const render of Object.values(exporters))
        expect(() => render(invalid as GuideInput)).toThrow(GuideExportError)
  })
})

describe('semantic and injection-safe documents', () => {
  it('provides landmarks, format alternates, ordered stable steps, target alt text and valid HowTo', () => {
    const document = new JSDOM(exportHtml(guide, options)).window.document
    expect(document.querySelectorAll('h1')).toHaveLength(1)
    for (const landmark of [
      'body>header',
      'nav[aria-label]',
      'main',
      'aside[aria-label]',
      'body>footer',
    ])
      expect(document.querySelector(landmark)).not.toBeNull()
    const steps = document.querySelectorAll('ol>li[data-sd-step]')
    expect(steps).toHaveLength(8)
    for (const [index, step] of [...steps].entries()) {
      expect(step.id).toBe(`step-${index + 1}`)
      expect(step.getAttribute('data-sd-step')).toBe(String(index + 1))
      expect(step.querySelector('h2')).not.toBeNull()
    }
    expect(document.querySelector('figure>img')!.getAttribute('alt')).toBe(
      'The Change plan button',
    )
    expect(document.querySelector('img')!.hasAttribute('loading')).toBe(false)
    for (const [type, href] of [
      ['application/json', 'guide.json'],
      ['text/markdown', 'guide.md'],
    ])
      expect(
        document
          .querySelector(`link[rel="alternate"][type="${type}"]`)!
          .getAttribute('href'),
      ).toBe(href)
    const data = JSON.parse(
      document.querySelector('script[type="application/ld+json"]')!
        .textContent!,
    )
    expect(data).toEqual(JSON.parse(exportJsonLd(guide, options)))
    expect(data).toMatchObject({
      '@type': 'HowTo',
      dateModified: guide.updatedAt,
    })
    expect(data.step[0]).toMatchObject({
      '@type': 'HowToStep',
      url: `${options.canonicalUrl}#step-1`,
      image: `${options.canonicalUrl}img/step-1.webp`,
    })
  })
  it('uses target-derived image alt when no custom alt is supplied', () => {
    const input = structuredClone(guide)
    delete input.steps[0]!.screenshot!.alt
    expect(
      new JSDOM(exportHtml(input)).window.document.querySelector('img')!.alt,
    ).toBe('The Change plan button')
  })
  it('keeps raw HTML/code/Markdown injection as text', () => {
    const hostile =
      '</script><img src=x onerror="alert(1)"> [link](javascript:alert(1))\n# heading `code` *italics*'
    const input = structuredClone(guide)
    input.title = hostile
    input.description = hostile
    input.steps[0]!.title = hostile
    input.steps[0]!.description = hostile
    input.steps[0]!.target!.name = hostile
    const document = new JSDOM(exportHtml(input)).window.document
    expect(document.querySelectorAll('img')).toHaveLength(1)
    expect(document.querySelector('[onerror]')).toBeNull()
    expect(document.querySelector('h1')!.textContent).toBe(hostile)
    expect(
      JSON.parse(
        document.querySelector('script[type="application/ld+json"]')!
          .textContent!,
      ).name,
    ).toBe(hostile)
    for (const render of [exportMarkdown, exportSkill]) {
      const output = render(input).replace(/^---[\s\S]*?\n---\n/, '')
      expect(output).not.toMatch(/(?<!\\)<img\s/)
      expect(output).not.toContain('\n# heading')
      expect(output).not.toContain('[link](javascript:')
    }
    expect(exportPlaywright(input)).toContain('\\u003c/script>')
  })
  it('defaults to light; dark is explicit and never follows the system silently', () => {
    expect(exportHtml(guide)).toContain('data-theme="light"')
    expect(exportHtml(guide, { theme: 'dark' })).toContain('data-theme="dark"')
    expect(exportHtml(guide)).not.toMatch(
      /prefers-color-scheme|font-style:italic|box-shadow/,
    )
  })
})

describe('replay and skill contract', () => {
  it('prefers role/name before test ID and structural fallbacks, with explicit frame/shadow scoping', () => {
    const output = exportPlaywright(guide)
    const line = output
      .split('\n')
      .find((line) => line.includes('const target ='))!
    expect(line.indexOf('getByRole')).toBeLessThan(line.indexOf('getByTestId'))
    expect(line.indexOf('getByTestId')).toBeLessThan(
      line.indexOf('.locator("#change-plan")'),
    )
    expect(line).toContain(
      'page.frameLocator("iframe#settings").locator("plan-card")',
    )
    expect(output).toContain('candidate.count() === 1')
    expect(output).not.toContain('.first()')
  })
  it('reads variables and secrets only at runtime, with no stored example fallback', () => {
    const input = structuredClone(guide)
    input.variables[1]!.example = 'should-not-export-example'
    const output = exportPlaywright(input)
    expect(output).toContain('process.env[name]')
    expect(output).toContain(
      'target.fill(readVariable("STEPDOC_BILLING_EMAIL"))',
    )
    expect(output).not.toMatch(
      /should-not-export-example|\|\|\s*"5"|\?\?\s*"5"/,
    )
    expect(output).toContain("trace: 'off', screenshot: 'off', video: 'off'")
    expect(output).not.toContain('throw error')
  })
  it('does not report manual or underspecified steps as successful replay', () => {
    const input = guideSchema.parse(minimal)
    expect(exportPlaywright(input)).toContain(
      'not replayable: manual instruction',
    )
    input.steps[0]!.type = 'assert'
    expect(exportPlaywright(input)).toContain(
      'not replayable: assertion is missing',
    )
    input.steps[0]!.type = 'action'
    input.steps[0]!.action = 'click'
    expect(exportPlaywright(input)).toContain(
      'not replayable: target locator is missing',
    )
    input.steps[0]!.type = 'section'
    delete input.steps[0]!.action
    expect(exportPlaywright(input)).toContain(
      'not replayable: no actionable steps',
    )
  })
  it('contains purpose, preconditions, variables, numbered targets and expectations in SKILL.md', () => {
    const output = exportSkill(guide)
    for (const section of [
      '## Purpose',
      '## Preconditions',
      '## Variables',
      '## Steps',
    ])
      expect(output).toContain(section)
    expect(output).toContain('STEPDOC_BILLING_EMAIL')
    expect(output).toContain('1. Click Change plan')
    expect(output).toContain('Target: button')
    expect(output).toContain('Expected: URL matches /settings')
    expect(output).not.toContain('![ img')
  })
})

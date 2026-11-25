import { describe, expect, it } from 'vitest'
import { onboardingSession } from '../../../apps/web/e2e/fixtures/session'
import { migrateV1ToGuide1, type V1Guide } from '../src'
import { validateJsonGuide } from './validation'

const createdAt = '2026-11-25T10:00:00.000Z'
const guideId = '123e4567-e89b-42d3-a456-426614174000'
const publicId = '123e4567-e89b-42d3-a456-426614174001'

// Match createGuide's row mapping using the same input as the v1 browser suite.
function persistedFixture(count = 3): V1Guide {
  const session = onboardingSession(count)
  return {
    id: guideId,
    title: session.title,
    description: session.description,
    source_url: session.sourceUrl,
    is_public: false,
    public_id: publicId,
    created_at: createdAt,
    updated_at: createdAt,
    steps: session.steps.map((step, index) => ({
      id: `123e4567-e89b-42d3-a456-${String(index + 2).padStart(12, '0')}`,
      guide_id: guideId,
      position: step.position,
      type: step.type,
      text: step.text,
      page_url: null,
      screenshot_path: null,
      rendered_path: null,
      click: null,
      element_meta: null,
      edits: { blur: [], crop: null, annotations: [] },
      created_at: createdAt,
    })),
  }
}

function captureFixture(): V1Guide {
  const source = persistedFixture(6)
  const meta = {
    event: 'click' as const,
    tag: 'button',
    url: 'https://example.com/settings?token=discard-me#secret',
    label: 'Save',
    selector: '#save',
    lowConfidence: false,
  }
  source.steps[0]!.element_meta = {
    ...meta,
    rect: { x: 5, y: 10, width: 80, height: 30 },
  }
  source.steps[0]!.click = { x: 25, y: 30, radius: 24 }
  source.steps[0]!.text = 'Click "Save"'
  source.steps[1]!.element_meta = {
    ...meta,
    event: 'input',
    tag: 'input',
    label: 'Billing email',
    inputType: 'email',
    name: 'email',
    selector: '#email',
  }
  source.steps[1]!.text = 'Fill in the "Billing email" field'
  source.steps[2]!.element_meta = {
    ...meta,
    event: 'input',
    tag: 'input',
    label: 'Seats',
    inputType: 'number',
    name: 'seats',
    selector: '#seats',
  }
  source.steps[2]!.text = 'Fill in the "Seats" field'
  source.steps[3]!.element_meta = {
    ...meta,
    event: 'select',
    tag: 'select',
    label: 'Plan',
    optionLabel: 'Team',
    selector: '#plan',
  }
  source.steps[3]!.text = 'Select "Team" from the "Plan" dropdown'
  source.steps[4]!.element_meta = { ...meta, event: 'submit', tag: 'form' }
  source.steps[4]!.text = 'Press Enter to submit'
  source.steps[5]!.type = 'navigate'
  source.steps[5]!.page_url =
    'https://name:password@example.com/done?code=discard-me#secret'
  source.steps[5]!.text = 'Go to example.com/done'
  return source
}

describe('v1 → guide@1 migration', () => {
  it.each([1, 2, 3, 10, 30, 50])(
    'migrates the actual %i-step Playwright input shape',
    (count) => {
      const source = persistedFixture(count)
      const original = structuredClone(source)
      const guide = migrateV1ToGuide1(source)
      expect(
        validateJsonGuide(guide),
        JSON.stringify(validateJsonGuide.errors),
      ).toBe(true)
      expect(guide.steps).toHaveLength(count)
      expect(guide.steps.map((step) => step.title)).toEqual(
        source.steps.map((step) => step.text),
      )
      expect(guide.steps.map((step) => step.index)).toEqual(
        Array.from({ length: count }, (_, i) => i + 1),
      )
      expect(guide).toMatchObject({
        schema: 'stepdoc/guide@1',
        id: guideId,
        uuid: guideId,
        title: source.title,
        description: source.description,
        createdAt,
        updatedAt: createdAt,
        capturedAt: createdAt,
        version: 1,
        status: 'draft',
        app: { origin: 'https://example.com' },
        publish: { publicId, isPublic: false, targets: [] },
        verification: { status: 'never-run' },
      })
      expect(source).toEqual(original)
      expect(migrateV1ToGuide1(source)).toEqual(guide)
    },
  )

  it('sorts persisted positions, retains stable IDs and renumbers from one', () => {
    const source = persistedFixture()
    const expected = source.steps.map((step) => step.id)
    source.steps.reverse()
    expect(migrateV1ToGuide1(source).steps.map((step) => step.id)).toEqual(
      expected,
    )
  })

  it('maps targets, fill references, select literals, key names and navigation', () => {
    const source = captureFixture()
    const guide = migrateV1ToGuide1(source)
    expect(
      validateJsonGuide(guide),
      JSON.stringify(validateJsonGuide.errors),
    ).toBe(true)
    expect(guide.steps.map((step) => step.action)).toEqual([
      'click',
      'fill',
      'fill',
      'select',
      'press',
      'navigate',
    ])
    expect(guide.steps[0]).toMatchObject({
      title: 'Click "Save"',
      click: { x: 25, y: 30, radius: 24 },
      url: 'https://example.com/settings',
      target: {
        role: 'button',
        name: 'Save',
        tag: 'button',
        rect: { x: 5, y: 10, width: 80, height: 30 },
        locators: [
          { strategy: 'role', value: 'button', name: 'Save', exact: true },
          { strategy: 'label', value: 'Save', exact: true },
          { strategy: 'css', value: '#save', exact: true },
        ],
      },
    })
    expect(
      guide.steps[0]?.target?.locators?.every(
        (locator) => locator.unique === undefined,
      ),
    ).toBe(true)
    expect(guide.steps[1]?.value).toEqual({
      kind: 'secret',
      variable: 'field_2',
    })
    expect(guide.steps[2]?.value).toEqual({
      kind: 'variable',
      variable: 'field_3',
    })
    expect(guide.variables).toMatchObject([
      { name: 'field_2', kind: 'secret' },
      { name: 'field_3', kind: 'variable' },
    ])
    expect(guide.steps[3]?.value).toEqual({ kind: 'literal', literal: 'Team' })
    expect(guide.steps[4]?.key).toBe('Enter')
    expect(guide.steps[5]?.url).toBe('https://example.com/done')
    expect(JSON.stringify(guide)).not.toMatch(/discard-me|name:password/)
  })

  it.each(['password', 'email'])(
    'migrates %s fields to secret references',
    (inputType) => {
      const source = captureFixture()
      source.steps[1]!.element_meta = {
        event: 'input',
        tag: 'input',
        url: 'https://example.com',
        inputType,
      }
      expect(migrateV1ToGuide1(source).steps[1]?.value?.kind).toBe('secret')
    },
  )

  it('never reads .value or forwards unknown legacy fields and signed URLs', () => {
    const source = captureFixture()
    const secret = 'private-typed-content'
    for (const object of [
      source,
      source.steps[1]!,
      source.steps[1]!.element_meta!,
    ]) {
      Object.defineProperty(object, 'value', {
        enumerable: true,
        get() {
          throw new Error('Typed value was read')
        },
      })
    }
    Object.assign(source.steps[1]!, {
      imageUrl: `https://example.com/signed?token=${secret}`,
    })
    const guide = migrateV1ToGuide1(source)
    expect(JSON.stringify(guide)).not.toContain(secret)
    expect(JSON.stringify(guide)).not.toContain('imageUrl')
  })

  it('drops a value-attribute selector and input innerText', () => {
    const source = captureFixture()
    source.steps[1]!.element_meta = {
      event: 'input',
      tag: 'input',
      inputType: 'email',
      url: 'https://example.com',
      innerText: 'private-typed-content',
      selector: 'input[value="private-typed-content"]',
    }
    expect(JSON.stringify(migrateV1ToGuide1(source))).not.toContain(
      'private-typed-content',
    )
  })

  it('preserves the v1 manual image, click, blur, crop and annotation layers', () => {
    const source = persistedFixture(1)
    const step = source.steps[0]!
    step.type = 'manual'
    step.screenshot_path = 'guides/test/step/original.webp'
    step.rendered_path = 'guides/test/step/rendered.webp'
    step.click = { x: 4, y: 5, radius: 24 }
    step.edits = {
      blur: [{ x: 5, y: 5, width: 20, height: 20 }],
      crop: { x: 0, y: 0, width: 40, height: 30 },
      annotations: [
        { type: 'text', x: 6, y: 24, text: 'Note', color: '#ef4444' },
      ],
    }
    const guide = migrateV1ToGuide1(source, {
      screenshots: {
        [step.id]: { width: 40, height: 30, devicePixelRatio: 2 },
      },
    })
    expect(guide.steps[0]).toMatchObject({
      id: step.id,
      click: step.click,
      edits: { crop: step.edits.crop, annotations: step.edits.annotations },
      screenshot: {
        original: step.screenshot_path,
        rendered: step.rendered_path,
        width: 40,
        height: 30,
        devicePixelRatio: 2,
      },
      redactions: [
        {
          kind: 'custom',
          source: 'manual',
          status: 'applied',
          rect: step.edits.blur[0],
        },
      ],
    })
    expect(validateJsonGuide(guide)).toBe(true)
    expect(step.edits.blur).toHaveLength(1)
  })

  it('accepts a flattened 1×1 image matching the Playwright upload fixture', () => {
    const source = persistedFixture(1)
    const step = source.steps[0]!
    step.screenshot_path = 'guides/test/original.webp'
    const guide = migrateV1ToGuide1(source, {
      screenshots: { [step.id]: { width: 1, height: 1 } },
    })
    expect(guide.steps[0]?.screenshot).toMatchObject({
      rendered: step.screenshot_path,
      width: 1,
      height: 1,
    })
  })

  it('fails explicitly if real image metadata or a required flattened blob is missing', () => {
    const source = persistedFixture(1)
    const step = source.steps[0]!
    step.screenshot_path = 'original.webp'
    expect(() => migrateV1ToGuide1(source)).toThrow(
      /real screenshot dimensions/,
    )
    expect(() =>
      migrateV1ToGuide1(source, {
        screenshots: { [step.id]: { width: 0, height: 1 } },
      }),
    ).toThrow(/dimensions/)
    step.edits.blur.push({ x: 1, y: 1, width: 1, height: 1 })
    expect(() =>
      migrateV1ToGuide1(source, {
        screenshots: { [step.id]: { width: 1, height: 1 } },
      }),
    ).toThrow(/flattened screenshot/)
  })

  it('retains section/manual types, public identity and custom stable slugs', () => {
    const source = persistedFixture()
    source.steps[0]!.type = 'section'
    source.steps[1]!.type = 'manual'
    source.is_public = true
    const guide = migrateV1ToGuide1(source, { slug: 'browser-onboarding' })
    expect(guide.id).toBe('browser-onboarding')
    expect(guide.steps.map((step) => step.type)).toEqual([
      'section',
      'manual',
      'action',
    ])
    expect(guide.publish).toEqual({
      publicId,
      isPublic: true,
      targets: ['link'],
    })
    expect(guide.status).toBe('published')
  })

  it.each([
    'javascript:private-data',
    'data:text/plain,private-data',
    'invalid-url',
  ])('drops unsafe or malformed page URLs', (url) => {
    const source = persistedFixture(1)
    source.source_url = url
    source.steps[0]!.page_url = url
    const guide = migrateV1ToGuide1(source)
    expect(guide.app).toBeUndefined()
    expect(guide.steps[0]?.url).toBeNull()
  })

  it('rejects malformed guides, cross-guide steps and duplicate identities', () => {
    expect(() => migrateV1ToGuide1({})).toThrow()
    const source = persistedFixture()
    source.steps[0]!.guide_id = publicId
    expect(() => migrateV1ToGuide1(source)).toThrow()
    source.steps[0]!.guide_id = guideId
    source.steps[1]!.id = source.steps[0]!.id
    expect(() => migrateV1ToGuide1(source)).toThrow()
  })
})

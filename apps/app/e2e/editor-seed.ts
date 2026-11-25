import { IndexedDbAdapter } from '@stepdoc/storage'
import { guideSchema, type StepInput } from '@stepdoc/schema'
import { ImageProcessor } from '../src/editor/images'
const titles = [
  'Go to app.ledgerly.io/settings',
  'Click "Billing" in the sidebar',
  'Click "Change plan"',
  'Select "Team — $29 / month" from the Plan dropdown',
  'Click here',
  'Fill in the "Seats" field',
  'Fill in the "Invoice email" field',
  'Click "Save changes"',
  'Check the "Plan updated" message',
]
const steps: StepInput[] = titles.map((title, index) => ({
  id: `editor-step-${index + 1}`,
  index: index + 1,
  title,
  type: index === 0 ? 'navigate' : index === 8 ? 'assert' : 'action',
  action:
    index === 0
      ? 'navigate'
      : index === 3
        ? 'select'
        : index === 5 || index === 6
          ? 'fill'
          : index === 8
            ? 'assert'
            : 'click',
  url: 'https://app.ledgerly.io/settings/billing',
  target: {
    role:
      index === 3
        ? 'combobox'
        : index === 5
          ? 'spinbutton'
          : index === 6
            ? 'textbox'
            : index === 1
              ? 'link'
              : 'button',
    name:
      index === 2
        ? 'Change plan'
        : index === 1
          ? 'Billing'
          : index === 3
            ? 'Plan'
            : index === 5
              ? 'Seats'
              : index === 6
                ? 'Invoice email'
                : index === 7
                  ? 'Save changes'
                  : title,
  },
  ...(index === 3
    ? { value: { kind: 'literal', literal: 'Team — $29 / month' } }
    : index === 5
      ? { value: { kind: 'variable', variable: 'seats' } }
      : index === 6
        ? { value: { kind: 'secret', variable: 'invoice_email' } }
        : {}),
  lowConfidence: index === 4,
}))
steps[2] = {
  ...steps[2]!,
  description:
    'Opens the plan picker. Only workspace owners see this button; members get a "Request upgrade" link instead.',
  target: {
    role: 'button',
    name: 'Change plan',
    locators: [
      {
        strategy: 'role',
        value: 'button',
        name: 'Change plan',
        exact: true,
        unique: true,
      },
      {
        strategy: 'testId',
        value: 'billing-change-plan',
        exact: true,
        unique: true,
      },
      { strategy: 'text', value: 'Change plan', exact: true },
      {
        strategy: 'css',
        value: 'section.plan > button',
        exact: true,
        unique: false,
      },
      {
        strategy: 'xpath',
        value: '//main//section[1]//button',
        exact: true,
        unique: false,
      },
    ],
  },
  expect: { visible: { role: 'dialog', name: 'Choose a plan' } },
  click: { x: 1158, y: 219, radius: 18 },
  edits: {
    annotations: [
      {
        type: 'rectangle',
        x: 1080,
        y: 188,
        width: 156,
        height: 60,
        color: 'accent',
      },
      { type: 'text', x: 896, y: 294, text: 'Owners only', color: 'accent' },
    ],
  },
  redactions: [
    {
      kind: 'email',
      source: 'auto',
      status: 'applied',
      rect: { x: 300, y: 438, width: 220, height: 20 },
    },
    {
      kind: 'card',
      source: 'auto',
      status: 'applied',
      rect: { x: 350, y: 552, width: 150, height: 20 },
    },
  ],
}
const adapter = await IndexedDbAdapter.open({
  now: () => new Date('2026-11-25T12:00:00Z'),
})
const processor = new ImageProcessor()
try {
  let guide = await adapter.createGuide(
    guideSchema.parse({
      schema: 'stepdoc/guide@1',
      id: 'editor-guide',
      title: 'Upgrade a workspace to the Team plan',
      app: { name: 'Ledgerly', origin: 'https://app.ledgerly.io' },
      collectionId: 'finance-ops',
      variables: [
        { name: 'seats', kind: 'variable', type: 'number' },
        { name: 'invoice_email', kind: 'secret' },
      ],
      steps,
      version: 1,
      createdAt: '2026-11-25T00:00:00Z',
      updatedAt: '2026-11-25T12:00:00Z',
      verification: { status: 'passed' },
    }),
  )
  const response = await fetch('/e2e/fixtures/editor-original.png')
  if (!response.ok) throw new Error('fixture')
  const source = await response.blob()
  for (const step of guide.steps) {
    const image = await processor.process(source, {
      format: 'image/png',
      edits: step.edits,
      click: step.click,
      redactions: step.redactions.map((item) => item.rect),
    })
    const original = await adapter.putBlob(guide.id, {
      file: image.original.blob,
      stepId: step.id,
      kind: 'original',
    })
    const rendered = await adapter.putBlob(guide.id, {
      file: image.rendered.blob,
      stepId: step.id,
      kind: 'rendered',
    })
    step.screenshot = {
      original: original.key,
      rendered: rendered.key,
      width: image.rendered.width,
      height: image.rendered.height,
      devicePixelRatio: 1,
      alt: 'Fictional Ledgerly billing settings',
    }
  }
  guide = await adapter.saveGuide(guide, guide.version)
  while (guide.version < 12)
    guide = await adapter.saveGuide(guide, guide.version)
  document.body.textContent = 'Editor fixture ready'
} catch {
  document.body.textContent = 'Editor fixture failed'
} finally {
  processor.close()
  adapter.close()
}

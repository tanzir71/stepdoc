import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { guideSchema } from '@stepdoc/schema'
import {
  exportGuideJson,
  exportHtml,
  exportMarkdown,
  exportPlaywright,
  exportSkill,
} from '@stepdoc/core/export'

const root = new URL('../site/demo/', import.meta.url)
const image = await readFile(
  new URL('../site/assets/ledgerly-billing.png', import.meta.url),
)
const picture = {
  original: null,
  rendered: 'img/ledgerly-billing.png',
  width: 1280,
  height: 800,
  devicePixelRatio: 1,
  alt: 'Fictional Ledgerly billing screen with sensitive fields already blurred.',
}
const guide = guideSchema.parse({
  schema: 'stepdoc/guide@1',
  id: 'upgrade-workspace-team',
  uuid: '123e4567-e89b-42d3-a456-426614174001',
  title: 'Upgrade the workspace to Team',
  description:
    'An example guide for a fictional billing screen. The same guide supplies the human HTML and agent replay downloads. No private data is included.',
  app: {
    name: 'Ledgerly (fictional example)',
    origin: 'https://app.ledgerly.io',
  },
  preconditions: ['Use the fictional example workspace with the Owner role.'],
  steps: [
    {
      id: 'open-settings',
      index: 1,
      type: 'navigate',
      action: 'navigate',
      title: 'Go to app.ledgerly.io/settings',
      url: 'https://app.ledgerly.io/settings',
      screenshot: picture,
    },
    {
      id: 'open-billing',
      index: 2,
      type: 'action',
      action: 'click',
      title: 'Click "Billing" in the sidebar',
      url: 'https://app.ledgerly.io/settings',
      target: {
        role: 'link',
        name: 'Billing',
        locators: [
          { strategy: 'role', value: 'link', name: 'Billing', unique: true },
        ],
      },
      expect: { urlMatches: '/settings/billing' },
      screenshot: picture,
    },
    {
      id: 'change-plan',
      index: 3,
      type: 'action',
      action: 'click',
      title: 'Click "Change plan"',
      description:
        'Opens the plan picker. Only workspace owners see this button.',
      url: 'https://app.ledgerly.io/settings/billing',
      target: {
        role: 'button',
        name: 'Change plan',
        locators: [
          {
            strategy: 'role',
            value: 'button',
            name: 'Change plan',
            unique: true,
          },
          { strategy: 'testId', value: 'billing-change-plan', unique: true },
        ],
      },
      expect: { visible: { role: 'dialog', name: 'Choose a plan' } },
      screenshot: picture,
    },
  ],
  version: 1,
  createdAt: '2026-11-25T00:00:00Z',
  updatedAt: '2026-11-25T00:00:00Z',
  verification: { status: 'never-run' },
})
const options = {
  canonicalUrl: 'https://tanzir71.github.io/stepdoc/site/demo/',
  images: Object.fromEntries(
    guide.steps.map((step) => [step.id, 'img/ledgerly-billing.png']),
  ),
}
const dataImages = Object.fromEntries(
  guide.steps.map((step) => [
    step.id,
    `data:image/png;base64,${image.toString('base64')}`,
  ]),
)
export async function demoFiles() {
  return new Map<string, string | Uint8Array>([
    ['guide.json', exportGuideJson(guide, options)],
    ['guide.md', exportMarkdown(guide, options)],
    ['replay.spec.ts', exportPlaywright(guide, options)],
    ['SKILL.md', exportSkill(guide, options)],
    ['index.html', exportHtml(guide, { ...options, images: dataImages })],
    ['img/ledgerly-billing.png', image],
  ])
}
export async function generateDemo() {
  await mkdir(new URL('img/', root), { recursive: true })
  for (const [file, body] of await demoFiles())
    await writeFile(new URL(file, root), body)
}

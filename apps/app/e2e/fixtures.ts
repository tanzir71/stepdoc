import type { GuideInput } from '@stepdoc/schema'

export function fixture(id = 'imported-guide'): GuideInput {
  return {
    schema: 'stepdoc/guide@1',
    id,
    title: 'Imported guide',
    description: 'A local test guide',
    steps: [
      {
        id: 'first-step',
        index: 1,
        type: 'manual',
        title: 'Open the plan dialog',
        description: 'Choose your workspace before continuing.',
      },
    ],
    version: 1,
    createdAt: '2026-11-25T00:00:00Z',
    updatedAt: '2026-11-25T00:00:00Z',
  }
}

export const visibleGuides = [
  ['Upgrade a workspace to the Team plan', 9, 'draft', 'finance-ops', 2 / 24],
  ["Export last month's invoices as CSV", 7, 'published', 'finance-ops', 1],
  ['Invite a teammate with billing access', 6, 'published', 'admin', 3],
  [
    'Add a customer and send the first invoice',
    14,
    'published',
    'finance-ops',
    4,
  ],
  ['Rotate the Ledgerly API key', 8, 'draft', 'engineering', 5],
  ['Change the invoice email recipient', 5, 'published', 'support-macros', 7],
  ['Refund a duplicate payment', 11, 'published', 'support-macros', 8],
  ['Close the month: reconcile payouts', 18, 'published', 'month-end', 14],
] as const

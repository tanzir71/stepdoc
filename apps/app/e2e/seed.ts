import { IndexedDbAdapter } from '@stepdoc/storage'
import type { GuideInput } from '@stepdoc/schema'
import { fixture, visibleGuides } from './fixtures'

// This module is served only by Vite during local tests; it is not a build entry.
let at = new Date()
const adapter = await IndexedDbAdapter.open({ now: () => at })
try {
  for (let index = 0; index < 48; index++) {
    const source = visibleGuides[index]
    const collection =
      source?.[3] ??
      (index < 19
        ? 'finance-ops'
        : index < 26
          ? 'support-macros'
          : index < 32
            ? 'engineering'
            : index < 37
              ? 'admin'
              : index < 42
                ? 'month-end'
                : 'people')
    const status =
      source?.[2] ??
      (index < 15 ? 'draft' : index < 40 ? 'published' : 'archived')
    at = new Date(Date.now() - (source?.[4] ?? 15 + index) * 86_400_000)
    const input: GuideInput = {
      ...fixture(`fixture-guide-${String(index).padStart(2, '0')}`),
      title:
        source?.[0] ?? `Workspace procedure ${String(index).padStart(2, '0')}`,
      status,
      collectionId: collection,
      app: { name: 'Ledgerly', origin: 'https://app.ledgerly.io' },
      steps: Array.from({ length: source?.[1] ?? 3 }, (_, step) => ({
        id: `step-${step + 1}`,
        index: step + 1,
        type: 'manual',
        title:
          step === 0
            ? 'Open the plan dialog'
            : `Continue to instruction ${step + 1}`,
        ...(index === 0 && step === 0
          ? {
              redactions: [
                {
                  kind: 'field',
                  source: 'manual',
                  status: 'open',
                  rect: { x: 1, y: 1, width: 1, height: 1 },
                },
              ],
            }
          : {}),
        ...((index === 8 || index === 9) && step === 0
          ? { lowConfidence: true }
          : {}),
      })),
      ...([1, 2, 5].includes(index) || (index >= 10 && index < 29)
        ? { verification: { status: 'passed' } }
        : index === 6
          ? { verification: { status: 'failed' } }
          : {}),
    }
    let saved = await adapter.createGuide(input)
    if (index < 8) {
      const image = index
      const response = await fetch(`/e2e/fixtures/thumb-${image}.png`)
      if (!response.ok) throw new Error('Fixture image unavailable')
      const file = await response.blob()
      const bitmap = await createImageBitmap(file)
      const dimensions = { width: bitmap.width, height: bitmap.height }
      bitmap.close()
      const { key } = await adapter.putBlob(saved.id, {
        file,
        stepId: saved.steps[0]!.id,
        kind: 'rendered',
      })
      saved.steps[0]!.screenshot = {
        rendered: key,
        ...dimensions,
        devicePixelRatio: 1,
        alt: 'Fictional Ledgerly workspace',
      }
      saved = await adapter.saveGuide(saved, saved.version)
    }
  }
  document.body.textContent = 'Seeded 48 guides'
} catch {
  document.body.textContent = 'Local fixture setup failed'
} finally {
  adapter.close()
}

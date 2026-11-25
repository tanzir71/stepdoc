import type { GuideInput } from '@stepdoc/schema'
import {
  json,
  prepareExport,
  stepUrl,
  type ExportContext,
  type ExportOptions,
} from './common'

export function howTo(context: ExportContext) {
  const { guide, canonicalUrl } = context
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: guide.title,
    description: guide.description,
    inLanguage: guide.locale,
    dateCreated: guide.capturedAt ?? guide.createdAt,
    dateModified: guide.updatedAt,
    ...(canonicalUrl && { url: canonicalUrl }),
    step: guide.steps.map((step) => ({
      '@type': 'HowToStep',
      position: step.index,
      name: step.title,
      text: step.description || step.title,
      url: stepUrl(context, step),
      ...(step.screenshot && {
        image:
          canonicalUrl && !step.screenshot.rendered.startsWith('data:')
            ? new URL(step.screenshot.rendered, canonicalUrl).href
            : step.screenshot.rendered,
      }),
    })),
  }
}

export function exportJsonLd(
  guide: GuideInput,
  options?: ExportOptions,
): string {
  return `${json(howTo(prepareExport(guide, options)))}\n`
}

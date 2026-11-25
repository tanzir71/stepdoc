import type { GuideInput } from '@stepdoc/schema'
import { json, prepareExport, type ExportOptions } from './common'

export function exportGuideJson(
  guide: GuideInput,
  options?: ExportOptions,
): string {
  return `${json(prepareExport(guide, options).guide)}\n`
}

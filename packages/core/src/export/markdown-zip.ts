import type { GuideInput } from '@stepdoc/schema'
import { portableAssets, zipFiles, type GuideAssets } from './archive'
import { exportMarkdown } from './markdown'

export function exportMarkdownZip(
  input: GuideInput,
  assets: GuideAssets,
): Uint8Array {
  const { files, paths } = portableAssets(input, assets)
  files['guide.md'] = new TextEncoder().encode(
    exportMarkdown(input, { images: paths }),
  )
  return zipFiles(files)
}

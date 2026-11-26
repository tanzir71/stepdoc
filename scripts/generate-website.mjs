import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { renderLanding } from './landing-template.mjs'

export async function websiteFiles() {
  const html = await renderLanding()
  const shared = await readFile(
    new URL('../packages/ui/styles.css', import.meta.url),
    'utf8',
  )
  return new Map([
    [
      'index.html',
      html.replace(/\b(href|src)="\.\/([^"]+)"/g, '$1="./site/$2"'),
    ],
    ['site/index.html', html],
    [
      'site/ui/styles.css',
      shared
        .replace(/^@import '\.\/tokens\.css';\r?\n/, '')
        .replaceAll("'./assets/fonts/", "'../fonts/"),
    ],
    [
      'site/ui/tokens.css',
      await readFile(
        new URL('../packages/ui/tokens.css', import.meta.url),
        'utf8',
      ),
    ],
    [
      'site/docs/guide.schema.json',
      await readFile(
        new URL('../docs/v2/guide.schema.json', import.meta.url),
        'utf8',
      ),
    ],
  ])
}
if (
  process.argv[1] &&
  new URL(import.meta.url).pathname
    .replace(/^\//, '')
    .toLowerCase()
    .endsWith(
      process.argv[1].replaceAll('\\', '/').replace(/^\//, '').toLowerCase(),
    )
) {
  await mkdir(new URL('../site/ui/', import.meta.url), { recursive: true })
  await mkdir(new URL('../site/docs/', import.meta.url), { recursive: true })
  for (const [file, contents] of await websiteFiles())
    await writeFile(new URL('../' + file, import.meta.url), contents)
}

import { readFile, writeFile } from 'node:fs/promises'
const source = JSON.parse(
  await readFile(
    new URL('../../../docs/v2/design-tokens.json', import.meta.url),
    'utf8',
  ),
)
const name = (value) => value.replace(/[/.]/g, '-')
const colors = (theme) =>
  Object.values(source.color)
    .map((token) => `${token.css}:${token[theme]};`)
    .join('\n')
const sizes = Object.entries(source.size)
  .filter(([, value]) => typeof value === 'number')
  .map(([key, value]) => `--sd-size-${name(key)}:${value}px;`)
  .join('\n')
const typography = Object.entries(source.type)
  .map(
    ([key, value]) =>
      `--sd-type-${key}:${value.weight} ${value.size}px/${value.line}px var(--sd-font-${value.family});\n--sd-tracking-${key}:${value.tracking}px;`,
  )
  .join('\n')
const utility = Object.entries(source.type)
  .map(
    ([key, value]) =>
      `.sd-type-${key}{font:var(--sd-type-${key});letter-spacing:var(--sd-tracking-${key});${value.transform ? `text-transform:${value.transform};` : ''}}`,
  )
  .join('\n')
const css = `/* Generated from docs/v2/design-tokens.json by scripts/tokens.mjs. */\n:root{\n${colors('light')}\n${Object.entries(
  source.space,
)
  .map(([key, value]) => `--sd-space-${name(key)}:${value}px;`)
  .join('\n')}\n${Object.entries(source.radius)
  .map(([key, value]) => `--sd-radius-${key}:${value}px;`)
  .join('\n')}\n${Object.entries(source.shadow)
  .map(([key, value]) => `--sd-shadow-${key}:${value};`)
  .join(
    '\n',
  )}\n--sd-font-sans:${source.font.sans};\n--sd-font-mono:${source.font.mono};\n${sizes}\n${typography}\ncolor-scheme:light;\n}\n[data-theme="dark"]{\n${colors('dark')}\ncolor-scheme:dark;\n}\n${utility}\n`
const target = new URL('../tokens.css', import.meta.url)
if (process.argv.includes('--check')) {
  if ((await readFile(target, 'utf8')).replace(/\r\n/g, '\n') !== css)
    throw new Error(
      'Generated UI tokens are stale; run node packages/ui/scripts/tokens.mjs',
    )
} else await writeFile(target, css)

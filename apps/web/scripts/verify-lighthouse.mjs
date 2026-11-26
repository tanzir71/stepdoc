/* global process, console */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
export async function verifyLighthouse({ entry, output, chrome }) {
  assert.equal(new URL(entry).hostname, '127.0.0.1', 'Lighthouse runs locally')
  const cli = path.join(
    path.dirname(require.resolve('lighthouse/package.json')),
    'cli/index.js',
  )
  for (const mode of ['mobile', 'desktop']) {
    const report = path.join(output, `lighthouse-${mode}.json`)
    const args = [
      cli,
      entry,
      '--quiet',
      '--only-categories=performance,accessibility',
      '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
      '--output=json',
      `--output-path=${report}`,
    ]
    if (mode === 'desktop') args.push('--preset=desktop')
    await promisify(execFile)(process.execPath, args, {
      env: { ...process.env, CHROME_PATH: chrome },
      windowsHide: true,
      timeout: 180_000,
    })
    const result = JSON.parse(await readFile(report, 'utf8'))
    assert(!result.runtimeError, JSON.stringify(result.runtimeError))
    const scores = Object.fromEntries(
      Object.entries(result.categories).map(([key, value]) => [
        key,
        Math.round(value.score * 100),
      ]),
    )
    console.log(`Local Lighthouse ${mode}: ${JSON.stringify(scores)}`)
    assert(
      scores.performance >= 95 && scores.accessibility >= 95,
      `Lighthouse ${mode} must reach 95: ${JSON.stringify(scores)}`,
    )
  }
}

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const target =
  process.argv.find((value) => value.startsWith('--target='))?.slice(9) || 'php'
if (!['php', 'worker', 'node'].includes(target))
  throw new Error('Expected --target=php|worker|node')
if (target !== 'php')
  throw new Error(`The ${target} contract launcher is not implemented yet`)
const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
async function run(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, STEPDOC_CONTRACT_TARGET: target },
    stdio: 'inherit',
    windowsHide: true,
  })
  const handlers = ['SIGTERM', 'SIGINT'].map((signal) => {
    const stop = () => child.kill(signal)
    process.once(signal, stop)
    return [signal, stop]
  })
  try {
    return await new Promise((resolve) => {
      child.once('error', () => resolve(1))
      child.once('exit', (code) => resolve(code ?? 1))
    })
  } finally {
    for (const [signal, stop] of handlers) process.removeListener(signal, stop)
  }
}
// Hosted contracts must exercise this source tree's production client, never a stale dist/.
const appRequire = createRequire(
  new URL('../../apps/app/package.json', import.meta.url),
)
const vite = join(
  dirname(appRequire.resolve('vite/package.json')),
  'bin/vite.js',
)
const built = await run(
  [vite, 'build'],
  new URL('../../apps/app/', import.meta.url),
)
process.exitCode =
  built || (await run([cli, 'run'], new URL('./', import.meta.url)))

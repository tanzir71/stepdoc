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
const child = spawn(process.execPath, [cli, 'run'], {
  cwd: new URL('./', import.meta.url),
  env: { ...process.env, STEPDOC_CONTRACT_TARGET: target },
  stdio: 'inherit',
  windowsHide: true,
})
child.on('error', () => {
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => child.kill(signal))

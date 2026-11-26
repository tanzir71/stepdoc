import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'

const root = new URL('../../../', import.meta.url)
const server = await createServer({
  root: fileURLToPath(root),
  configFile: false,
  resolve: {
    alias: [
      {
        find: /^@stepdoc\/schema$/,
        replacement: fileURLToPath(
          new URL('packages/schema/src/index.ts', root),
        ),
      },
      {
        find: /^@stepdoc\/core\/export$/,
        replacement: fileURLToPath(
          new URL('packages/core/src/export/index.ts', root),
        ),
      },
    ],
  },
  server: { middlewareMode: true },
  appType: 'custom',
  ssr: { noExternal: ['@stepdoc/core', '@stepdoc/schema'] },
})
try {
  const module = await server.ssrLoadModule('/scripts/generate-demo-guide.ts')
  if (process.argv.includes('--check')) {
    for (const [file, body] of await module.demoFiles())
      assert.deepEqual(
        await readFile(new URL('site/demo/' + file, root)),
        Buffer.from(body),
        `Generated website demo drift: ${file}`,
      )
  } else await module.generateDemo()
} finally {
  await server.close()
}

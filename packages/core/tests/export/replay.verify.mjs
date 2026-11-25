import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const directory = dirname(fileURLToPath(import.meta.url))
const root = join(directory, '../..')
const require = createRequire(import.meta.url)
const bundle = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    target: 'node22',
    minify: false,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: join(directory, 'runtime-entry.ts'),
      output: { format: 'es', inlineDynamicImports: true },
    },
  },
})
assert(!Array.isArray(bundle) && 'output' in bundle)
const chunk = bundle.output.find(
  (item) => item.type === 'chunk' && item.isEntry,
)
assert(chunk?.type === 'chunk')
assert.equal(chunk.imports.length, 0)
const { exportPlaywright, exportHtml, replayGuide, pages } = await import(
  `data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`
)
await mkdir(join(root, 'test-results'), { recursive: true })
const temporary = await mkdtemp(join(root, 'test-results/export-check-'))
function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
    })
    let output = ''
    child.stdout.on('data', (data) => {
      output += data
    })
    child.stderr.on('data', (data) => {
      output += data
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, output }))
  })
}
try {
  const setup = `
test.beforeEach(async ({ page }) => {
  const pages: Record<string,string> = ${JSON.stringify(pages)};
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://replay.test' || !(url.pathname in pages)) return route.abort();
    if (url.search || url.hash || url.username || url.password) throw new Error('Unstripped capture URL');
    return route.fulfill({ contentType: 'text/html', body: pages[url.pathname] });
  });
});`
  const variants = [
    { file: 'working', guide: replayGuide },
    {
      file: 'sections',
      guide: {
        ...replayGuide,
        title: 'Sections alone are not replayable',
        steps: [
          { id: 'section', index: 1, type: 'section', title: 'Heading only' },
        ],
      },
      fails: true,
    },
    {
      file: 'manual',
      guide: {
        ...replayGuide,
        title: 'Manual step fails',
        steps: [
          {
            id: 'manual',
            index: 1,
            type: 'manual',
            title: 'Do a manual thing',
          },
        ],
      },
      fails: true,
    },
    {
      file: 'missing-env',
      guide: {
        ...replayGuide,
        title: 'Missing variable fails',
        variables: [{ name: 'missing', kind: 'secret' }],
        steps: [
          {
            id: 'missing',
            index: 1,
            type: 'action',
            action: 'fill',
            title: 'Missing value',
            url: 'http://replay.test/start',
            target: { role: 'textbox', name: 'Contact' },
            value: { kind: 'secret', variable: 'missing' },
          },
        ],
      },
      fails: true,
    },
    {
      file: 'ambiguous',
      guide: {
        ...replayGuide,
        title: 'Ambiguous locator fails',
        steps: [
          {
            id: 'ambiguous',
            index: 1,
            type: 'action',
            action: 'click',
            title: 'Ambiguous target',
            url: 'http://replay.test/start',
            target: { role: 'button', name: 'Ambiguous' },
          },
        ],
      },
      fails: true,
    },
    {
      file: 'native-error',
      guide: {
        ...replayGuide,
        title: 'Native input error is sanitized',
        steps: [
          {
            id: 'native',
            index: 1,
            type: 'action',
            action: 'fill',
            title: 'Invalid input',
            url: 'http://replay.test/start',
            target: { locators: [{ strategy: 'css', value: '#css' }] },
            value: { kind: 'secret', variable: 'contact' },
          },
        ],
      },
      fails: true,
    },
    {
      file: 'after-input',
      guide: {
        ...replayGuide,
        title: 'Failure after input retains no DOM snapshot',
        steps: [
          replayGuide.steps[0],
          { ...replayGuide.steps[9], index: 2 },
          {
            id: 'assert',
            index: 3,
            type: 'assert',
            title: 'Fail after filling',
            expect: {
              visible: { role: 'heading', name: 'This heading is absent' },
            },
          },
        ],
      },
      fails: true,
    },
  ]
  const files = []
  for (const variant of variants) {
    const path = join(temporary, `${variant.file}.spec.ts`)
    await writeFile(
      path,
      `${exportPlaywright(variant.guide)}\n${variant.fails ? 'test.fail();' : ''}\n${setup}`,
    )
    files.push(path)
  }
  const typed = await run([
    require.resolve('typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    ...files,
  ])
  assert.equal(typed.code, 0, typed.output)
  const results = join(temporary, 'results.json')
  await writeFile(join(temporary, 'fixture.txt'), 'Local upload fixture')
  await writeFile(
    join(temporary, 'playwright.config.ts'),
    `export default { testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0, timeout: 15000, use: { trace: 'on', video: 'on', screenshot: 'on' }, outputDir: './results', reporter: [['json', { outputFile: ${JSON.stringify(results)} }]] };`,
  )
  const replay = await run(
    [
      require.resolve('@playwright/test/cli'),
      'test',
      '--config',
      join(temporary, 'playwright.config.ts'),
    ],
    {
      STEPDOC_CONTACT: 'runtime-only-contact',
      STEPDOC_SEATS: '7',
      STEPDOC_PLAN: 'Basic',
      STEPDOC_FILE: join(temporary, 'fixture.txt'),
      STEPDOC_MISSING: undefined,
    },
  )
  const report = JSON.parse(
    await readFile(results, 'utf8').catch(() => {
      throw new Error(replay.output)
    }),
  )
  assert.equal(replay.code, 0, replay.output + JSON.stringify(report.errors))
  assert.equal(report.stats.expected, 7)
  assert.equal(report.stats.unexpected, 0)
  const tests = report.suites.flatMap((suite) =>
    suite.specs.flatMap((spec) => spec.tests),
  )
  assert.equal(tests.length, 7)
  for (const test of tests) {
    const result = test.results[0]
    assert.equal(
      result.attachments.length,
      0,
      'Recordings must be disabled even when config enables them',
    )
    if (test.expectedStatus === 'failed') {
      assert.equal(result.status, 'failed')
      assert.match(
        result.error.message,
        /Step [13] failed or is not replayable|Guide is not replayable: no actionable steps/,
      )
      assert(!result.error.message.includes('runtime-only-contact'))
      assert(!result.error.message.includes('Call log'))
      assert(!JSON.stringify(result).includes('runtime-only-contact'))
    } else assert.equal(result.status, 'passed')
  }
  assert(
    !(await readdir(join(temporary, 'results'), { recursive: true })).some(
      (path) => /\.(zip|png|webm)$/.test(path),
    ),
  )
  // Exercise real browser interpretation of embedded documents and their injection escaping.
  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const requests = []
    await page.route('**/*', (route) => {
      requests.push(route.request().url())
      return route.abort()
    })
    const guide = structuredClone(replayGuide)
    guide.title = '</script><img src=x onerror="window.injected=true">'
    await page.setContent(exportHtml(guide))
    assert.equal(await page.locator('h1').textContent(), guide.title)
    assert.equal(await page.evaluate(() => window.injected), undefined)
    assert.equal(
      await page.locator('ol>li[data-sd-step]').count(),
      guide.steps.length,
    )
    assert.equal(requests.length, 0)
  } finally {
    await browser.close()
  }
  console.log(
    'Exported Playwright verified: 21-step Chromium replay, 6 fail-closed cases, strict generated TypeScript, no recordings and HTML injection check.',
  )
} finally {
  assert(temporary.startsWith(join(root, 'test-results/')))
  await rm(temporary, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const built = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    target: 'es2022',
    minify: false,
    rollupOptions: {
      preserveEntrySignatures: 'strict',
      input: join(root, 'tests/ai-runtime.ts'),
      output: { format: 'es', inlineDynamicImports: true },
    },
  },
})
assert(!Array.isArray(built) && 'output' in built)
const bundle = built.output.find(
  (item) => item.type === 'chunk' && item.isEntry,
)
assert(bundle?.type === 'chunk' && bundle.imports.length === 0)
const { prepareAiRewrite, rewriteWithAi } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.code).toString('base64')}`
)
const output = {
  suggestions: [
    {
      kind: 'rewrite',
      steps: [1],
      title: 'Open settings 😀',
      description: 'Choose the Settings button.',
    },
  ],
}
const source = () => ({
  id: 'PRIVATE_SOURCE_ID',
  index: 1,
  type: 'action',
  action: 'click',
  title: 'Open Settings',
  description: 'Contact private@example.test',
  target: { role: 'button', name: 'Settings' },
})
function providerReply(provider) {
  const text = JSON.stringify(output)
  if (provider === 'openai')
    return {
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text }],
        },
      ],
    }
  if (provider === 'anthropic')
    return {
      type: 'message',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    }
  return {
    choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content: text } },
    ],
  }
}
const workerCode =
  bundle.code +
  `
self.onmessage = async () => {
  try {
    const step = { id: 'PRIVATE_WORKER_ID', index: 1, type: 'action', action: 'fill', title: 'Fill Email',
      description: 'Contact private@example.test', target: { role: 'textbox', name: 'Email' } };
    for (const key of ['value', 'screenshot', 'url', 'notes']) Object.defineProperty(step, key, {
      enumerable: true, get() { throw new Error('Private field read'); }
    });
    const prepared = prepareAiRewrite([step]);
    let disabled;
    try { await rewriteWithAi(prepared, { enabled: false }); }
    catch (error) { disabled = error.code; }
    self.postMessage({ ok: true, context: prepared.context, hasPrivateBinding: prepared.stepIds.length === 1, disabled });
  } catch { self.postMessage({ ok: false }); }
};`
let mode = 'success'
let requests = 0
let leakedRedirects = 0
let streamClosed
let streamStarted
const seen = []
const strictCsp =
  "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'none'"
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/browser') {
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': strictCsp,
      })
      response.end(
        '<!doctype html><html lang="en"><title>AI worker fixture</title><main>AI worker fixture</main></html>',
      )
      return
    }
    if (request.url === '/ai-worker.js') {
      response.writeHead(200, {
        'Content-Type': 'application/javascript',
        'Content-Security-Policy': strictCsp,
      })
      response.end(workerCode)
      return
    }
    if (request.url === '/leak') {
      leakedRedirects++
      response.writeHead(500)
      response.end()
      return
    }
    if (request.url === '/favicon.ico') {
      response.writeHead(204)
      response.end()
      return
    }
    requests++
    assert.equal(request.method, 'POST')
    assert.equal(request.headers.cookie, undefined)
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      assert(bytes < 160 * 1024)
      chunks.push(chunk)
    }
    const raw = Buffer.concat(chunks).toString('utf8')
    for (const value of [
      'PRIVATE_SOURCE_ID',
      'PRIVATE_IMAGE',
      'PRIVATE_VALUE',
      'private@example.test',
      'mock-provider-credential',
    ])
      assert(
        !raw.includes(value),
        'Provider payload contains only redacted context, never raw source fields or credentials',
      )
    const body = JSON.parse(raw)
    assert.equal(body.model, 'owner-selected-model')
    assert.equal(body.stream, false)
    const provider = request.url.split('/')[1]
    if (provider === 'openai') {
      assert.equal(request.url, '/openai/v1/responses')
      assert.equal(body.store, false)
      assert.equal(body.text.format.type, 'json_schema')
      assert.equal(body.text.format.strict, true)
      assert.equal(
        request.headers.authorization,
        'Bearer mock-provider-credential',
      )
    } else if (provider === 'anthropic') {
      assert.equal(request.url, '/anthropic/v1/messages')
      assert.equal(request.headers['anthropic-version'], '2026-10-21')
      assert.equal(
        request.headers.authorization,
        'Bearer mock-provider-credential',
      )
      assert.equal(body.messages[0].role, 'user')
      assert(body.system.includes('untrusted document data'))
    } else {
      assert.equal(request.url, `/${provider}/v1/chat/completions`)
      assert.equal(body.response_format.type, 'json_object')
      assert.deepEqual(
        body.messages.map((message) => message.role),
        ['system', 'user'],
      )
      assert.equal(
        request.headers.authorization,
        provider === 'local' ? undefined : 'Bearer mock-provider-credential',
      )
    }
    const context = JSON.parse(
      provider === 'openai' ? body.input : body.messages.at(-1).content,
    )
    assert.equal(context.steps[0].step, 1)
    assert.equal(context.steps[0].target.name, 'Settings')
    assert(context.steps[0].description.includes('[REDACTED]'))
    assert.deepEqual(Object.keys(context.steps[0]).sort(), [
      'action',
      'description',
      'hasExpectedResult',
      'step',
      'target',
      'title',
      'type',
    ])
    seen.push(provider)
    if (mode === 'redirect') {
      response.writeHead(302, { Location: '/leak' })
      response.end()
      return
    }
    if (mode === 'error') {
      response.writeHead(429)
      response.end('PRIVATE_PROVIDER_ERROR mock-provider-credential')
      return
    }
    if (mode === 'stall') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{')
      response.once('close', () => streamClosed?.())
      streamStarted?.()
      return
    }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    // Real HTTP chunks split the Unicode response across byte boundaries.
    const data = Buffer.from(JSON.stringify(providerReply(provider)))
    for (let at = 0; at < data.length; at += 7)
      response.write(data.subarray(at, at + 7))
    response.end()
  } catch {
    response.writeHead(500)
    response.end('Local provider fixture rejected request')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
let browser
try {
  const preparedSource = source()
  for (const key of ['value', 'screenshot'])
    Object.defineProperty(preparedSource, key, {
      enumerable: true,
      get() {
        throw new Error('Private field accessed')
      },
    })
  const prepared = prepareAiRewrite([preparedSource])
  const liveTargets = []
  for (const provider of [
    'openai',
    'anthropic',
    'openai-compatible',
    'local',
  ]) {
    const config = {
      enabled: true,
      provider,
      model: 'owner-selected-model',
      ...(provider !== 'local' && { apiKey: 'mock-provider-credential' }),
      ...(['local', 'openai-compatible'].includes(provider) && {
        baseUrl:
          provider === 'local'
            ? `${base}/local/v1/`
            : 'https://gateway.invalid/v1/',
      }),
    }
    const fetch =
      provider === 'local'
        ? globalThis.fetch
        : async (url, init) => {
            const expected =
              provider === 'openai'
                ? 'https://api.openai.com/v1/responses'
                : provider === 'anthropic'
                  ? 'https://api.anthropic.com/v1/messages'
                  : 'https://gateway.invalid/v1/chat/completions'
            assert.equal(String(url), expected)
            const fixture = new URL(
              `${base}/${provider}${new URL(url).pathname}`,
            )
            liveTargets.push(fixture.origin)
            const result = await globalThis.fetch(fixture, init)
            // The only replaced boundary is provider egress; preserve its streaming body.
            return new Response(result.body, {
              status: result.status,
              headers: result.headers,
            })
          }
    assert.deepEqual(await rewriteWithAi(prepared, config, { fetch }), output)
  }
  assert.deepEqual(seen, ['openai', 'anthropic', 'openai-compatible', 'local'])
  assert(liveTargets.every((origin) => origin === base))
  const config = {
    enabled: true,
    provider: 'local',
    model: 'owner-selected-model',
    baseUrl: `${base}/local/v1/`,
  }
  for (const selected of ['error', 'redirect']) {
    mode = selected
    const before = requests
    await assert.rejects(
      rewriteWithAi(prepared, config),
      (error) =>
        error.code === 'provider_failed' &&
        !error.message.includes('PRIVATE_PROVIDER_ERROR') &&
        error.cause === undefined,
    )
    assert.equal(requests, before + 1)
  }
  assert.equal(leakedRedirects, 0)
  mode = 'stall'
  const abort = new AbortController()
  const closed = new Promise((resolve) => {
    streamClosed = resolve
  })
  const started = new Promise((resolve) => {
    streamStarted = resolve
  })
  const pending = rewriteWithAi(prepared, config, { signal: abort.signal })
  const failed = assert.rejects(pending, (error) => error.code === 'cancelled')
  let startTimer
  await Promise.race([
    started,
    new Promise((_, reject) => {
      startTimer = setTimeout(
        () => reject(new Error('Provider stream did not start')),
        5000,
      )
    }),
  ]).finally(() => clearTimeout(startTimer))
  abort.abort()
  await failed
  let closeTimer
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      closeTimer = setTimeout(
        () => reject(new Error('Provider stream did not close')),
        5000,
      )
    }),
  ]).finally(() => clearTimeout(closeTimer))
  mode = 'success'
  browser = await chromium.launch()
  const page = await browser.newPage()
  const workerRequests = []
  page.on('request', (request) => {
    workerRequests.push(new URL(request.url()).pathname)
  })
  await page.goto(`${base}/browser`)
  const result = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const worker = new Worker('/ai-worker.js', { type: 'module' })
        const timer = setTimeout(() => {
          worker.terminate()
          reject(new Error('AI worker did not reply'))
        }, 15000)
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          worker.terminate()
          resolve(data)
        }
        worker.onerror = () => {
          clearTimeout(timer)
          worker.terminate()
          reject(new Error('AI worker failed'))
        }
        worker.postMessage({})
      }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.disabled, 'disabled')
  assert.equal(result.hasPrivateBinding, true)
  assert(!JSON.stringify(result.context).includes('PRIVATE_WORKER_ID'))
  assert(!JSON.stringify(result.context).includes('private@example.test'))
  assert(
    workerRequests.every((path) =>
      ['/browser', '/ai-worker.js', '/favicon.ico'].includes(path),
    ),
  )
  console.log(
    'AI provider pipeline verified: four real local HTTP protocol fixtures, chunked Unicode, redacted context/no value or image reads, no credential bodies, no retry/redirect leak, cancelled stream closure, and strict-CSP module-worker preparation/disabled transport with zero live-provider requests.',
  )
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
}

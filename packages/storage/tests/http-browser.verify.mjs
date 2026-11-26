import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from 'playwright'

const output = await build({
  configFile: false,
  logLevel: 'error',
  build: {
    write: false,
    minify: false,
    rollupOptions: {
      input: fileURLToPath(
        new URL('./http-browser-fixture.ts', import.meta.url),
      ),
      output: { format: 'es', inlineDynamicImports: true },
    },
  },
})
assert(!Array.isArray(output) && 'output' in output)
const chunk = output.output.find(
  (item) => item.type === 'chunk' && item.isEntry,
)
assert(
  chunk?.type === 'chunk' &&
    chunk.imports.length === 0 &&
    chunk.dynamicImports.length === 0,
)
const health = {
  target: 'node-postgres',
  version: 'fixture',
  schema: 'stepdoc/guide@1',
  capabilities: { maxUploadBytes: 1024 * 1024 },
}
const origins = [],
  servers = [],
  records = []
let preflights = 0,
  leaks = 0,
  aborted = 0
for (let index = 0; index < 2; index++) {
  const guides = new Map(),
    versions = new Map(),
    blobs = new Map(),
    used = new Set()
  let blobNumber = 0
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1'),
        path = url.pathname
      if (!path.startsWith('/blocked/')) {
        if (origins.includes(req.headers.origin))
          res.setHeader('access-control-allow-origin', req.headers.origin)
        res.setHeader('access-control-allow-credentials', 'true')
        res.setHeader(
          'access-control-allow-headers',
          'authorization,content-type,if-match',
        )
        res.setHeader(
          'access-control-allow-methods',
          'GET,POST,PUT,DELETE,OPTIONS',
        )
        res.setHeader('vary', 'Origin')
      }
      if (req.method === 'OPTIONS') {
        preflights++
        res.writeHead(204)
        res.end()
        return
      }
      const send = (value, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      const failure = (status) =>
        send(
          {
            error: { code: 'fixture_error', message: 'PRIVATE_SERVER_DETAIL' },
          },
          status,
        )
      if (path === '/leak') {
        leaks++
        res.end('forbidden redirect')
        return
      }
      if (path === '/fixture.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' })
        res.end(chunk.code)
        return
      }
      if (path === '/') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'content-security-policy': `default-src 'none';script-src 'self';connect-src ${origins.join(' ')};worker-src blob:;img-src data:`,
        })
        res.end(
          '<!doctype html><html lang="en"><head><title>HTTP client fixture</title><link rel="icon" href="data:,"></head><body><script type="module" src="/fixture.js"></script></body></html>',
        )
        return
      }
      const api = path.slice(path.indexOf('/api/v1/') + 8)
      records.push({
        path,
        method: req.method,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
        referrer: req.headers.referer,
      })
      if (api === 'health') {
        assert(
          !req.headers.authorization && !req.headers.cookie,
          'Public health received credentials',
        )
        send(health)
        return
      }
      if (path.startsWith('/redirect/')) {
        res.writeHead(302, { location: `${origins[0]}/leak` })
        res.end()
        return
      }
      if (path.startsWith('/slow/')) {
        res.on('close', () => {
          if (!res.writableEnded) aborted++
        })
        const timer = setTimeout(() => {
          if (!res.destroyed) send({})
        }, 300)
        timer.unref()
        return
      }
      const raw = []
      for await (const part of req) raw.push(part)
      const body = Buffer.concat(raw)
      if (api === 'pairing/claim') {
        assert(
          !req.headers.authorization && !req.headers.cookie,
          'Anonymous claim received credentials',
        )
        const claim = JSON.parse(body.toString())
        assert.deepEqual(Object.keys(claim).sort(), [
          'code',
          'deviceName',
          'extensionId',
        ])
        if (used.has(claim.code)) {
          failure(400)
          return
        }
        used.add(claim.code)
        send(
          {
            id: 'fixture-device',
            token: 'sd_fixture_claimed',
            scopes: ['capture:write', 'guides:read'],
          },
          201,
        )
        return
      }
      const authenticated =
        req.headers.cookie?.includes('sd_session=fixture_session') ||
        [
          'Bearer sd_fixture_first',
          'Bearer sd_fixture_rotated',
          'Bearer sd_fixture_capture',
        ].includes(req.headers.authorization)
      if (!authenticated) {
        failure(401)
        return
      }
      if (req.headers.authorization)
        assert(!req.headers.cookie, 'Bearer request also sent cookies')
      if (
        req.headers.authorization === 'Bearer sd_fixture_capture' &&
        req.method !== 'GET' &&
        api !== 'sessions'
      ) {
        failure(403)
        return
      }
      if (api === 'sessions' && req.method === 'POST') {
        assert.equal(req.headers.authorization, 'Bearer sd_fixture_capture')
        const doc = JSON.parse(body.toString())
        assert.equal(doc.schema, 'stepdoc/guide@1')
        assert(
          !body.toString().includes('PRIVATE'),
          'Private capture metadata uploaded',
        )
        assert(!guides.has(doc.id), 'Capture was posted twice')
        for (const step of doc.steps)
          if (step.screenshot) {
            for (const kind of ['original', 'rendered']) {
              const value = step.screenshot[kind]
              if (value === null || value === undefined) continue
              const match = /^data:(image\/(?:png|webp));base64,(.*)$/.exec(
                value,
              )
              assert(match)
              const key = `captures/${doc.id}/${step.id}/${kind}`
              // No canvas, codec or image processing exists on this server path.
              blobs.set(key, {
                type: match[1],
                bytes: Buffer.from(match[2], 'base64'),
              })
              step.screenshot[kind] = key
            }
          }
        guides.set(doc.id, doc)
        versions.set(doc.id, [structuredClone(doc)])
        send({ guide: doc, editUrl: `/workspace/g/${doc.id}/edit` }, 201)
        return
      }
      if (api === 'guides' && req.method === 'GET') {
        let docs = [...guides.values()]
        if (url.searchParams.has('q'))
          docs = docs.filter((doc) =>
            doc.title.includes(url.searchParams.get('q')),
          )
        send({
          items: docs.map((doc) => ({
            id: doc.id,
            title: doc.title,
            stepCount: doc.steps.length,
            status: doc.status,
            openRedactions: 0,
            verification: 'never-run',
            collectionId: null,
            thumb: null,
            updatedAt: doc.updatedAt,
          })),
          nextCursor: null,
        })
        return
      }
      if (api === 'guides' && req.method === 'POST') {
        const doc = JSON.parse(body.toString())
        if (guides.has(doc.id)) {
          failure(409)
          return
        }
        doc.version = 1
        guides.set(doc.id, doc)
        versions.set(doc.id, [structuredClone(doc)])
        send(doc, 201)
        return
      }
      if (api.startsWith('blobs/')) {
        const blob = blobs.get(decodeURIComponent(api.slice(6)))
        if (!blob) {
          failure(404)
          return
        }
        res.writeHead(200, { 'content-type': blob.type })
        res.end(blob.bytes)
        return
      }
      const [area, id, part, version] = api.split('/')
      const doc = guides.get(id)
      if (area !== 'guides' || !doc) {
        failure(404)
        return
      }
      if (part === 'versions') {
        const history = versions.get(id)
        if (version) {
          const found = history.find((doc) => doc.version === Number(version))
          found ? send(found) : failure(404)
        } else
          send(
            history.map((doc) => ({
              version: doc.version,
              at: doc.updatedAt,
              by: 'Fixture editor',
              summary: 'Saved',
            })),
          )
        return
      }
      if (part === 'blobs' && req.method === 'POST') {
        assert(
          !body.toString().includes('PRIVATE_FILENAME'),
          'Original filename leaked',
        )
        const data = await new Response(body, {
          headers: { 'content-type': req.headers['content-type'] },
        }).formData()
        assert.deepEqual([...data.keys()].sort(), ['file', 'kind', 'stepId'])
        assert(doc.steps.some((step) => step.id === data.get('stepId')))
        const file = data.get('file')
        assert.equal(file.name, 'image.png')
        const key = `blobs/${id}/${++blobNumber}.png`
        blobs.set(key, {
          type: file.type,
          bytes: Buffer.from(await file.arrayBuffer()),
        })
        send({ key }, 201)
        return
      }
      if (req.method === 'PUT') {
        const incoming = JSON.parse(body.toString())
        if (
          Number(req.headers['if-match']) !== doc.version ||
          incoming.version !== doc.version
        ) {
          failure(409)
          return
        }
        incoming.version = doc.version + 1
        incoming.createdAt = doc.createdAt
        incoming.updatedAt = new Date().toISOString()
        guides.set(id, incoming)
        versions.get(id).push(structuredClone(incoming))
        send(incoming)
        return
      }
      if (req.method === 'DELETE') {
        guides.delete(id)
        res.writeHead(204)
        res.end()
        return
      }
      send(doc)
    } catch {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":{"code":"fixture_failure","message":"PRIVATE"}}')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  origins.push(`http://127.0.0.1:${server.address().port}`)
}
const browser = await chromium.launch()
try {
  const context = await browser.newContext()
  await context.addCookies([
    {
      name: 'sd_session',
      value: 'fixture_session',
      url: origins[0],
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
  const page = await context.newPage(),
    errors = [],
    unexpected = []
  page.on('pageerror', () => errors.push('Uncaught browser error'))
  context.on('request', (request) => {
    if (
      !origins.some((origin) => request.url().startsWith(origin)) &&
      !request.url().startsWith('blob:') &&
      !request.url().startsWith('data:')
    )
      unexpected.push('Nonlocal request')
  })
  await page.goto(origins[0])
  await page.waitForFunction(() => !!globalThis.httpFixture)
  let checks = 0
  checks += await page.evaluate(
    (server) => globalThis.httpFixture.run(server, 'same-origin', 'WIN-001'),
    `${origins[0]}/workspace`,
  )
  checks += await page.evaluate(
    (server) => globalThis.httpFixture.run(server, 'cross-origin', 'XOR-001'),
    `${origins[1]}/workspace`,
  )
  checks += await page.evaluate(
    (server) => globalThis.httpFixture.failures(server),
    `${origins[1]}/workspace`,
  )
  for (const [index, origin] of origins.entries())
    checks += await page.evaluate(
      ({ server, label }) => globalThis.httpFixture.capture(server, label),
      {
        server: `${origin}/workspace`,
        label: index ? 'cross-origin' : 'same-origin',
      },
    )
  checks += await page.evaluate(
    ({ code, server }) =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(
          new Blob(
            [
              code +
                '\nself.onmessage=async(event)=>{try{self.postMessage({checks:await self.httpFixture.run(event.data,"module-worker","WRK-001")+await self.httpFixture.capture(event.data,"module-worker")})}catch{self.postMessage({failure:true})}}',
            ],
            { type: 'text/javascript' },
          ),
        )
        const worker = new Worker(url, { type: 'module' }),
          timer = setTimeout(() => {
            worker.terminate()
            URL.revokeObjectURL(url)
            reject(new Error('HTTP worker timed out'))
          }, 30_000)
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          worker.terminate()
          URL.revokeObjectURL(url)
          data.failure
            ? reject(new Error('HTTP worker verification failed'))
            : resolve(data.checks)
        }
        worker.postMessage(server)
      }),
    { code: chunk.code, server: `${origins[1]}/workspace` },
  )
  assert(checks >= 60)
  assert(preflights > 0)
  assert.equal(leaks, 0)
  assert(aborted > 0)
  assert(
    records.some(
      (record) => record.authorization === 'Bearer sd_fixture_rotated',
    ),
  )
  assert(
    records.some((record) =>
      record.cookie?.includes('sd_session=fixture_session'),
    ),
  )
  assert(
    records.every((record) => !record.referrer),
    'API requests sent a referrer',
  )
  assert.deepEqual(errors, [])
  assert.deepEqual(unexpected, [])
  console.log(
    `HTTP adapter verified in Chromium: ${checks} checks, real same/cross-origin fetch and CORS preflights, cookie/bearer isolation, multipart rasters, concurrent versions/history, anonymous pairing, scoped capture with client-rendered/masked pixels and retry recovery, server-enforced scope denial, redirects/abort and a module worker; no external requests.`,
  )
} finally {
  await browser.close()
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

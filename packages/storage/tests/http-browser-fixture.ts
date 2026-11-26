import { guideSchema } from '@stepdoc/schema'
import { HttpAdapter, claimPairing } from '../src/http'
import { StorageError } from '../src/adapter'
import source from '../../schema/tests/fixtures/minimal.json'

let checks = 0
function check(condition: unknown, message: string): asserts condition {
  checks++
  if (!condition) throw new Error(message)
}
async function rejected(task: Promise<unknown>, code: string) {
  const result = await task.then(
    () => null,
    (error) => error,
  )
  check(
    result instanceof StorageError && result.code === code,
    `Expected sanitized ${code}`,
  )
  check(!String(result).includes('PRIVATE'), 'Private error text escaped')
}
async function renderedPixel() {
  const canvas = new OffscreenCanvas(1, 1),
    ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgb(17,23,31)'
  ctx.fillRect(0, 0, 1, 1)
  return canvas.convertToBlob({ type: 'image/png' })
}

const httpFixture = {
  async run(server: string, label: string, code: string) {
    const start = checks
    const png = await renderedPixel()
    let token = 'sd_fixture_first'
    const adapter = await HttpAdapter.open(server, {
      auth: { kind: 'bearer', token: () => token },
    })
    check(adapter.capabilities.target === 'node-postgres', 'Health target')
    check(Object.isFrozen(adapter.capabilities), 'Frozen capabilities')
    check(!JSON.stringify(adapter).includes(token), 'Credential serialization')
    const input = guideSchema.parse({
      ...source,
      id: `native-${label}`,
      title: 'Browser & API fixture',
    })
    const created = await adapter.createGuide({ ...input, version: 9 })
    check(created.version === 1, 'Created version')
    check(
      (await adapter.getGuide(created.id)).title === input.title,
      'Guide read',
    )
    const page = await adapter.listGuides({
      q: 'Browser &',
      status: 'draft',
      collection: null,
    })
    check(
      page.items.some((item) => item.id === created.id),
      'Encoded library query',
    )
    const key = await adapter.putBlob(created.id, {
      file: new File([png], 'PRIVATE_FILENAME.png', { type: 'image/png' }),
      stepId: created.steps[0]!.id,
      kind: 'rendered',
    })
    const raster = await adapter.getBlob(key.key)
    check(
      raster.type === 'image/png' && raster.size === png.size,
      'Raster transport',
    )
    const bitmap = await createImageBitmap(raster)
    check(bitmap.width === 1 && bitmap.height === 1, 'Client raster decode')
    bitmap.close()
    created.steps[0]!.screenshot = {
      original: null,
      rendered: key.key,
      width: 1,
      height: 1,
      devicePixelRatio: 1,
      alt: 'Processed fixture pixel',
    }
    const outcomes = await Promise.allSettled([
      adapter.saveGuide({ ...created, title: 'First writer' }, 1),
      adapter.saveGuide({ ...created, title: 'Second writer' }, 1),
    ])
    check(
      outcomes.filter((item) => item.status === 'fulfilled').length === 1,
      'One concurrent save',
    )
    check(
      outcomes.some(
        (item) =>
          item.status === 'rejected' &&
          item.reason instanceof StorageError &&
          item.reason.code === 'conflict',
      ),
      'Concurrent version conflict',
    )
    const current = await adapter.getGuide(created.id)
    check(current.version === 2, 'Version increment')
    const versions = await adapter.listVersions(created.id)
    check(versions.length === 2, 'History rows')
    check(
      (await adapter.getVersion(created.id, 1)).title === input.title,
      'Immutable historical guide',
    )
    check(
      current.steps[0]!.screenshot?.rendered === key.key,
      'Blob key round trip',
    )
    token = 'sd_fixture_rotated'
    check(
      (await adapter.getGuide(created.id)).version === 2,
      'Rotated bearer credential',
    )
    const session = await HttpAdapter.open(server, { readOnly: true })
    check(
      (await session.getGuide(created.id)).id === created.id,
      'Native cookie session',
    )
    await rejected(session.deleteGuide(created.id), 'unsupported')
    session.close()
    const credential = await claimPairing(server, {
      code,
      deviceName: 'Local fixture browser',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
    })
    check(
      credential.scopes.length === 2 &&
        credential.token === 'sd_fixture_claimed',
      'Pairing exchange',
    )
    await rejected(
      claimPairing(server, {
        code,
        deviceName: 'Local fixture browser',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      }),
      'invalid_pairing',
    )
    await adapter.deleteGuide(created.id)
    await rejected(adapter.getGuide(created.id), 'not_found')
    adapter.close()
    await rejected(adapter.listGuides(), 'closed')
    return checks - start
  },
  async failures(server: string) {
    const start = checks,
      origin = new URL(server).origin
    await rejected(HttpAdapter.open(`${origin}/blocked`), 'storage_unavailable')
    const redirect = await HttpAdapter.open(`${origin}/redirect`, {
      auth: { kind: 'bearer', token: () => 'sd_fixture_first' },
    })
    await rejected(redirect.getGuide('native-errors'), 'storage_unavailable')
    redirect.close()
    const slow = await HttpAdapter.open(`${origin}/slow`, { timeoutMs: 40 })
    await rejected(slow.getGuide('native-errors'), 'storage_unavailable')
    slow.close()
    const closing = await HttpAdapter.open(`${origin}/slow`)
    const pending = rejected(closing.getGuide('native-errors'), 'closed')
    closing.close()
    await pending
    return checks - start
  },
}
Object.assign(globalThis, { httpFixture })
type HttpFixtureApi = typeof httpFixture
declare global {
  var httpFixture: HttpFixtureApi
}

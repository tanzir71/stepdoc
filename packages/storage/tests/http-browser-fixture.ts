import { guideSchema } from '@stepdoc/schema'
import { HttpAdapter, claimPairing, CaptureHttpClient } from '../src/http'
import { captureUploadGuide } from '../../../apps/extension/src/review'
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
  async capture(server: string, label: string) {
    const start = checks
    const canvas = new OffscreenCanvas(64, 48),
      ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgb(20,40,60)'
    ctx.fillRect(0, 0, 64, 48)
    // A simulated mandatory mask is already in the stored source image.
    ctx.fillStyle = 'rgb(80,80,80)'
    ctx.fillRect(0, 0, 16, 16)
    const pixel = await canvas.convertToBlob({ type: 'image/png' })
    const encoded = btoa(
      String.fromCharCode(...new Uint8Array(await pixel.arrayBuffer())),
    )
    const guide = await captureUploadGuide({
      sessionId: crypto.randomUUID(),
      title: `Scoped capture ${label}`,
      startedAt: '2026-11-26T00:00:00Z',
      startedUrl:
        'https://fixture.test/settings?PRIVATE_QUERY#PRIVATE_FRAGMENT',
      steps: [
        guideSchema.parse(source).steps[0]!,
        {
          ...guideSchema.parse(source).steps[0]!,
          id: 'fill-private',
          index: 2,
          type: 'action',
          action: 'fill',
          title: 'Fill email',
          value: { kind: 'secret', variable: 'invoice_email' },
          click: { x: 40, y: 28, radius: 8 },
          redactions: [
            {
              kind: 'field',
              source: 'auto',
              status: 'applied',
              rect: { x: 0, y: 0, width: 16, height: 16 },
            },
          ],
        },
      ],
      images: [
        { screenshot: `data:image/png;base64,${encoded}` },
        { screenshot: `data:image/png;base64,${encoded}` },
      ],
    })
    check(
      !JSON.stringify(guide).includes('PRIVATE'),
      'Private query escaped preparation',
    )
    check(
      guide.variables[0]?.kind === 'secret' &&
        !('literal' in guide.steps[1]!.value!),
      'Reference-only fill',
    )
    const client = await CaptureHttpClient.open(server, {
      token: () => 'sd_fixture_capture',
    })
    const result = await client.upload(guide)
    check(
      result.guide.id === guide.id && result.guide.uuid === guide.uuid,
      'Capture identity',
    )
    check(
      result.editUrl ===
        `${new URL('../../', new URL(server + '/api/v1/')).href}g/${guide.id}/edit`,
      'Installation-scoped editor URL',
    )
    const reader = await HttpAdapter.open(server, {
      readOnly: true,
      auth: { kind: 'bearer', token: () => 'sd_fixture_capture' },
    })
    for (const kind of ['original', 'rendered'] as const) {
      const key = result.guide.steps[1]!.screenshot![kind]!
      const image = await reader.getBlob(key)
      const bitmap = await createImageBitmap(image)
      const proof = new OffscreenCanvas(bitmap.width, bitmap.height),
        pixels = proof.getContext('2d')!
      pixels.drawImage(bitmap, 0, 0)
      bitmap.close()
      check(
        proof.width === 64 && proof.height === 48,
        'Server copied raster dimensions',
      )
      const mask = pixels.getImageData(4, 4, 1, 1).data
      check(
        Math.abs(mask[0]! - 80) < 8 && Math.abs(mask[1]! - 80) < 8,
        'Mandatory source mask survives upload',
      )
      const marker = pixels.getImageData(48, 28, 1, 1).data
      check(
        kind === 'original' ? marker[0]! < 40 : marker[0]! > 150,
        'Client marker only on rendered raster',
      )
    }
    const editor = await HttpAdapter.open(server)
    const later = { ...result.guide, title: `Edited after capture ${label}` }
    await editor.saveGuide(later, 1)
    const recovered = await client.upload(guide)
    check(
      recovered.guide.version === 2 && recovered.guide.title === later.title,
      'Retry preserves later editor version',
    )
    // The fixture enforces capture scopes independently of client readOnly.
    const scoped = await HttpAdapter.open(server, {
      auth: { kind: 'bearer', token: () => 'sd_fixture_capture' },
    })
    await rejected(scoped.createGuide(guide), 'forbidden')
    await rejected(scoped.saveGuide(recovered.guide, 2), 'forbidden')
    await rejected(
      scoped.putBlob(guide.id, {
        file: pixel,
        stepId: 'fill-private',
        kind: 'original',
      }),
      'forbidden',
    )
    await rejected(scoped.deleteGuide(guide.id), 'forbidden')
    client.close()
    reader.close()
    editor.close()
    scoped.close()
    return checks - start
  },
}
Object.assign(globalThis, { httpFixture })
type HttpFixtureApi = typeof httpFixture
declare global {
  var httpFixture: HttpFixtureApi
}

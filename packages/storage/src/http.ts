import type { Guide, GuideInput } from '@stepdoc/schema'
import { guideSchema } from '@stepdoc/schema'
import {
  apiHealthSchema,
  apiGuidePageSchema,
  apiVersionsSchema,
  apiBlobKeySchema,
  bearerTokenSchema,
  issuedTokenSchema,
  pairingClaimSchema,
  apiCaptureResultSchema,
  type ApiCaptureResult,
  type PairingClaim,
  type IssuedToken,
} from '@stepdoc/schema/storage-api'
import {
  StorageError,
  type StorageAdapter,
  type StorageCapabilities,
  type StorageErrorCode,
  type GuidePage,
  type GuideQuery,
  type GuideVersion,
  type BlobUpload,
} from './adapter'
import {
  validateGuide,
  validateId,
  validateQuery,
  validateVersion,
} from './guides'
import { MAX_BLOB_BYTES, validateBlob } from './raster'
import { jsonBody } from './json-body'

export const MAX_API_JSON_BYTES = 64 * 1024 * 1024
export const MAX_CAPTURE_INLINE_BYTES = 8 * 1024 * 1024
export interface HttpRequestOptions {
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  maxJsonBytes?: number
}
export type HttpAuth =
  | { kind: 'session' }
  | { kind: 'bearer'; token: () => string | Promise<string> }
export interface HttpOptions extends HttpRequestOptions {
  auth?: HttpAuth
  readOnly?: boolean
}
type Parser<T> = { parse(input: unknown): T }
type RequestSettings = {
  method?: string
  body?: BodyInit
  json?: boolean
  ifMatch?: number
  expected?: number
  invalid?: StorageErrorCode
  authenticated?: boolean
  accept?: string
}

/** Server root or explicit API URL, including installations in a subdirectory. */
export function storageApiUrl(server: string): string {
  try {
    if (typeof server !== 'string' || server.length > 4096) throw new Error()
    const url = new URL(server)
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '[::1]' ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname)
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error()
    let path = url.pathname.replace(/\/+$/, '')
    if (!path.endsWith('/api/v1')) path += '/api/v1'
    url.pathname = path + '/'
    return url.href
  } catch {
    throw new StorageError('invalid_options')
  }
}
function parse<T>(schema: Parser<T>, input: unknown): T {
  try {
    return schema.parse(input)
  } catch {
    throw new StorageError('corrupt_data')
  }
}
function keyPath(key: string): string {
  if (
    typeof key !== 'string' ||
    !key ||
    key.length > 4096 ||
    key === '.' ||
    key === '..' ||
    /[\u0000-\u001f\u007f]/.test(key)
  )
    throw new StorageError('invalid_blob')
  return encodeURIComponent(key)
}
function responseError(
  status: number,
  invalid: StorageErrorCode,
): StorageError {
  const code: StorageErrorCode =
    status === 401
      ? 'unauthorized'
      : status === 403
        ? 'forbidden'
        : status === 404
          ? 'not_found'
          : status === 409
            ? 'conflict'
            : status === 413
              ? 'upload_too_large'
              : status === 423
                ? 'redaction_open'
                : status === 429
                  ? 'rate_limited'
                  : status === 400 || status === 422
                    ? invalid
                    : status === 405 || status === 501
                      ? 'unsupported'
                      : 'storage_unavailable'
  return new StorageError(code)
}
async function bytes(
  response: Response,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum)) {
    void response.body?.cancel().catch(() => {})
    throw new StorageError('corrupt_data')
  }
  if (!response.body) throw new StorageError('corrupt_data')
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maximum) {
        void reader.cancel().catch(() => {})
        throw new StorageError('corrupt_data')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    result.set(chunk, at)
    at += chunk.length
  }
  return result
}

class HttpClient {
  #external?: AbortSignal
  #base: string
  #fetch: typeof fetch
  #auth: HttpAuth | { kind: 'anonymous' } | undefined
  #closed = false
  #pending = new Set<AbortController>()
  #timeout: number
  readonly jsonLimit: number
  constructor(
    server: string,
    options: HttpRequestOptions,
    auth: HttpAuth | { kind: 'anonymous' },
  ) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new StorageError('invalid_options')
    this.#base = storageApiUrl(server)
    const fetcher = options.fetch ?? globalThis.fetch
    this.#timeout = options.timeoutMs ?? 15_000
    this.jsonLimit = options.maxJsonBytes ?? MAX_API_JSON_BYTES
    if (
      (options.fetch !== undefined && typeof options.fetch !== 'function') ||
      typeof fetcher !== 'function' ||
      !Number.isSafeInteger(this.#timeout) ||
      this.#timeout < 1 ||
      this.#timeout > 120_000 ||
      !Number.isSafeInteger(this.jsonLimit) ||
      this.jsonLimit < 1 ||
      this.jsonLimit > MAX_API_JSON_BYTES ||
      !auth ||
      !['session', 'bearer', 'anonymous'].includes(auth.kind) ||
      (auth.kind === 'bearer' && typeof auth.token !== 'function')
    )
      throw new StorageError('invalid_options')
    this.#fetch = fetcher.bind(globalThis)
    if (
      options.signal !== undefined &&
      (!options.signal ||
        typeof options.signal.aborted !== 'boolean' ||
        typeof options.signal.addEventListener !== 'function' ||
        typeof options.signal.removeEventListener !== 'function')
    )
      throw new StorageError('invalid_options')
    this.#external = options.signal
    this.#auth =
      auth.kind === 'bearer'
        ? { kind: 'bearer', token: auth.token }
        : { kind: auth.kind }
  }
  close() {
    this.#closed = true
    this.#auth = undefined
    for (const controller of this.#pending) controller.abort()
  }
  ready() {
    if (this.#closed) throw new StorageError('closed')
    if (this.#external?.aborted) throw new StorageError('storage_unavailable')
  }
  async #run<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#closed) throw new StorageError('closed')
    const controller = new AbortController()
    this.#pending.add(controller)
    let rejectAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = () =>
        reject(
          new StorageError(this.#closed ? 'closed' : 'storage_unavailable'),
        )
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const timer = setTimeout(() => controller.abort(), this.#timeout)
    const stop = () => controller.abort()
    this.#external?.addEventListener('abort', stop, { once: true })
    if (this.#external?.aborted) controller.abort()
    try {
      return await Promise.race([work(controller.signal), aborted])
    } catch (error) {
      if (this.#closed) throw new StorageError('closed')
      if (error instanceof StorageError) throw error
      throw new StorageError('storage_unavailable')
    } finally {
      clearTimeout(timer)
      this.#external?.removeEventListener('abort', stop)
      controller.signal.removeEventListener('abort', rejectAbort)
      this.#pending.delete(controller)
    }
  }
  async #request<T>(
    path: string,
    settings: RequestSettings,
    read: (response: Response) => Promise<T>,
  ): Promise<T> {
    return this.#run(async (signal) => {
      const headers = new Headers({
        Accept: settings.accept ?? 'application/json',
      })
      if (settings.json) headers.set('Content-Type', 'application/json')
      if (settings.ifMatch !== undefined)
        headers.set('If-Match', String(settings.ifMatch))
      const auth =
        settings.authenticated === false
          ? { kind: 'anonymous' as const }
          : this.#auth
      if (auth?.kind === 'bearer') {
        let token: string
        try {
          token = bearerTokenSchema.parse(await auth.token())
        } catch {
          throw new StorageError('unauthorized')
        }
        headers.set('Authorization', `Bearer ${token}`)
      }
      if (signal.aborted || this.#closed)
        throw new StorageError(this.#closed ? 'closed' : 'storage_unavailable')
      const url = new URL(path, this.#base)
      const response = await this.#fetch(url.href, {
        method: settings.method ?? 'GET',
        headers,
        body: settings.body,
        signal,
        credentials: auth?.kind === 'session' ? 'include' : 'omit',
        mode: 'cors',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      })
      if (response.redirected || (response.url && response.url !== url.href)) {
        void response.body?.cancel().catch(() => {})
        throw new StorageError('corrupt_data')
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw responseError(
          response.status,
          settings.invalid ?? 'invalid_guide',
        )
      }
      if (response.status !== (settings.expected ?? 200)) {
        void response.body?.cancel().catch(() => {})
        throw new StorageError('corrupt_data')
      }
      return read(response)
    })
  }
  json<T>(
    path: string,
    schema: Parser<T>,
    settings: RequestSettings = {},
  ): Promise<T> {
    return this.#request(path, settings, async (response) => {
      const mime = response.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase()
      if (mime !== 'application/json') {
        void response.body?.cancel().catch(() => {})
        throw new StorageError('corrupt_data')
      }
      const data = await bytes(response, this.jsonLimit)
      let value: unknown
      try {
        value = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(data),
        )
      } catch {
        throw new StorageError('corrupt_data')
      }
      return parse(schema, value)
    })
  }
  empty(path: string, method: string): Promise<void> {
    return this.#request(path, { method, expected: 204 }, async (response) => {
      void response.body?.cancel().catch(() => {})
    })
  }
  blob(path: string): Promise<Blob> {
    return this.#request(
      path,
      { accept: 'image/png, image/webp' },
      async (response) => {
        const mime = response.headers
          .get('content-type')
          ?.split(';')[0]
          ?.trim()
          .toLowerCase()
        if (mime !== 'image/png' && mime !== 'image/webp') {
          void response.body?.cancel().catch(() => {})
          throw new StorageError('corrupt_data')
        }
        const data = await bytes(response, MAX_BLOB_BYTES)
        const file = new Blob([data], { type: mime })
        try {
          return await validateBlob({
            file,
            stepId: 'transport',
            kind: 'rendered',
          })
        } catch {
          throw new StorageError('corrupt_data')
        }
      },
    )
  }
  body(value: unknown, code: StorageErrorCode = 'invalid_guide'): string {
    return jsonBody(value, this.jsonLimit, code)
  }
}

export interface CaptureHttpOptions extends HttpRequestOptions {
  token: () => string | Promise<string>
}
export async function captureImageBlob(
  url: string,
  maximum = MAX_BLOB_BYTES,
): Promise<Blob> {
  if (typeof url !== 'string') throw new StorageError('invalid_blob')
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_BLOB_BYTES)
    throw new StorageError('invalid_options')
  if (url.length > MAX_CAPTURE_INLINE_BYTES)
    throw new StorageError('upload_too_large')
  const match =
    /^data:(image\/(?:png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url)
  if (!match || !match[2] || match[2].length % 4)
    throw new StorageError('invalid_blob')
  const encoded = match[2]
  const size =
    (encoded.length / 4) * 3 -
    (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0)
  if (size > maximum) throw new StorageError('upload_too_large')
  let file: Blob
  try {
    const raw = atob(encoded)
    if (btoa(raw) !== encoded) throw new Error()
    file = new Blob([Uint8Array.from(raw, (char) => char.charCodeAt(0))], {
      type: match[1],
    })
  } catch {
    throw new StorageError('invalid_blob')
  }
  return validateBlob({ file, stepId: 'capture', kind: 'rendered' }, maximum)
}

/** Only capture:write + guides:read; exposes no general guide-write operation. */
export class CaptureHttpClient {
  #client: HttpClient
  #root: string
  readonly capabilities: Readonly<
    Pick<StorageCapabilities, 'target' | 'maxUploadBytes'>
  >
  private constructor(
    client: HttpClient,
    base: string,
    health: { target: StorageCapabilities['target']; maximum: number },
  ) {
    this.#client = client
    this.#root = new URL('../../', base).href
    this.capabilities = Object.freeze({
      target: health.target,
      maxUploadBytes: Math.min(MAX_BLOB_BYTES, health.maximum),
    })
  }
  static async open(
    server: string,
    options: CaptureHttpOptions,
  ): Promise<CaptureHttpClient> {
    let client: HttpClient | undefined
    try {
      if (
        !options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        typeof options.token !== 'function'
      )
        throw new StorageError('invalid_options')
      const base = storageApiUrl(server)
      client = new HttpClient(base, options, {
        kind: 'bearer',
        token: options.token,
      })
      const health = await client.json('health', apiHealthSchema, {
        authenticated: false,
      })
      return new CaptureHttpClient(client, base, {
        target: health.target,
        maximum: health.capabilities.maxUploadBytes,
      })
    } catch (error) {
      client?.close()
      if (error instanceof StorageError) throw error
      throw new StorageError('invalid_options')
    }
  }
  close() {
    this.#client.close()
  }
  #result(input: Guide, incoming: Guide): ApiCaptureResult {
    const guide = validateGuide(incoming, true)
    if (guide.id !== input.id) throw new StorageError('corrupt_data')
    if (guide.uuid !== input.uuid) throw new StorageError('conflict')
    for (const step of guide.steps)
      if (step.screenshot) {
        for (const key of [step.screenshot.original, step.screenshot.rendered])
          if (key !== undefined && key !== null) {
            if (/^data:/i.test(key)) throw new StorageError('corrupt_data')
            try {
              keyPath(key)
            } catch {
              throw new StorageError('corrupt_data')
            }
          }
      }
    return { guide, editUrl: new URL(`g/${guide.id}/edit`, this.#root).href }
  }
  async #existing(input: Guide): Promise<ApiCaptureResult | undefined> {
    let guide: Guide
    try {
      guide = await this.#client.json(`guides/${input.id}`, guideSchema)
    } catch (error) {
      if (error instanceof StorageError && error.code === 'not_found') return
      throw error
    }
    return this.#result(input, guide)
  }
  async upload(input: GuideInput): Promise<ApiCaptureResult> {
    this.#client.ready()
    const guide = validateGuide(input)
    if (
      !guide.uuid ||
      guide.version !== 1 ||
      guide.status !== 'draft' ||
      guide.publish?.isPublic ||
      guide.publish?.publicId ||
      guide.publish?.targets.length
    )
      throw new StorageError('invalid_guide')
    if (
      guide.steps.some((step) =>
        step.redactions.some((item) => item.status === 'open'),
      )
    )
      throw new StorageError('redaction_open')
    const body = this.#client.body(guide, 'upload_too_large')
    for (const step of guide.steps)
      if (step.screenshot) {
        this.#client.ready()
        if (
          ![step.screenshot.width, step.screenshot.height].every(
            (size) => Number.isSafeInteger(size) && size > 0 && size <= 16_384,
          ) ||
          step.screenshot.devicePixelRatio <= 0 ||
          step.screenshot.devicePixelRatio > 8
        )
          throw new StorageError('invalid_blob')
        for (const url of [step.screenshot.original, step.screenshot.rendered])
          if (url !== undefined && url !== null)
            await captureImageBlob(url, this.capabilities.maxUploadBytes)
      }
    // A worker may stop after the server commit but before it can acknowledge it.
    // Read the stable capture ID first; never overwrite a later editor revision.
    const existing = await this.#existing(guide)
    if (existing) return existing
    let result: ApiCaptureResult
    try {
      result = await this.#client.json('sessions', apiCaptureResultSchema, {
        method: 'POST',
        body,
        json: true,
        expected: 201,
      })
    } catch (error) {
      if (error instanceof StorageError && error.code === 'conflict') {
        const winner = await this.#existing(guide)
        if (winner) return winner
      }
      throw error
    }
    const checked = this.#result(guide, result.guide)
    let edit: URL
    try {
      edit = new URL(result.editUrl, this.#root)
    } catch {
      throw new StorageError('corrupt_data')
    }
    if (edit.href !== checked.editUrl) throw new StorageError('corrupt_data')
    if (
      checked.guide.version === 1 &&
      (checked.guide.status !== 'draft' ||
        checked.guide.publish?.isPublic ||
        checked.guide.publish?.publicId ||
        checked.guide.publish?.targets.length)
    )
      throw new StorageError('corrupt_data')
    return checked
  }
}

/** A caller owns the credential store; the adapter never persists or exposes it. */
export class HttpAdapter implements StorageAdapter {
  readonly capabilities: Readonly<StorageCapabilities>
  #client: HttpClient
  private constructor(client: HttpClient, capabilities: StorageCapabilities) {
    this.#client = client
    this.capabilities = Object.freeze(capabilities)
  }
  static async open(
    server: string,
    options: HttpOptions = {},
  ): Promise<HttpAdapter> {
    let client: HttpClient | undefined
    try {
      if (
        !options ||
        Array.isArray(options) ||
        typeof options !== 'object' ||
        (options.readOnly !== undefined &&
          typeof options.readOnly !== 'boolean')
      )
        throw new StorageError('invalid_options')
      client = new HttpClient(
        server,
        options,
        options.auth === undefined ? { kind: 'session' } : options.auth,
      )
      const health = await client.json('health', apiHealthSchema, {
        authenticated: false,
      })
      return new HttpAdapter(client, {
        target: health.target,
        readOnly: options.readOnly ?? false,
        versions: true,
        maxUploadBytes: Math.min(
          MAX_BLOB_BYTES,
          health.capabilities.maxUploadBytes,
        ),
      })
    } catch (error) {
      client?.close()
      if (error instanceof StorageError) throw error
      throw new StorageError('invalid_options')
    }
  }
  close(): void {
    this.#client.close()
  }
  #writable() {
    this.#client.ready()
    if (this.capabilities.readOnly) throw new StorageError('unsupported')
  }
  async listGuides(query: GuideQuery = {}): Promise<GuidePage> {
    try {
      validateQuery(query)
      query = {
        q: query.q,
        status: query.status,
        collection: query.collection,
        cursor: query.cursor,
      }
    } catch {
      throw new StorageError('invalid_query')
    }
    const params = new URLSearchParams()
    if (query.q !== undefined) params.set('q', query.q)
    if (query.status !== undefined) params.set('status', query.status)
    if (query.collection !== undefined)
      params.set('collection', query.collection ?? '')
    if (query.cursor !== undefined) params.set('cursor', query.cursor)
    const page = await this.#client.json(
      `guides${params.size ? '?' + params : ''}`,
      apiGuidePageSchema,
      { invalid: 'invalid_query' },
    )
    if (
      new Set(page.items.map((item) => item.id)).size !== page.items.length ||
      (page.nextCursor !== null && page.nextCursor === query.cursor)
    )
      throw new StorageError('corrupt_data')
    return page
  }
  async getGuide(id: string): Promise<Guide> {
    validateId(id)
    const guide = validateGuide(
      await this.#client.json(`guides/${id}`, guideSchema),
      true,
    )
    if (guide.id !== id) throw new StorageError('corrupt_data')
    return guide
  }
  async createGuide(input: GuideInput): Promise<Guide> {
    this.#writable()
    const doc = validateGuide(input)
    doc.version = 1
    const result = validateGuide(
      await this.#client.json('guides', guideSchema, {
        method: 'POST',
        body: this.#client.body(doc),
        json: true,
        expected: 201,
      }),
      true,
    )
    if (
      result.id !== doc.id ||
      result.version !== 1 ||
      (doc.uuid !== undefined && result.uuid !== doc.uuid)
    )
      throw new StorageError('corrupt_data')
    return result
  }
  async saveGuide(input: GuideInput, ifMatch: number): Promise<Guide> {
    this.#writable()
    const doc = validateGuide(input)
    validateVersion(ifMatch)
    if (ifMatch === Number.MAX_SAFE_INTEGER)
      throw new StorageError('invalid_guide')
    if (doc.version !== ifMatch) throw new StorageError('conflict')
    const result = validateGuide(
      await this.#client.json(`guides/${doc.id}`, guideSchema, {
        method: 'PUT',
        body: this.#client.body(doc),
        json: true,
        ifMatch,
      }),
      true,
    )
    if (
      result.id !== doc.id ||
      result.version !== ifMatch + 1 ||
      (doc.uuid !== undefined && result.uuid !== doc.uuid)
    )
      throw new StorageError('corrupt_data')
    return result
  }
  async deleteGuide(id: string): Promise<void> {
    this.#writable()
    validateId(id)
    return this.#client.empty(`guides/${id}`, 'DELETE')
  }
  async listVersions(id: string): Promise<GuideVersion[]> {
    validateId(id)
    const versions = await this.#client.json(
      `guides/${id}/versions`,
      apiVersionsSchema,
    )
    if (new Set(versions.map((item) => item.version)).size !== versions.length)
      throw new StorageError('corrupt_data')
    return versions
  }
  async getVersion(id: string, version: number): Promise<Guide> {
    validateId(id)
    validateVersion(version)
    const result = validateGuide(
      await this.#client.json(`guides/${id}/versions/${version}`, guideSchema),
      true,
    )
    if (result.id !== id || result.version !== version)
      throw new StorageError('corrupt_data')
    return result
  }
  async putBlob(id: string, input: BlobUpload): Promise<{ key: string }> {
    this.#writable()
    validateId(id)
    if (!input || typeof input !== 'object')
      throw new StorageError('invalid_blob')
    let copy: BlobUpload
    try {
      copy = { file: input.file, stepId: input.stepId, kind: input.kind }
    } catch {
      throw new StorageError('invalid_blob')
    }
    if (
      copy.file instanceof Blob &&
      copy.file.size > this.capabilities.maxUploadBytes
    )
      throw new StorageError('upload_too_large')
    let file: Blob
    try {
      file = await validateBlob(copy, this.capabilities.maxUploadBytes)
    } catch {
      throw new StorageError('invalid_blob')
    }
    const body = new FormData()
    body.append(
      'file',
      file,
      file.type === 'image/png' ? 'image.png' : 'image.webp',
    )
    body.append('stepId', copy.stepId)
    body.append('kind', copy.kind)
    const result = await this.#client.json(
      `guides/${id}/blobs`,
      apiBlobKeySchema,
      { method: 'POST', body, expected: 201, invalid: 'invalid_blob' },
    )
    try {
      keyPath(result.key)
    } catch {
      throw new StorageError('corrupt_data')
    }
    return result
  }
  async getBlob(key: string): Promise<Blob> {
    return this.#client.blob(`blobs/${keyPath(key)}`)
  }
}

/** Anonymous exchange only; successful credentials must be kept in private storage. */
export async function claimPairing(
  server: string,
  input: PairingClaim,
  options: HttpRequestOptions = {},
): Promise<IssuedToken> {
  let claim: PairingClaim
  try {
    claim = pairingClaimSchema.parse(input)
  } catch {
    throw new StorageError('invalid_pairing')
  }
  let client: HttpClient | undefined
  try {
    client = new HttpClient(server, options, { kind: 'anonymous' })
    await client.json('health', apiHealthSchema, { authenticated: false })
    const result = await client.json('pairing/claim', issuedTokenSchema, {
      method: 'POST',
      body: client.body(claim),
      json: true,
      expected: 201,
      invalid: 'invalid_pairing',
    })
    if (
      result.scopes.length !== 2 ||
      !result.scopes.includes('capture:write') ||
      !result.scopes.includes('guides:read')
    )
      throw new StorageError('corrupt_data')
    return result
  } catch (error) {
    if (error instanceof StorageError) throw error
    throw new StorageError('invalid_options')
  } finally {
    client?.close()
  }
}

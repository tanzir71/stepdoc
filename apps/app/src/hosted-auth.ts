import {
  apiHealthSchema,
  apiSessionSchema,
  type ApiSession,
} from '@stepdoc/schema/storage-api'
import type { HostedConfig } from './hosted-config'

export class SignInError extends Error {
  constructor(
    public readonly code:
      | 'credentials'
      | 'rate'
      | 'unavailable'
      | 'cancelled'
      | 'unsupported',
  ) {
    super(code)
  }
}
export const signInMessages = {
  credentials:
    'Sign-in could not be verified. Check your details and try again.',
  rate: 'Too many attempts. Wait a little before trying again.',
  unavailable:
    'The server could not be reached. Your existing work is retained. Retry when it is available.',
  cancelled:
    'Passkey sign-in was cancelled. You can try again or use another method.',
  unsupported:
    'Passkeys are unavailable in this browser. Use an email or recovery code.',
} as const

export class HostedAuth {
  constructor(private readonly config: HostedConfig) {}
  private async request(
    path: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await fetch(this.config.api + path, {
      method: body ? 'POST' : 'GET',
      credentials: 'same-origin',
      mode: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.any([
        AbortSignal.timeout(25000),
        ...(signal ? [signal] : []),
      ]),
      ...(body
        ? {
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : {}),
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401 && path === 'auth/session') return null
      throw new SignInError(
        response.status === 429
          ? 'rate'
          : [400, 401, 403, 409].includes(response.status)
            ? 'credentials'
            : 'unavailable',
      )
    }
    if (response.status === 204) return null
    if (!response.headers.get('Content-Type')?.startsWith('application/json'))
      throw new SignInError('unavailable')
    const reader = response.body?.getReader()
    if (!reader) throw new SignInError('unavailable')
    const chunks: Uint8Array[] = []
    let bytes = 0
    let complete = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          complete = true
          break
        }
        bytes += value.length
        if (bytes > 128 * 1024) throw new SignInError('unavailable')
        chunks.push(value)
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    const result = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    signal?.throwIfAborted()
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(result),
    ) as unknown
  }
  async health(signal?: AbortSignal) {
    return apiHealthSchema.parse(
      await this.request('health', undefined, signal),
    )
  }
  async current(signal?: AbortSignal): Promise<ApiSession | null> {
    const result = await this.request('auth/session', undefined, signal)
    return result === null ? null : apiSessionSchema.parse(result)
  }
  async logout() {
    await this.request('auth/logout', {})
  }
  async email(email: string, signal: AbortSignal) {
    await this.request('auth/code/request', { email }, signal)
  }
  async code(
    email: string,
    code: string,
    recovery: boolean,
    signal: AbortSignal,
  ) {
    return apiSessionSchema.parse(
      await this.request(
        recovery ? 'auth/recovery' : 'auth/code/verify',
        { email, code },
        signal,
      ),
    )
  }
  async passkey(register: boolean, signal: AbortSignal, email?: string) {
    if (!globalThis.PublicKeyCredential || !navigator.credentials)
      throw new SignInError('unsupported')
    try {
      const options = (await this.request(
        'auth/passkey/options',
        {
          mode: register ? 'register' : 'authenticate',
          ...(register ? { email } : {}),
        },
        signal,
      )) as {
        publicKey: PublicKeyCredentialCreationOptionsJSON &
          PublicKeyCredentialRequestOptionsJSON
      }
      const publicKey = register
        ? PublicKeyCredential.parseCreationOptionsFromJSON(options.publicKey)
        : PublicKeyCredential.parseRequestOptionsFromJSON(options.publicKey)
      const credential = register
        ? await navigator.credentials.create({
            publicKey: publicKey as PublicKeyCredentialCreationOptions,
            signal,
          })
        : await navigator.credentials.get({
            publicKey: publicKey as PublicKeyCredentialRequestOptions,
            signal,
          })
      if (!(credential instanceof PublicKeyCredential))
        throw new SignInError('cancelled')
      return apiSessionSchema.parse(
        await this.request('auth/passkey/verify', credential.toJSON(), signal),
      )
    } catch (error) {
      if (
        error instanceof DOMException &&
        ['NotAllowedError', 'AbortError'].includes(error.name)
      )
        throw new SignInError('cancelled')
      throw error
    }
  }
}

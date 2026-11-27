import { installationStatusSchema } from '@stepdoc/schema/installation'
import {
  apiSessionSchema,
  apiPairingCodeSchema,
} from '@stepdoc/schema/storage-api'
import { HostedAuth, nativeCredential, SignInError } from './hosted-auth'

export class SetupClient {
  private readonly transport: HostedAuth
  private readonly auth: HostedAuth
  constructor(
    readonly endpoint: string,
    readonly base: string,
  ) {
    this.transport = new HostedAuth({ api: endpoint + '?action=', base })
    this.auth = new HostedAuth({
      api: new URL(base + '/api/v1/', endpoint).href,
      base,
    })
  }
  async status(signal?: AbortSignal) {
    const result = installationStatusSchema.parse(
      await this.transport.request('status', undefined, signal),
    )
    if (result.base !== this.base) throw new SignInError('unavailable')
    return result
  }
  async claim(key: string, signal: AbortSignal) {
    const result = installationStatusSchema.parse(
      await this.transport.request('claim', { key }, signal),
    )
    if (result.base !== this.base) throw new SignInError('unavailable')
    return result
  }
  async register(
    owner: { name: string; email: string; workspace: string },
    signal: AbortSignal,
  ) {
    const options = (await this.transport.request(
      'owner-options',
      owner,
      signal,
    )) as {
      publicKey: PublicKeyCredentialCreationOptionsJSON &
        PublicKeyCredentialRequestOptionsJSON
    }
    const credential = await nativeCredential(
      options.publicKey,
      true,
      signal,
    )
    return apiSessionSchema.parse(
      await this.transport.request('owner-verify', credential, signal),
    )
  }
  current(signal?: AbortSignal) {
    return this.auth.current(signal)
  }
  async pairing(signal: AbortSignal) {
    return apiPairingCodeSchema.parse(
      await this.auth.request('pairing/codes', {}, signal),
    )
  }
}

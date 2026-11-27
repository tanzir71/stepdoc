import { chromium } from '@playwright/test'
import type { AuthFixture } from './auth-fixture'

export async function authBrowser(fixture: AuthFixture) {
  const browser = await chromium.launch({ args: ['--disable-gpu'] })
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(fixture.server.api + 'health')
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    const { authenticatorId } = await cdp.send(
      'WebAuthn.addVirtualAuthenticator',
      {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    )
    return {
      browser,
      context,
      page,
      cdp,
      authenticatorId,
      request: (path: string, method = 'GET', body?: unknown, token?: string) =>
        page.evaluate(
          async ({ api, path, method, body, token }) => {
            const response = await fetch(api + path, {
              method,
              headers: {
                ...(body === undefined
                  ? {}
                  : { 'Content-Type': 'application/json' }),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            })
            return {
              status: response.status,
              body:
                response.status === 204
                  ? null
                  : ((await response.json()) as unknown),
            }
          },
          { api: fixture.server.api, path, method, body, token },
        ),
      ceremony: (
        mode: 'register' | 'authenticate',
        email?: string,
        token?: string,
        verification: 'required' | 'discouraged' = 'required',
      ) =>
        page.evaluate(
          async ({ api, mode, email, token, verification }) => {
            const response = await fetch(api + 'auth/passkey/options', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
              body: JSON.stringify({ mode, ...(email ? { email } : {}) }),
            })
            if (!response.ok)
              throw new Error(`Passkey options failed (${response.status})`)
            const options = (await response.json()) as {
              publicKey: PublicKeyCredentialCreationOptionsJSON &
                PublicKeyCredentialRequestOptionsJSON
            }
            let credential: Credential | null
            if (mode === 'register') {
              const publicKey =
                PublicKeyCredential.parseCreationOptionsFromJSON(
                  options.publicKey,
                )
              publicKey.authenticatorSelection = {
                ...publicKey.authenticatorSelection,
                userVerification: verification,
              }
              credential = await navigator.credentials.create({
                publicKey,
                signal: AbortSignal.timeout(10000),
              })
            } else {
              const publicKey = PublicKeyCredential.parseRequestOptionsFromJSON(
                options.publicKey,
              )
              publicKey.userVerification = verification
              credential = await navigator.credentials.get({
                publicKey,
                signal: AbortSignal.timeout(10000),
              })
            }
            if (!(credential instanceof PublicKeyCredential))
              throw new Error('No native public-key credential returned')
            return credential.toJSON()
          },
          { api: fixture.server.api, mode, email, token, verification },
        ),
      close: () => browser.close(),
    }
  } catch (error) {
    await browser.close()
    throw error
  }
}

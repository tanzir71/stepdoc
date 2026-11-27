import { phpFixture } from './php-fixture'
import { smtpFixture } from './smtp-fixture'

export async function authFixture() {
  const target = process.env.STEPDOC_CONTRACT_TARGET ?? 'php'
  if (target !== 'php')
    throw new Error(
      `The ${target} authentication provisioner is not implemented yet`,
    )
  const smtp = await smtpFixture()
  try {
    const fixture = await phpFixture({
      hostname: 'localhost',
      smtpPort: smtp.port,
    })
    try {
      const owner = fixture.member('owner@fixture.test', 'owner')
      const editor = fixture.member('editor@fixture.test', 'editor')
      const viewer = fixture.member('viewer@fixture.test', 'viewer')
      return {
        ...fixture,
        smtp,
        members: { owner, editor, viewer },
        close: async () => {
          await fixture.close()
          await smtp.close()
        },
      }
    } catch (error) {
      await fixture.close()
      throw error
    }
  } catch (error) {
    await smtp.close()
    throw error
  }
}
export type AuthFixture = Awaited<ReturnType<typeof authFixture>>

// Requests exercise the public HTTP boundary; administrative fixture hooks stay private.
export function apiClient(
  fixture: AuthFixture,
  origin = fixture.server.origin,
) {
  const cookies = new Map<string, string>()
  return {
    cookies,
    request: async (
      path: string,
      method = 'GET',
      body?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const response = await fetch(`${origin}/tools/api/v1/${path}`, {
        method,
        headers: {
          Origin: origin,
          ...(cookies.size
            ? {
                Cookie: [...cookies]
                  .map(([name, value]) => `${name}=${value}`)
                  .join('; '),
              }
            : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      })
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';')[0]!,
          at = pair.indexOf('=')
        const name = pair.slice(0, at),
          value = pair.slice(at + 1)
        if (value) cookies.set(name, value)
        else cookies.delete(name)
      }
      return response
    },
  }
}

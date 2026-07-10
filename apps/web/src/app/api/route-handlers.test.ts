import { beforeEach, describe, expect, it } from 'vitest'
import { testGuides } from '@/lib/test-store'
import { POST as createSession } from './sessions/route'
import { GET as getGuide } from './guides/[id]/route'
import { GET as exportGuide } from './guides/[id]/export/[format]/route'

function jsonRequest(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('API route handlers', () => {
  beforeEach(() => {
    process.env.STEPDOC_TEST_MODE = '1'
    testGuides.clear()
  })

  it('validates session payloads before persistence', async () => {
    const response = await createSession(jsonRequest('/api/sessions', { title: 'Bad', steps: [] }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'VALIDATION_ERROR' })
  })

  it('creates and reads a guide through route handlers without live Supabase', async () => {
    const created = await createSession(
      jsonRequest('/api/sessions', {
        title: 'Route handler guide',
        steps: [{ position: 0, type: 'action', text: 'Click Save' }],
      }),
    )
    expect(created.status).toBe(201)
    const { id } = await created.json()
    const response = await getGuide(new Request(`http://localhost/api/guides/${id}`), {
      params: Promise.resolve({ id }),
    })
    expect(response.status).toBe(200)
    const guide = await response.json()
    expect(guide.title).toBe('Route handler guide')
    expect(guide.steps).toHaveLength(1)
  })

  it('returns typed validation errors for invalid route params', async () => {
    const response = await getGuide(new Request('http://localhost/api/guides/not-a-uuid'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'VALIDATION_ERROR' })
  })

  it('validates export formats with zod', async () => {
    const id = crypto.randomUUID()
    const response = await exportGuide(new Request(`http://localhost/api/guides/${id}/export/docx`), {
      params: Promise.resolve({ id, format: 'docx' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'VALIDATION_ERROR' })
  })
})

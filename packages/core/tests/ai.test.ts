import { afterEach, describe, expect, it, vi } from 'vitest'
import { stepSchema, type Step } from '@stepdoc/schema'
import {
  AI_LIMITS,
  type AiProviderConfig,
  type AiSuggestions,
} from '@stepdoc/schema/ai'
import {
  AiRewriteError,
  prepareAiRewrite,
  rewriteWithAi,
  validateAiSuggestions,
} from '../src/ai'

const step = (id = 'private-identity', index = 1): Step =>
  stepSchema.parse({
    id,
    index,
    type: 'action',
    action: 'click',
    title: 'Open Settings',
    description: 'Choose Settings.',
    url: 'https://account.test/PRIVATE_PATH?PRIVATE_QUERY',
    target: {
      role: 'button',
      name: 'Settings',
      locators: [{ strategy: 'css', value: '#PRIVATE_SELECTOR', unique: true }],
    },
    screenshot: { rendered: 'PRIVATE_IMAGE', width: 1200, height: 900 },
  })
const proposals = (): AiSuggestions => ({
  suggestions: [
    {
      kind: 'rewrite',
      steps: [1],
      title: 'Open workspace settings',
      description: 'Choose the Settings button.',
    },
  ],
})
const config = (provider: AiProviderConfig['provider'] = 'openai') => ({
  enabled: true,
  provider,
  model: 'owner-selected-model',
  ...(provider !== 'local' && { apiKey: 'credential-test-only' }),
  ...(['local', 'openai-compatible'].includes(provider) && {
    baseUrl:
      provider === 'local'
        ? 'http://127.0.0.1:11434/v1/'
        : 'https://gateway.test/prefix/v1/',
  }),
})
function envelope(
  provider: AiProviderConfig['provider'],
  value: unknown = proposals(),
) {
  const text = JSON.stringify(value)
  if (provider === 'openai')
    return {
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ text: 'PRIVATE_THINKING' }] },
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
      content: [
        { type: 'thinking', thinking: 'PRIVATE_THINKING' },
        { type: 'text', text },
      ],
    }
  return {
    choices: [
      { finish_reason: 'stop', message: { role: 'assistant', content: text } },
    ],
  }
}
const response = (
  data: unknown,
  headers: HeadersInit = { 'Content-Type': 'application/json' },
) => new Response(JSON.stringify(data), { headers })
afterEach(() => vi.useRealTimers())

describe('AI context before upload', () => {
  it('copies only bounded text, redacts detected data and keeps identities private', () => {
    const original = step()
    original.title = 'Email person@example.test'
    original.description = 'Use 4111 1111 1111 1111 for billing.'
    const before = structuredClone(original)
    const prepared = prepareAiRewrite([original])
    const body = JSON.stringify(prepared.context)
    for (const forbidden of [
      'person@example.test',
      '4111 1111 1111 1111',
      'PRIVATE_IMAGE',
      'PRIVATE_QUERY',
      'PRIVATE_SELECTOR',
      'private-identity',
    ])
      expect(body).not.toContain(forbidden)
    expect(body).toContain('[REDACTED]')
    expect(prepared.stepIds).toEqual([original.id])
    expect(original).toEqual(before)
    expect(Object.isFrozen(prepared.context.steps[0]!.target)).toBe(true)
    expect(Object.isFrozen(prepared.stepIds)).toBe(true)
  })
  it('never reads values, images, URLs, notes, keys, mask geometry or target selectors', () => {
    const original = step()
    for (const field of [
      'value',
      'screenshot',
      'url',
      'notes',
      'key',
      'redactions',
      'edits',
    ])
      Object.defineProperty(original, field, {
        enumerable: true,
        get: () => {
          throw new Error('Private field accessed')
        },
      })
    for (const field of ['locators', 'rect', 'frame', 'shadowPath'])
      Object.defineProperty(original.target!, field, {
        enumerable: true,
        get: () => {
          throw new Error('Locator accessed')
        },
      })
    expect(() => prepareAiRewrite([original])).not.toThrow()
  })
  it('rejects invalid identities, empty captures, excess steps and pixel data disguised as text', () => {
    for (const input of [
      [],
      [step(), step()],
      [step('')],
      Array.from({ length: 501 }, (_, index) => step(`step-${index}`)),
      [{ ...step(), description: 'data:image/png;base64,PRIVATE' }],
      [{ ...step(), title: 'blob:https://example.test/image' }],
    ])
      expect(() => prepareAiRewrite(input)).toThrow(AiRewriteError)
  })
  it('fails before upload when Unicode context exceeds its byte budget', () => {
    const input = Array.from({ length: 20 }, (_, index) => ({
      ...step(`step-${index}`),
      description: 'a'.repeat(8000),
    }))
    expect(() => prepareAiRewrite(input)).toThrowError(
      new AiRewriteError('input_limit'),
    )
  })
})
describe('untrusted AI proposals', () => {
  it('accepts a reviewed manual merge and a check with an actual recorded expectation', () => {
    const input = [
      step('a'),
      step('b', 2),
      {
        ...step('c', 3),
        expect: { visible: { role: 'heading', name: 'Done' } },
      },
    ]
    const prepared = prepareAiRewrite(input)
    const value = {
      suggestions: [
        {
          kind: 'merge',
          steps: [1, 2],
          title: 'Open settings twice',
          description: 'Complete both recorded actions manually.',
        },
        {
          kind: 'check',
          steps: [3],
          title: 'Verify the result',
          description: 'Check the recorded expected result.',
        },
      ],
    }
    expect(validateAiSuggestions(value, prepared.context)).toEqual(value)
    expect(input).toHaveLength(3)
  })
  it.each([
    { kind: 'rewrite', steps: [2] },
    { kind: 'rewrite', steps: [1, 1] },
    { kind: 'merge', steps: [1] },
    { kind: 'check', steps: [1] },
    { kind: 'rewrite', steps: [1], action: 'fill' },
  ])(
    'rejects unknown, duplicate, unsafe or model-authored actions: %j',
    (change) => {
      const value = {
        suggestions: [{ ...proposals().suggestions[0]!, ...change }],
      }
      expect(() =>
        validateAiSuggestions(value, prepareAiRewrite([step()]).context),
      ).toThrowError(new AiRewriteError('invalid_suggestions'))
    },
  )
  it('rejects nonadjacent, overlapping and section-crossing merges', () => {
    const prepared = prepareAiRewrite([step('a'), step('b', 2), step('c', 3)])
    const first = proposals().suggestions[0]!
    for (const suggestions of [
      [{ ...first, kind: 'merge', steps: [1, 3] }],
      [first, first],
      [
        { ...first, kind: 'merge', steps: [1, 2] },
        { ...first, steps: [2] },
      ],
    ])
      expect(() =>
        validateAiSuggestions({ suggestions }, prepared.context),
      ).toThrow(AiRewriteError)
    const section = prepareAiRewrite([
      step('a'),
      { ...step('b', 2), type: 'section' },
    ])
    expect(() =>
      validateAiSuggestions(
        { suggestions: [{ ...first, kind: 'merge', steps: [1, 2] }] },
        section.context,
      ),
    ).toThrow(AiRewriteError)
  })
  it('keeps rewrite tasks prose-only and never returns model-generated credentials or PII', () => {
    const prepared = prepareAiRewrite([step()], 'rewrite')
    const value = {
      suggestions: [
        {
          ...proposals().suggestions[0]!,
          title: 'Contact person@example.test',
          description: 'credential-test-only',
        },
      ],
    }
    const result = validateAiSuggestions(
      value,
      prepared.context,
      'credential-test-only',
    )
    expect(JSON.stringify(result)).not.toContain('person@example.test')
    expect(JSON.stringify(result)).not.toContain('credential-test-only')
    expect(result.suggestions[0]!.description).toBe('[REDACTED]')
    expect(() =>
      validateAiSuggestions(
        { suggestions: [{ ...proposals().suggestions[0]!, kind: 'check' }] },
        prepared.context,
      ),
    ).toThrow(AiRewriteError)
  })
})
describe('one-request provider transport', () => {
  it.each(['openai', 'anthropic', 'openai-compatible', 'local'] as const)(
    'uses %s protocol without source identities, values, pixels or credential body fields',
    async (provider) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(envelope(provider)))
      const prepared = prepareAiRewrite([step()])
      const result = await rewriteWithAi(prepared, config(provider), { fetch })
      expect(result).toEqual(proposals())
      expect(fetch).toHaveBeenCalledTimes(1)
      const [url, init] = fetch.mock.calls[0]!
      expect(String(url)).toBe(
        provider === 'openai'
          ? 'https://api.openai.com/v1/responses'
          : provider === 'anthropic'
            ? 'https://api.anthropic.com/v1/messages'
            : provider === 'local'
              ? 'http://127.0.0.1:11434/v1/chat/completions'
              : 'https://gateway.test/prefix/v1/chat/completions',
      )
      expect(init).toMatchObject({
        method: 'POST',
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      })
      const headers = new Headers(init!.headers)
      expect(headers.get('Authorization')).toBe(
        provider === 'local' ? null : 'Bearer credential-test-only',
      )
      const body = String(init!.body)
      for (const forbidden of [
        'credential-test-only',
        'PRIVATE_IMAGE',
        'PRIVATE_SELECTOR',
        'private-identity',
        'PRIVATE_QUERY',
      ])
        expect(body).not.toContain(forbidden)
      expect(body).toContain('owner-selected-model')
      const request = JSON.parse(body) as Record<string, unknown>
      expect(request.stream).toBe(false)
      if (provider === 'openai')
        expect(request).toMatchObject({
          store: false,
          max_output_tokens: AI_LIMITS.outputTokens,
          text: { format: { type: 'json_schema', strict: true } },
        })
      if (provider === 'anthropic')
        expect(headers.get('anthropic-version')).toBe('2026-10-21')
    },
  )
  it('is disabled by default without reading context or credentials', async () => {
    const prepared = {
      get context(): never {
        throw new Error('Context accessed')
      },
      stepIds: [],
    }
    const settings = {
      enabled: false,
      get apiKey() {
        throw new Error('Credential accessed')
      },
    }
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      rewriteWithAi(prepared, settings, { fetch }),
    ).rejects.toMatchObject({ code: 'disabled' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('removes the active credential from both captured prose and a successful provider reply', async () => {
    const original = {
      ...step(),
      description: 'Use credential-test-only for this example.',
    }
    const reply = proposals()
    reply.suggestions[0]!.description =
      'The provider echoed credential-test-only.'
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(envelope('openai', reply)))
    const result = await rewriteWithAi(prepareAiRewrite([original]), config(), {
      fetch,
    })
    expect(String(fetch.mock.calls[0]![1]!.body)).not.toContain(
      'credential-test-only',
    )
    expect(JSON.stringify(result)).not.toContain('credential-test-only')
    expect(result.suggestions[0]!.description).toContain('[REDACTED]')
  })
  it('does not send after cancellation occurs during synchronous context preparation', async () => {
    const controller = new AbortController()
    const prepared = prepareAiRewrite([step()])
    const input = {
      get context() {
        controller.abort()
        return prepared.context
      },
      stepIds: prepared.stepIds,
    }
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      rewriteWithAi(input, config(), { fetch, signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([
    { ...config(), baseUrl: 'https://evil.test/' },
    { ...config('openai-compatible'), baseUrl: 'http://remote.test/v1/' },
    { ...config('local'), baseUrl: 'http://169.254.169.254/v1/' },
    { ...config('local'), baseUrl: 'http://localhost.evil.test/v1/' },
    { ...config('local'), baseUrl: 'http://user:password@localhost/v1/' },
    { ...config('local'), baseUrl: 'http://localhost/v1/?token=secret' },
    { ...config('local'), baseUrl: 'http://localhost/v1/#secret' },
    { ...config('local'), baseUrl: 'http://localhost/a%2f/v1/' },
  ])(
    'rejects an unsafe or provider-overridden endpoint before any request',
    async (settings) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      await expect(
        rewriteWithAi(prepareAiRewrite([step()]), settings, { fetch }),
      ).rejects.toMatchObject({ code: 'invalid_config' })
      expect(fetch).not.toHaveBeenCalled()
    },
  )
  it('revalidates the client context and never reads private identity bindings', async () => {
    const prepared = prepareAiRewrite([step()])
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(envelope('openai')))
    await expect(
      rewriteWithAi(
        {
          context: prepared.context,
          get stepIds(): never {
            throw new Error('Private bindings read')
          },
        },
        config(),
        { fetch },
      ),
    ).resolves.toEqual(proposals())
    const forged = {
      ...prepared,
      context: { ...prepared.context, screenshot: 'pixels' },
    }
    await expect(
      rewriteWithAi(forged, config(), { fetch }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const reordered = {
      ...prepared,
      context: {
        ...prepared.context,
        steps: [{ ...prepared.context.steps[0]!, step: 2 }],
      },
    }
    await expect(
      rewriteWithAi(reordered, config(), { fetch }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const oversized = {
      ...prepared,
      context: {
        ...prepared.context,
        steps: Array(501).fill(prepared.context.steps[0]!),
      },
    }
    await expect(
      rewriteWithAi(oversized, config(), { fetch }),
    ).rejects.toMatchObject({ code: 'input_limit' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([401, 429, 500, 302])(
    'does not retry or expose a %s error body',
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response('PRIVATE_PROVIDER_ERROR credential-test-only', {
          status,
        }),
      )
      await expect(
        rewriteWithAi(prepareAiRewrite([step()]), config(), { fetch }),
      ).rejects.toEqual(new AiRewriteError('provider_failed'))
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )
  it('sanitizes native exceptions without retaining their cause', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(
        new Error('PRIVATE_PROVIDER_ERROR credential-test-only'),
      )
    const error = await rewriteWithAi(prepareAiRewrite([step()]), config(), {
      fetch,
    }).catch((error: unknown) => error)
    expect(error).toEqual(new AiRewriteError('provider_failed'))
    expect(JSON.stringify(error)).not.toContain('credential-test-only')
    expect(error).not.toHaveProperty('cause')
  })
  it.each([
    { status: 'incomplete', output: [] },
    {
      status: 'completed',
      output: [{ type: 'function_call', arguments: 'PRIVATE' }],
    },
    {
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'refusal', refusal: 'No' }],
        },
      ],
    },
  ])('rejects incomplete, tool and refused Responses results', async (data) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(response(data))
    await expect(
      rewriteWithAi(prepareAiRewrite([step()]), config(), { fetch }),
    ).rejects.toMatchObject({ code: 'invalid_response' })
  })
  it('rejects truncated chat and Claude results, malformed JSON and invented step actions', async () => {
    for (const [provider, data] of [
      ['anthropic', { ...envelope('anthropic'), stop_reason: 'max_tokens' }],
      [
        'local',
        {
          choices: [
            {
              finish_reason: 'length',
              message: { role: 'assistant', content: '{}' },
            },
          ],
        },
      ],
      [
        'openai',
        {
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'not JSON' }],
            },
          ],
        },
      ],
    ] as const) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(response(data))
      await expect(
        rewriteWithAi(prepareAiRewrite([step()]), config(provider), { fetch }),
      ).rejects.toMatchObject({ code: 'invalid_response' })
    }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      response(
        envelope('openai', {
          suggestions: [{ ...proposals().suggestions[0]!, action: 'fill' }],
        }),
      ),
    )
    await expect(
      rewriteWithAi(prepareAiRewrite([step()]), config(), { fetch }),
    ).rejects.toMatchObject({ code: 'invalid_suggestions' })
  })
  it('bounds declared and actual body bytes and rejects malformed UTF-8 and media types', async () => {
    for (const reply of [
      response(
        {},
        {
          'Content-Type': 'application/json',
          'Content-Length': String(AI_LIMITS.responseBytes + 1),
        },
      ),
      new Response(new Uint8Array(AI_LIMITS.responseBytes + 1), {
        headers: { 'Content-Type': 'application/json' },
      }),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply)
      await expect(
        rewriteWithAi(prepareAiRewrite([step()]), config(), { fetch }),
      ).rejects.toMatchObject({ code: 'response_limit' })
    }
    for (const reply of [
      new Response(new Uint8Array([0xc3, 0x28]), {
        headers: { 'Content-Type': 'application/json' },
      }),
      response({}, { 'Content-Type': 'text/html' }),
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply)
      await expect(
        rewriteWithAi(prepareAiRewrite([step()]), config(), { fetch }),
      ).rejects.toMatchObject({ code: 'invalid_response' })
    }
  })
  it('bounds unresponsive fetches and discards late replies', async () => {
    vi.useFakeTimers()
    let release: ((value: Response) => void) | undefined
    const fetch = vi.fn<typeof globalThis.fetch>(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const success = vi.fn()
    const pending = rewriteWithAi(prepareAiRewrite([step()]), config(), {
      fetch,
    })
    void pending.then(success, () => {})
    const failed = expect(pending).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(AI_LIMITS.timeoutMs)
    await failed
    release!(response(envelope('openai')))
    await vi.runAllTimersAsync()
    expect(success).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('cancels a stalled response body at the same request deadline', async () => {
    vi.useFakeTimers()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
      },
      cancel,
    })
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        new Response(body, { headers: { 'Content-Type': 'application/json' } }),
      )
    const failed = expect(
      rewriteWithAi(prepareAiRewrite([step()]), config(), { fetch }),
    ).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(AI_LIMITS.timeoutMs)
    await failed
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('honors cancellation before credential/context reads and while a provider ignores abort', async () => {
    const aborted = new AbortController()
    aborted.abort('PRIVATE_REASON')
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}))
    await expect(
      rewriteWithAi(prepareAiRewrite([step()]), config(), {
        fetch,
        signal: aborted.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(fetch).not.toHaveBeenCalled()
    const controller = new AbortController()
    const pending = rewriteWithAi(prepareAiRewrite([step()]), config(), {
      fetch,
      signal: controller.signal,
    })
    const failed = expect(pending).rejects.toEqual(
      new AiRewriteError('cancelled'),
    )
    controller.abort('PRIVATE_REASON')
    await failed
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

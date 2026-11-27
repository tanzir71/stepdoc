import { describe, expect, it } from 'vitest'
import Ajv from 'ajv'
import {
  AI_LIMITS,
  aiContextSchema,
  aiProviderConfigSchema,
  aiSuggestionsJsonSchema,
  aiSuggestionsSchema,
} from '../src/ai'

const suggestion = {
  kind: 'rewrite',
  steps: [1],
  title: 'Open settings',
  description: 'Choose Settings.',
}
describe('internal AI text contract', () => {
  it('matches the provider JSON schema for normal and Unicode suggestions', () => {
    const validate = new Ajv().compile(aiSuggestionsJsonSchema)
    for (const title of ['Open settings', '😀'.repeat(200)]) {
      const input = { suggestions: [{ ...suggestion, title }] }
      expect(validate(input)).toBe(true)
      expect(aiSuggestionsSchema.safeParse(input).success).toBe(true)
    }
    const input = { suggestions: [{ ...suggestion, title: '😀'.repeat(201) }] }
    expect(validate(input)).toBe(false)
    expect(aiSuggestionsSchema.safeParse(input).success).toBe(false)
  })
  it.each(['action', 'value', 'target', 'screenshot', 'verification'])(
    'rejects model-authored %s fields',
    (field) => {
      const input = { suggestions: [{ ...suggestion, [field]: 'not allowed' }] }
      expect(aiSuggestionsSchema.safeParse(input).success).toBe(false)
      expect(new Ajv().compile(aiSuggestionsJsonSchema)(input)).toBe(false)
    },
  )
  it('bounds proposal count, source ordinals and text', () => {
    for (const suggestions of [
      Array(AI_LIMITS.suggestions + 1).fill(suggestion),
      [{ ...suggestion, steps: [0] }],
      [{ ...suggestion, steps: [501] }],
      [{ ...suggestion, description: 'x'.repeat(AI_LIMITS.description + 1) }],
    ])
      expect(aiSuggestionsSchema.safeParse({ suggestions }).success).toBe(false)
  })
  it('rejects image or extra context fields before a provider serialization', () => {
    const step = {
      step: 1,
      type: 'action',
      action: 'click',
      title: 'Open',
      description: '',
      target: { role: 'button', name: 'Open' },
      hasExpectedResult: false,
    }
    const input = {
      schema: 'stepdoc/ai-context@1',
      task: 'cleanup',
      steps: [step],
    }
    expect(aiContextSchema.safeParse(input).success).toBe(true)
    expect(
      aiContextSchema.safeParse({ ...input, screenshot: 'pixels' }).success,
    ).toBe(false)
    expect(
      aiContextSchema.safeParse({
        ...input,
        steps: [{ ...step, value: 'private' }],
      }).success,
    ).toBe(false)
  })
  it('defaults to disabled and rejects credentials with header control characters', () => {
    expect(
      aiProviderConfigSchema.parse({
        provider: 'openai',
        model: 'owner-selected',
      }).enabled,
    ).toBe(false)
    expect(
      aiProviderConfigSchema.safeParse({
        enabled: true,
        provider: 'openai',
        model: 'owner-selected',
        apiKey: 'key\r\nHeader:value',
      }).success,
    ).toBe(false)
  })
})

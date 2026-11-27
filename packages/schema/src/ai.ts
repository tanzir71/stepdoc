import { z } from 'zod'
import { stepSchema } from './guide'

// Internal provider transport, not guide data or the public Storage API.
export const AI_LIMITS = Object.freeze({
  steps: 500,
  suggestions: 100,
  contextBytes: 128 * 1024,
  responseBytes: 512 * 1024,
  sourceTitle: 4096,
  sourceDescription: 8192,
  sourceName: 1024,
  title: 200,
  description: 2000,
  timeoutMs: 30_000,
  outputTokens: 4096,
})
const ordinal = z.number().int().min(1).max(AI_LIMITS.steps)
const bounded = (maximum: number) =>
  z
    .string()
    .refine(
      (value) => value.length <= maximum * 2 && [...value].length <= maximum,
      `Must contain at most ${maximum} characters`,
    )
export const aiContextSchema = z.strictObject({
  schema: z.literal('stepdoc/ai-context@1'),
  task: z.enum(['cleanup', 'rewrite']),
  steps: z
    .array(
      z.strictObject({
        step: ordinal,
        type: stepSchema.shape.type,
        action: stepSchema.shape.action,
        title: bounded(AI_LIMITS.sourceTitle).min(1),
        description: bounded(AI_LIMITS.sourceDescription),
        target: z.strictObject({
          role: bounded(80),
          name: bounded(AI_LIMITS.sourceName),
        }),
        hasExpectedResult: z.boolean(),
      }),
    )
    .min(1)
    .max(AI_LIMITS.steps),
})
export type AiContext = z.output<typeof aiContextSchema>
export const aiSuggestionSchema = z.strictObject({
  kind: z.enum(['rewrite', 'merge', 'check']),
  steps: z.array(ordinal).min(1).max(AI_LIMITS.steps),
  title: bounded(AI_LIMITS.title).trim().min(1),
  description: bounded(AI_LIMITS.description),
})
export const aiSuggestionsSchema = z.strictObject({
  suggestions: z.array(aiSuggestionSchema).max(AI_LIMITS.suggestions),
})
export type AiSuggestion = z.output<typeof aiSuggestionSchema>
export type AiSuggestions = z.output<typeof aiSuggestionsSchema>

// Supplied from private trusted settings at call time; never bundled or returned.
export const aiProviderConfigSchema = z.strictObject({
  enabled: z.boolean().default(false),
  provider: z.enum(['openai', 'anthropic', 'openai-compatible', 'local']),
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
  apiKey: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[!-~]+$/)
    .optional(),
  baseUrl: z.string().min(1).max(2048).optional(),
})
export type AiProviderConfig = z.output<typeof aiProviderConfigSchema>

// All fields required, no additional properties: supported provider JSON subset.
export const aiSuggestionsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['suggestions'],
  properties: {
    suggestions: {
      type: 'array',
      maxItems: AI_LIMITS.suggestions,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'steps', 'title', 'description'],
        properties: {
          kind: { type: 'string', enum: ['rewrite', 'merge', 'check'] },
          steps: {
            type: 'array',
            minItems: 1,
            maxItems: AI_LIMITS.steps,
            items: { type: 'integer', minimum: 1, maximum: AI_LIMITS.steps },
          },
          title: { type: 'string', minLength: 1, maxLength: AI_LIMITS.title },
          description: { type: 'string', maxLength: AI_LIMITS.description },
        },
      },
    },
  },
} as const

// Validated projections of provider envelopes; metadata and thinking are omitted.
const text = z.string().min(1).max(AI_LIMITS.responseBytes)
export const aiResponsesEnvelopeSchema = z.object({
  status: z.literal('completed'),
  error: z.null().optional(),
  incomplete_details: z.null().optional(),
  output: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('reasoning') }),
        z.object({
          type: z.literal('message'),
          role: z.literal('assistant'),
          status: z.literal('completed'),
          content: z
            .array(z.object({ type: z.literal('output_text'), text }))
            .length(1),
        }),
      ]),
    )
    .min(1)
    .max(8),
})
export const aiMessagesEnvelopeSchema = z.object({
  type: z.literal('message'),
  role: z.literal('assistant'),
  stop_reason: z.literal('end_turn'),
  content: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text }),
        z.object({ type: z.enum(['thinking', 'redacted_thinking']) }),
      ]),
    )
    .min(1)
    .max(8),
})
export const aiCompletionsEnvelopeSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal('stop'),
        message: z.object({
          role: z.literal('assistant'),
          content: text,
          refusal: z.null().optional(),
          tool_calls: z.array(z.unknown()).length(0).optional(),
          function_call: z.null().optional(),
        }),
      }),
    )
    .length(1),
})

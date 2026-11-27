import type { Step } from '@stepdoc/schema'
import {
  AI_LIMITS,
  aiContextSchema,
  aiSuggestionsSchema,
  type AiContext,
  type AiSuggestions,
} from '@stepdoc/schema/ai'
import { createRedactionDetector, redactSensitiveText } from '../redaction'
import { AiRewriteError } from './errors'

let detector: ReturnType<typeof createRedactionDetector> | undefined
export function aiText(value: unknown, maximum: number, credential?: string) {
  if (typeof value !== 'string') throw new AiRewriteError('invalid_input')
  if (value.length > maximum * 2 || [...value].length > maximum)
    throw new AiRewriteError('input_limit')
  if (/\b(?:data|blob):/i.test(value)) throw new AiRewriteError('invalid_input')
  try {
    let text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
    if (credential) text = text.split(credential).join('[REDACTED]')
    detector ??= createRedactionDetector()
    return redactSensitiveText(text, detector(text))
  } catch (error) {
    if (error instanceof AiRewriteError) throw error
    throw new AiRewriteError('invalid_input')
  }
}
export interface PreparedAiRewrite {
  readonly context: AiContext
  // Opaque provider ordinals bind back to identities only in the caller's process.
  readonly stepIds: readonly string[]
}

/** Run in the client before upload; intentionally do not parse/clone a full step. */
export function prepareAiRewrite(
  steps: readonly Step[],
  task: AiContext['task'] = 'cleanup',
): PreparedAiRewrite {
  try {
    if (!Array.isArray(steps) || !steps.length)
      throw new AiRewriteError('invalid_input')
    if (steps.length > AI_LIMITS.steps) throw new AiRewriteError('input_limit')
    const stepIds: string[] = []
    const projected = steps.map((step, index) => {
      if (
        typeof step.id !== 'string' ||
        !step.id ||
        step.id.length > 200 ||
        stepIds.includes(step.id)
      )
        throw new AiRewriteError('invalid_input')
      stepIds.push(step.id)
      const expected = step.expect
      return {
        step: index + 1,
        type: step.type,
        action: step.action,
        title: aiText(step.title, AI_LIMITS.sourceTitle),
        description: aiText(
          step.description ?? '',
          AI_LIMITS.sourceDescription,
        ),
        target: {
          role: aiText(step.target?.role ?? '', 80),
          name: aiText(step.target?.name ?? '', AI_LIMITS.sourceName),
        },
        hasExpectedResult: !!(
          expected?.urlMatches?.trim() ||
          expected?.visible?.role ||
          expected?.visible?.name ||
          expected?.hidden?.role ||
          expected?.hidden?.name ||
          expected?.text?.contains
        ),
      }
    })
    const context = aiContextSchema.parse({
      schema: 'stepdoc/ai-context@1',
      task,
      steps: projected,
    })
    if (
      new TextEncoder().encode(JSON.stringify(context)).byteLength >
      AI_LIMITS.contextBytes
    )
      throw new AiRewriteError('input_limit')
    for (const step of context.steps) {
      Object.freeze(step.target)
      Object.freeze(step)
    }
    Object.freeze(context.steps)
    Object.freeze(context)
    return Object.freeze({ context, stepIds: Object.freeze(stepIds) })
  } catch (error) {
    if (error instanceof AiRewriteError) throw error
    throw new AiRewriteError('invalid_input')
  }
}

/** Validate untrusted model proposals. Does not modify a guide or apply any action. */
export function validateAiSuggestions(
  input: unknown,
  context: AiContext,
  credential?: string,
): AiSuggestions {
  try {
    const parsed = aiSuggestionsSchema.parse(input)
    const used = new Set<number>()
    for (const suggestion of parsed.suggestions) {
      const indices = suggestion.steps
      if (
        (context.task === 'rewrite' && suggestion.kind !== 'rewrite') ||
        (suggestion.kind === 'merge'
          ? indices.length < 2
          : indices.length !== 1)
      )
        throw new AiRewriteError('invalid_suggestions')
      for (const [offset, ordinal] of indices.entries()) {
        const source = context.steps[ordinal - 1]
        if (
          !source ||
          source.step !== ordinal ||
          used.has(ordinal) ||
          (offset > 0 && ordinal !== indices[offset - 1]! + 1) ||
          (suggestion.kind === 'merge' && source.type === 'section') ||
          (suggestion.kind === 'check' &&
            (!source.hasExpectedResult || source.type === 'section'))
        )
          throw new AiRewriteError('invalid_suggestions')
        used.add(ordinal)
      }
      suggestion.title = aiText(suggestion.title, AI_LIMITS.title, credential)
      suggestion.description = aiText(
        suggestion.description,
        AI_LIMITS.description,
        credential,
      )
      if (!suggestion.title) throw new AiRewriteError('invalid_suggestions')
    }
    return aiSuggestionsSchema.parse(parsed)
  } catch {
    throw new AiRewriteError('invalid_suggestions')
  }
}

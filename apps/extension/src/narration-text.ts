import {
  createRedactionDetector,
  redactSensitiveText,
} from '@stepdoc/core/redaction'

const detect = createRedactionDetector()

/** Run before any transcript crosses a runtime/storage boundary. Never log input. */
export function narrationText(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 4000) return null
  const text = input.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()
  if (!text) return null
  try {
    return redactSensitiveText(text, detect(text))
  } catch {
    return null
  }
}

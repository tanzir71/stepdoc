export type AiErrorCode =
  | 'disabled'
  | 'invalid_config'
  | 'invalid_input'
  | 'input_limit'
  | 'cancelled'
  | 'timeout'
  | 'provider_failed'
  | 'response_limit'
  | 'invalid_response'
  | 'invalid_suggestions'

/** Never attach a provider body, credential, original exception or cause. */
export class AiRewriteError extends Error {
  constructor(public readonly code: AiErrorCode) {
    super(`AI rewrite failed: ${code}`)
    this.name = 'AiRewriteError'
  }
}

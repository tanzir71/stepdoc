# Shared AI rewrite provider pipeline

Implemented on 28 Nov 2026 as the provider prerequisite for M11/M15. This is an
operational shared library, with real HTTP requests verified against local
provider stand-ins. The application settings, private credential persistence,
Storage API handlers and W03/E04 UI integration remain open. The existing
offline cleanup review remains the available application feature.

`@stepdoc/core/ai` exports `prepareAiRewrite`, `rewriteWithAi`,
`validateAiSuggestions` and `AiRewriteError`. `@stepdoc/schema/ai` owns the
internal text context, proposal/config schemas, provider envelope projections,
JSON Schema for structured output, and resource limits. These are not new guide
fields or a public `/ai/rewrite` payload. The reserved public endpoints are
unchanged; their contract and all three implementations must be completed
together when integrated.

## Client preparation and server invocation

Call `prepareAiRewrite(steps, 'cleanup' | 'rewrite')` in the client before an
upload. It reads only step identity, type/action, title/description, target
role/name and whether a recorded expectation exists. It never reads values,
screenshots, notes, keypress arguments, locators, frame/shadow paths, coordinates
or page URLs.
Detected email, phone, card, IBAN, token and IP/MAC text is masked with the existing
detectors. Inline `data:`/`blob:` payloads are rejected. A failure produces a
fixed error and no provider request.

Providers receive ordinal numbers instead of source IDs. The frozen `stepIds`
binding stays local and is not read by the transport. The caller must retain the
original guide version or capture revision, recheck that source before applying,
and rebind ordinals through those identities. No output is applied automatically.

`rewriteWithAi(prepared, privateConfig, { signal })` belongs in a server/worker
integration with already-authorized, trusted settings. It revalidates and
redacts the text context again, including any occurrence of the active key.
It accepts only explicit `enabled: true`; otherwise it performs no request and
does not read context or credentials. No model is selected automatically.

Private configuration contains `provider`, an owner-selected `model`, and an
`apiKey` where required. OpenAI and Anthropic use their fixed HTTPS endpoints.
`openai-compatible` requires a key and explicit HTTPS `baseUrl`; `local` permits
an optional key, HTTPS, or HTTP on loopback. Supply a complete API base such as
`http://127.0.0.1:11434/v1/`; prefixes are retained. URL credentials, query,
fragment, backslash/control characters and encoded path separators are rejected.
Settings authorization, encryption at rest and server egress policy remain the
responsibility of the server integration; this library does not persist keys.

## Proposals and transport boundaries

Each model suggestion contains only `kind`, numeric `steps`, `title` and
`description`. A `rewrite` changes prose. A `merge` names consecutive steps and
represents an explicitly reviewed manual instruction with its first screenshot;
it cannot cross a section. A `check` references one source with a recorded
expected result, retaining its original action. The application must derive the
actual check from the retained source, never from model-authored replay data.

Unknown fields, model-authored actions/targets/values/images/verification,
unknown or repeated ordinals, overlapping proposals, nonadjacent merges,
unsupported checks and non-rewrite proposals for a rewrite task are rejected.
Successful prose is rechecked for detected sensitive text and the active key.

| Resource                       |                           Limit |
| ------------------------------ | ------------------------------: |
| Source steps                   |                             500 |
| Serialized text context        |                         128 KiB |
| Suggestions                    |                             100 |
| Suggested title / description  | 200 / 2,000 Unicode code points |
| Response bytes                 |                         512 KiB |
| Provider output tokens         |                           4,096 |
| Request and body-read deadline |                      30 seconds |

There is one attempt, with no retries, redirects, cookies or referrer. OpenAI
uses Responses with `store: false` and strict JSON Schema output. Anthropic
uses Messages with the documented `2026-10-21` version and bearer authentication.
Compatible/local providers use Chat Completions JSON mode. No tool, file or
image inputs are configured. Reasoning metadata is discarded; only a completed
assistant text result is parsed. Refusals, truncation, tool requests, malformed
JSON/UTF-8, bad media types and oversized bodies fail closed. The same deadline
covers headers and streaming bodies. Caller cancellation closes a stalled
stream, and late results cannot fulfill an already-cancelled/timed-out call.
Errors contain a fixed code/message, with no provider body, key or original cause.

## Automated evidence

```powershell
pnpm --filter @stepdoc/schema exec vitest run tests/ai.test.ts
pnpm --filter @stepdoc/core exec vitest run tests/ai.test.ts
pnpm --filter @stepdoc/core exec node tests/ai.verify.mjs
```

Nine schema checks compare the JSON Schema/Zod behavior, including Unicode and
forbidden fields. Forty-one core checks cover throwing private-field getters,
redaction, limits, configuration/endpoint handling, all protocols, untrusted
results, credential echoes, cancellation races, stalled fetches/bodies and late
replies. The native verifier runs all four protocols through real local HTTP
fixtures, including chunked Unicode, error/redirect refusal, one-attempt counts
and aborted stream closure. It also prepares context in a strict-CSP Chromium
module worker, with throwing value/image getters and zero provider requests
while disabled. This verifier is included in `pnpm verify`; no live AI service
or owner action is part of acceptance.

Protocol sources checked on 28 Nov 2026:

- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [Claude Messages API](https://platform.claude.com/docs/en/api/http/beta/messages/create)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

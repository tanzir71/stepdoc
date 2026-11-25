# @stepdoc/core

Pure guide logic shared by the extension, SPA, exporters and replay tools.

- `describeStep(metadata)` keeps the v1 capture wording. `describeGuideStep(step)`
  generates instructions from guide@1 actions and accessible names. Fill/upload
  value payloads are never read; legacy input/textarea innerText is ignored.
  Missing labels/options/keys are flagged.
- `buildSelector(element)` supplies an escaped CSS fallback within the element's
  document or shadow root. IDs/test IDs must identify that exact element uniquely;
  duplicate names get sibling positions. It never reads input values.
- `rankLocators(candidates, countMatches?)` returns normalized, deduplicated copies.
  It prefers unique, exact matches, then role+name, test ID and accessible labels,
  with CSS/XPath as fallbacks. A local resolver supplies counts within the target's
  frame/shadow root: zero matches are removed, one is unique, multiple are ambiguous.
  Without a resolver, absent uniqueness stays unverified. Syntax errors discard the
  affected locator; unrelated resolver errors propagate. Ties retain capture order.
- `isFragileLocator(locator)` identifies structural, partial, unnamed, ambiguous or
  unverified locators for the inspector's review badge.

The v1 shared package forwards its text/selector imports to this implementation
until the remaining shared schemas are folded into `@stepdoc/schema` during M9.
The complete guide@1 capture pipeline, frame chain and accessible-name collection
are scheduled for M11; callers supply semantic locator candidates and counts here.

Run `pnpm --filter @stepdoc/core test` for rules, privacy and DOM regression checks.

import { expect } from '@playwright/test'

// Chromium's worker event precedes extension API binding initialization.
export async function extensionWorker(context) {
  let worker = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith('chrome-extension://'))
  worker ??= await context.waitForEvent('serviceworker', {
    predicate: (worker) => worker.url().startsWith('chrome-extension://'),
  })
  // A real extension-page message activates the worker. Evaluating an idle
  // worker target alone need not wake it or finish its extension bindings.
  const bootstrap = await context.newPage()
  try {
    await bootstrap.goto(new URL('options.html', worker.url()).href)
    await expect
      .poll(
        () =>
          bootstrap.evaluate(() =>
            chrome.runtime.sendMessage({ type: 'GET_STATE' }).then(
              () => true,
              () => false,
            ),
          ),
        { timeout: 15_000 },
      )
      .toBe(true)
    worker =
      context
        .serviceWorkers()
        .filter((candidate) =>
          candidate.url().startsWith('chrome-extension://'),
        )
        .at(-1) ?? worker
    await expect
      .poll(
        () =>
          worker.evaluate(
            () =>
              !!globalThis.chrome?.runtime?.id &&
              !!chrome.storage?.local &&
              typeof chrome.tabs?.query === 'function',
          ),
        { timeout: 15_000 },
      )
      .toBe(true)
  } finally {
    await bootstrap.close()
  }
  return worker
}

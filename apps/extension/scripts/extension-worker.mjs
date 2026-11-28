import { expect } from '@playwright/test'

// Chromium's worker event precedes extension API binding initialization.
export async function extensionWorker(context) {
  let worker = context
    .serviceWorkers()
    .find((worker) => worker.url().startsWith('chrome-extension://'))
  // A cold MV3 worker need not emit an event until its extension is used. Read
  // the installed identity from Chromium, then wake its real private page. Keep
  // discovery, activation and worker observation inside the old startup budget.
  const deadline = Date.now() + 30_000
  const budget = () => Math.max(1, Math.min(15_000, deadline - Date.now()))
  // A real extension-page message activates the worker. Evaluating an idle
  // worker target alone need not wake it or finish its extension bindings.
  const bootstrap = await context.newPage()
  try {
    let origin
    if (worker) {
      const url = new URL(worker.url())
      origin = `${url.protocol}//${url.host}`
    } else {
      await bootstrap.goto('chrome://extensions/', { timeout: budget() })
      let installed = []
      await expect
        .poll(
          async () => {
            installed = await bootstrap.evaluate(() => {
              const list = document
                .querySelector('extensions-manager')
                ?.shadowRoot?.querySelector('extensions-item-list')
              return [
                ...(list?.shadowRoot?.querySelectorAll('extensions-item') ??
                  []),
              ]
                .map((item) => ({ id: item.id, name: item.data?.name }))
                .filter(
                  (item) =>
                    item.name === 'StepDoc Capture' &&
                    /^[a-p]{32}$/.test(item.id),
                )
            })
            return installed.length
          },
          { timeout: budget() },
        )
        .toBe(1)
      origin = `chrome-extension://${installed[0].id}`
    }
    await bootstrap.goto(`${origin}/options.html`, { timeout: budget() })
    await expect
      .poll(
        () =>
          bootstrap.evaluate(() =>
            chrome.runtime.sendMessage({ type: 'GET_STATE' }).then(
              () => true,
              () => false,
            ),
          ),
        { timeout: budget() },
      )
      .toBe(true)
    await expect
      .poll(
        () => {
          worker = context
            .serviceWorkers()
            .filter((candidate) => candidate.url().startsWith(`${origin}/`))
            .at(-1)
          return !!worker
        },
        { timeout: budget() },
      )
      .toBe(true)
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

import { test, expect, type Locator, type Page } from '@playwright/test';

// Runtime variables: none.
// Run with a local authenticated browser context when preconditions require one.
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
// Close pages before fixture teardown so failure context snapshots cannot retain input.
test.afterEach(async ({ context }) => {
  await Promise.all(context.pages().map((page) => page.close()));
});

function readVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error('Required replay variable is missing');
  return value;
}

function matchesUrl(input: URL, expected: string): boolean {
  const url = new URL(input.href);
  url.username = url.password = url.search = url.hash = '';
  if (expected.startsWith('/')) return url.pathname.startsWith(expected);
  if (/^https?:\/\//i.test(expected)) return url.href === expected;
  return new RegExp(expected).test(url.href);
}

async function resolveTarget(candidates: Array<() => Locator>): Promise<Locator> {
  let target: Locator | undefined;
  await expect(async () => {
    for (const create of candidates) {
      try {
        const candidate = create();
        if (await candidate.count() === 1 && await candidate.isVisible()) {
          target = candidate;
          return;
        }
      } catch { /* Invalid/stale selectors must not suppress usable fallbacks. */ }
    }
    throw new Error('No unique visible target');
  }).toPass({ timeout: 5000 });
  if (!target) throw new Error('No unique visible target');
  return target;
}

test("Upgrade the workspace to Team", async ({ page }) => {


  await test.step("1. Go to app.ledgerly.io/settings", async () => {
    try {
      await page.goto("https://app.ledgerly.io/settings");
    } catch {
      // Native call logs can contain runtime input. Never attach the original error.
      throw new Error("Step 1 failed or is not replayable");
    }
  });
  await test.step("2. Click \"Billing\" in the sidebar", async () => {
    try {
      const target = await resolveTarget([() => page.getByRole("link" as Parameters<Page['getByRole']>[0], { name: "Billing", exact: true })]);
      await target.click();
      await expect(page).toHaveURL((url) => matchesUrl(url, "/settings/billing"));
    } catch {
      // Native call logs can contain runtime input. Never attach the original error.
      throw new Error("Step 2 failed or is not replayable");
    }
  });
  await test.step("3. Click \"Change plan\"", async () => {
    try {
      const target = await resolveTarget([() => page.getByRole("button" as Parameters<Page['getByRole']>[0], { name: "Change plan", exact: true }), () => page.getByTestId("billing-change-plan")]);
      await target.click();
      await expect(page.getByRole("dialog" as Parameters<Page['getByRole']>[0], { name: "Choose a plan", exact: true })).toBeVisible();
    } catch {
      // Native call logs can contain runtime input. Never attach the original error.
      throw new Error("Step 3 failed or is not replayable");
    }
  });
});

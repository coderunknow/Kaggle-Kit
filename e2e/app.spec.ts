import { expect, test, type Page } from '@playwright/test';

/**
 * Browser-level coverage of the built app: profile setup, a chat round trip,
 * settings keyboard behaviour, and the tool approval lifecycle (probe →
 * tool chat → deny) against the deterministic mock upstream.
 */
const MOCK_BASE_URL = 'http://127.0.0.1:18200';

async function openSettings(page: Page) {
  await page.locator('header.topbar').getByRole('button', { name: /^settings$/i }).click();
  return page.getByRole('dialog', { name: /^settings$/i });
}

async function createProfile(page: Page) {
  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: /add profile/i }).click();
  await dialog.getByLabel(/display name/i).fill('Mock upstream');
  await dialog.getByLabel(/base url/i).fill(MOCK_BASE_URL);
  await dialog.getByLabel(/api key/i).fill('e2e-test-key');
  await dialog.getByRole('button', { name: /test connection/i }).click();
  await expect(dialog.getByText(/^connected$/i)).toBeVisible();
  await dialog.getByRole('button', { name: /save profile/i }).click();
  await dialog.getByRole('button', { name: /close settings/i }).click();
}

async function startConversation(page: Page, text: string) {
  await page
    .getByRole('complementary', { name: /conversations/i })
    .getByRole('button', { name: /^new conversation$/i })
    .click();
  await page.getByLabel(/^message$/i).fill(text);
  await page.getByRole('button', { name: /^send$/i }).click();
}

test('creates a profile and completes an ordinary chat round trip', async ({ page }) => {
  await createProfile(page);
  await startConversation(page, 'Hello from the browser test');
  await expect(page.getByText(/Mock answer for: Hello from the browser test/)).toBeVisible();
});

test('settings dialog closes with Escape and move focus out of the dialog', async ({ page }) => {
  await page.goto('/');
  const dialog = await openSettings(page);
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const focusInsideDialog = await page.evaluate(
    () => document.activeElement?.closest('[role="dialog"]') !== null,
  );
  expect(focusInsideDialog).toBe(false);
});

test('runs a safe tool automatically and lets the user deny risky code', async ({ page }) => {
  await createProfile(page);

  // Configure tools through the real settings UI: probe, enable the loop,
  // allow the calculator, and pin a (deliberately unavailable) sandbox image.
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: /tools & approvals/i }).click();
  await dialog.getByRole('button', { name: /verify native tool calling/i }).click();
  await expect(dialog.getByText('supported_verified')).toBeVisible();
  await dialog.getByLabel(/enable the server-side tool loop/i).check();
  await dialog.getByLabel(/calculate an expression/i).check();
  await dialog
    .getByLabel(/digest-pinned image/i)
    .fill(`python:3.12-alpine@sha256:${'7'.repeat(64)}`);
  await dialog.getByLabel(/allow the model to request python execution/i).check();
  await dialog.getByRole('button', { name: /save tool settings/i }).click();
  await dialog.getByRole('button', { name: /close settings/i }).click();

  await startConversation(page, 'calculate: 2+3');
  await expect(page.getByText(/Tool result received/)).toBeVisible();

  await page.getByLabel(/^message$/i).fill('run code: print(1)');
  await page.getByRole('button', { name: /^send$/i }).click();
  const deny = page.getByRole('button', { name: /^deny$/i });
  await expect(deny).toBeVisible();
  await expect(page.getByRole('button', { name: /approve once/i })).toBeVisible();
  // The approval describes the concrete operation before anything runs.
  await expect(page.getByText(/Run Python code in the sandbox/)).toBeVisible();
  await deny.click();
  await expect(page.getByText(/Tool result received/)).toHaveCount(2);
  await expect(page.getByText(/The user denied this exact operation/)).toHaveCount(1);
});

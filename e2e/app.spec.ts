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
  await dialog.getByRole('checkbox', { name: /advanced mode/i }).check();
  await dialog.getByRole('tab', { name: /tools & approvals/i }).click();
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
  // The denial is recorded in the timeline and echoed into the mock answer.
  await expect(page.getByText(/The user denied this exact operation/).first()).toBeAttached();
});


test('Basic/Advanced keeps unsaved input and renders at 360px without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  const dialog = await openSettings(page);
  await dialog.getByRole('button', { name: /add profile/i }).click();
  await expect(dialog.getByRole('region', { name: /guided connection setup/i })).toBeVisible();
  await dialog.getByLabel(/display name/i).fill('Keep this draft');
  const mode = dialog.getByRole('checkbox', { name: /advanced mode/i });
  await mode.check();
  await dialog.getByLabel(/^system prompt$/i).fill('Preserved instructions');
  await mode.uncheck();
  await expect(dialog.getByLabel(/^system prompt$/i)).toBeHidden();
  await mode.check();
  await expect(dialog.getByLabel(/^system prompt$/i)).toHaveValue('Preserved instructions');
  await expect(dialog.getByLabel(/display name/i)).toHaveValue('Keep this draft');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('grants reviewed built-ins in Basic mode and executes a calculator through the real tool loop', async ({ page }) => {
  await createProfile(page);
  const dialog = await openSettings(page);
  await dialog.getByRole('tab', { name: /tools & approvals/i }).click();
  await expect(dialog.getByRole('checkbox', { name: /allow the model to request python/i })).toHaveCount(0);
  await dialog.getByRole('button', { name: /allow reviewed keyless built-ins/i }).click();
  await expect(dialog.getByText(/7 tool\(s\) selected/)).toBeVisible();
  await dialog.getByRole('button', { name: /save tool settings/i }).click();
  await dialog.getByRole('button', { name: /verify native tool calling/i }).click();
  await expect(dialog.getByText('supported_verified')).toBeVisible();
  await dialog.getByRole('button', { name: /close settings/i }).click();
  await startConversation(page, 'calculate: 12*7');
  await expect(page.getByText(/Tool result received/)).toBeVisible();
  await page.locator('summary').filter({ hasText: /Tool activity/ }).click();
  await expect(page.getByText(/Result: 84/)).toBeVisible();
});

test('shows streamed words before the answer is complete', async ({ page }) => {
  await createProfile(page);

  // Verify streaming against the real probe, then enable it for the profile.
  const dialog = await openSettings(page);
  await dialog.getByRole('tab', { name: /^inference$/i }).click();
  await dialog.getByRole('button', { name: /verify streaming support/i }).click();
  await expect(dialog.getByText(/^streaming verified$/i)).toBeVisible();
  await dialog.getByRole('checkbox', { name: /stream the answer/i }).check();
  await dialog.getByRole('button', { name: /save parameters/i }).click();
  await dialog.getByRole('button', { name: /close settings/i }).click();

  // The mock writes six words 200 ms apart for this prompt.
  await startConversation(page, 'stream slowly: prove it');

  await expect(page.getByText(/This is a slow/)).toBeVisible();
  // The rest of the answer cannot be on screen yet: if the proxy, the gateway
  // or the interface buffered the stream, the complete sentence would already
  // be visible and this assertion would fail.
  expect(await page.locator('body').innerText()).not.toContain('streamed answer.');
  await expect(page.getByText(/Still writing/)).toBeVisible();

  await expect(page.getByText(/slow streamed answer\./)).toBeVisible();
  const body = await page.locator('body').innerText();
  // Complete, ordered and not duplicated.
  expect(body.split('This is a slow streamed answer.').length).toBe(2);
});

test('uploads a real CSV and reads it through the real tool loop', async ({ page }) => {
  await createProfile(page);

  const dialog = await openSettings(page);
  await dialog.getByRole('tab', { name: /tools & approvals/i }).click();
  await dialog.getByRole('button', { name: /allow reviewed keyless built-ins/i }).click();
  await expect(dialog.getByText(/7 tool\(s\) selected/)).toBeVisible();
  await dialog.getByRole('button', { name: /save tool settings/i }).click();
  await dialog.getByRole('button', { name: /verify native tool calling/i }).click();
  await expect(dialog.getByText('supported_verified')).toBeVisible();
  await dialog.getByRole('button', { name: /close settings/i }).click();

  await page
    .getByRole('complementary', { name: /conversations/i })
    .getByRole('button', { name: /^new conversation$/i })
    .click();
  const csv = 'department,amount\nengineering,1200\nmarketing,800\nsupport,400\n';
  await page.locator('input[type=file]').setInputFiles({
    name: 'budget.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await expect(page.getByText(/budget\.csv/).first()).toBeVisible();

  await page.getByLabel(/^message$/i).fill('read my uploaded file');
  await page.getByRole('button', { name: /^send$/i }).click();

  // The mock model lists the vault, then reads the ID it received, so both
  // steps run through the real executor against the real uploaded bytes. The
  // tool timeline is collapsed by default, so open it before reading it.
  const timeline = page.locator('.tool-timeline');
  await expect(timeline.getByText(/Tool activity/)).toBeVisible({ timeout: 20_000 });
  await timeline.getByText(/Tool activity/).click();
  await expect(timeline.getByText('files_read')).toBeVisible();
  await expect(timeline.getByText(/budget\.csv/).first()).toBeVisible();
  await expect(page.getByText(/Tool result received/)).toBeVisible();

  // Activity and a generic notice also appear when `files_read` failed or
  // returned the wrong file. Two assertions tie the rendered page to the exact
  // uploaded bytes:
  //  - the tool summary reports the fixture's length (`csv.length`), which only
  //    holds when the vault read this file completely;
  //  - the mock model echoes the beginning of the tool result into its answer,
  //    and the CSV body starts well inside that window, so a distinctive row
  //    proves the file content itself reached the transcript.
  await expect(
    timeline.getByText(new RegExp(`budget\\.csv: ${csv.length} extracted characters`)),
  ).toBeVisible();
  await expect(page.getByText(/marketing,800/).first()).toBeVisible();
});

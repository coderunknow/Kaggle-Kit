import { expect, test, type Page } from '@playwright/test';

/**
 * Browser-level coverage of the built app: profile setup, a chat round trip,
 * settings keyboard behaviour, and the tool approval lifecycle (probe →
 * tool chat → deny) against the deterministic mock upstream.
 */
const MOCK_BASE_URL = 'http://127.0.0.1:18200';

async function createProfile(page: Page) {
  await page.goto('/');
  await page.locator('header.topbar').getByRole('button', { name: /^settings$/i }).click();
  const dialog = page.getByRole('dialog', { name: /^settings$/i });
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
  await expect(page.getByText(/Harmless safe chat response/)).toBeVisible();
});

test('settings dialog closes with Escape and move focus out of the dialog', async ({ page }) => {
  await page.goto('/');
  await page.locator('header.topbar').getByRole('button', { name: /^settings$/i }).click();
  const dialog = page.getByRole('dialog', { name: /^settings$/i });
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
  const profileId = await page.evaluate(() => {
    const raw = window.localStorage.getItem('kaggle-kit.profiles.v1');
    const profiles = raw ? (JSON.parse(raw) as { id: string }[]) : [];
    return profiles[0]?.id;
  });
  expect(profileId).toBeTruthy();

  // Configure tools through the same API the settings UI uses, then probe.
  const digest = `sha256:${'7'.repeat(64)}`;
  const profileResponse = await page.request.put(`/api/tools/profiles/${profileId}`, {
    headers: { Origin: 'http://127.0.0.1:18201' },
    data: {
      baseUrl: MOCK_BASE_URL,
      modelId: 'mock-model',
      apiKey: 'e2e-test-key',
      settings: {
        schemaVersion: 1,
        enabled: true,
        approvalMode: 'ask',
        capabilities: {},
        allowedTools: ['calculator_calculate', 'code_execute'],
        limits: {
          maxRounds: 4,
          maxToolCalls: 8,
          maxCallsPerRound: 2,
          maxToolResultBytes: 32768,
          maxTotalToolBytes: 98304,
          toolTimeoutMs: 20000,
        },
        sandbox: {
          enabled: true,
          image: `python:3.12-alpine@${digest}`,
          memoryMb: 256,
          cpus: 1,
          pidsLimit: 64,
          timeoutMs: 15000,
          outputBytes: 16384,
        },
        web: { providerEnabled: false, directFetchEnabled: false, braveSecretRef: '', resultCount: 5, freshness: '' },
        files: { enabled: false, maxFiles: 8, maxBytes: 262144, maxInputBytes: 1048576, retentionMs: 86400000 },
        mcpServers: [],
        httpTools: [],
      },
    },
  });
  expect(profileResponse.ok()).toBe(true);
  const stored = (await profileResponse.json()) as { profile: { settings: unknown } };

  const probeResponse = await page.request.post(`/api/tools/profiles/${profileId}/probe`, {
    headers: { Origin: 'http://127.0.0.1:18201' },
    data: { baseUrl: MOCK_BASE_URL, modelId: 'mock-model', apiKey: 'e2e-test-key', timeoutMs: 20000 },
  });
  expect(probeResponse.ok()).toBe(true);
  const probed = (await probeResponse.json()) as { settings: unknown };

  // Mirror the server-stored tool settings into the browser profile (the
  // same synchronization ToolsSettings performs) and reload.
  await page.evaluate(
    ([id, settings]) => {
      const raw = window.localStorage.getItem('kaggle-kit.profiles.v1');
      if (!raw) return;
      const profiles = JSON.parse(raw) as { id: string; tools?: unknown }[];
      for (const entry of profiles) if (entry.id === id) entry.tools = settings;
      window.localStorage.setItem('kaggle-kit.profiles.v1', JSON.stringify(profiles));
    },
    [profileId, probed.settings ?? stored.profile.settings] as const,
  );
  await page.reload();

  await startConversation(page, 'calculate: 2+3');
  await expect(page.getByText(/Tool result received/)).toBeVisible();

  await page.getByLabel(/^message$/i).fill('run code: print(1)');
  await page.getByRole('button', { name: /^send$/i }).click();
  const deny = page.getByRole('button', { name: /^deny$/i });
  await expect(deny).toBeVisible();
  await expect(page.getByRole('button', { name: /approve once/i })).toBeVisible();
  await deny.click();
  await expect(page.getByText(/Tool result received/)).toHaveCount(2);
  await expect(page.getByText(/denied by the user/i)).toBeVisible();
});

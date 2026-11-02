import { expect, test, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';

const SHOP_URL = 'http://fixture:4100/product';
const setShop = (slug: string, state: Record<string, unknown>) =>
  fetch(`${process.env.E2E_FIXTURE_URL}/__state/${slug}`, { method: 'POST', body: JSON.stringify(state) });

// Tests share one database, so each run uses its own monitor name and shop page.
const uniqueSuffix = () => Math.random().toString(36).slice(2, 8);

const compose = (args: string) => execSync(`${process.env.E2E_COMPOSE} ${args}`, { stdio: 'pipe' });

async function waitForApp(page: Page) {
  await expect(async () => {
    const response = await page.request.get('/api/monitors');
    expect(response.status()).toBe(200);
  }).toPass({ timeout: 60_000 });
}

async function fillField(page: Page, index: number, name: string, selector: string, type?: string) {
  const row = page.getByTestId('field-row').nth(index);
  await row.getByLabel('Field name').fill(name);
  await row.getByLabel('CSS selector').fill(selector);
  if (type) await row.getByLabel('Type').selectOption({ label: type });
}

async function createMonitor(page: Page, name: string, slug: string) {
  await page.goto('/monitors/new');
  await page.getByLabel('Monitor name').fill(name);
  await page.getByLabel('Page URL').fill(`${SHOP_URL}/${slug}`);
  await page.getByLabel('Check every (minutes)').fill('60');
  await fillField(page, 0, 'Price', '.price', 'Price');
  await fillField(page, 1, 'Availability', '.stock', 'Stock status');
  await page.getByRole('button', { name: 'Add field' }).click();
  await fillField(page, 2, 'Quantity', '.qty', 'Stock quantity');
  await page.getByRole('button', { name: 'Create monitor' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

async function checkNow(page: Page) {
  const button = page.getByRole('button', { name: /Check now|Checking/ });
  await button.click();
  await expect(page.getByRole('button', { name: 'Check now' })).toBeEnabled({ timeout: 40_000 });
}

test('asks for a password and hides the API', async ({ browser }) => {
  const anonymous = await browser.newContext({ httpCredentials: undefined });
  const response = await anonymous.request.get(`${process.env.E2E_BASE_URL}/`);
  expect(response.status()).toBe(401);
  const proxied = await anonymous.request.get(`${process.env.E2E_BASE_URL}/api/monitors`);
  expect(proxied.status()).toBe(401);
  await anonymous.close();
});

test('shows an empty state before any monitor exists', async ({ page }, testInfo) => {
  test.skip(testInfo.repeatEachIndex > 0, 'Only a fresh database is empty');
  await page.goto('/monitors');
  await expect(page.getByText('No monitors yet.')).toBeVisible();
});

test('creates a monitor, and custom fields survive reloads and service restarts', async ({ page }) => {
  await createMonitor(page, `Persistent pump ${uniqueSuffix()}`, `persist-${uniqueSuffix()}`);
  const fields = page.getByTestId('field');
  await expect(fields).toHaveCount(3);

  await page.reload();
  await expect(fields).toHaveCount(3);
  await expect(page.getByRole('cell', { name: 'Quantity', exact: true })).toBeVisible();

  compose('restart web api');
  await waitForApp(page);
  await page.reload();
  await expect(fields).toHaveCount(3);
  await expect(page.getByRole('cell', { name: '.qty' })).toBeVisible();
});

test('tests selectors on the page before saving', async ({ page }) => {
  await page.goto('/monitors/new');
  await page.getByLabel('Page URL').fill(`${SHOP_URL}/preview`);
  await fillField(page, 0, 'Price', '.price', 'Price');
  await fillField(page, 1, 'Gone', '.does-not-exist');
  await page.getByRole('button', { name: 'Test fields on the page' }).click();
  const results = page.getByRole('list', { name: 'Test results' });
  await expect(results.getByText('CHF 49.90')).toBeVisible();
  await expect(results.getByText('Not found')).toBeVisible();
});

test('detects price and stock changes, and shows them in history and on the dashboard', async ({ page }) => {
  const slug = `changes-${uniqueSuffix()}`;
  await setShop(slug, { price: 'CHF 49.90', stock: 'Auf Lager', quantity: 5 });
  await createMonitor(page, `Changing pump ${uniqueSuffix()}`, slug);
  await checkNow(page);
  await expect(page.getByTestId('field').getByText('CHF 49.90')).toBeVisible();
  await expect(page.getByLabel('Status').getByText('In stock')).toBeVisible();

  await setShop(slug, { price: 'CHF 59.90', stock: 'Ausverkauft', quantity: 0 });
  await checkNow(page);
  await expect(page.getByLabel('Status').getByText('Out of stock')).toBeVisible();

  const latest = page.getByTestId('history-run').first();
  await expect(latest.getByText('CHF 49.90')).toBeVisible();
  await expect(latest.getByText('CHF 59.90')).toBeVisible();
  await expect(latest.getByText('Stock changed: in stock → out of stock')).toBeVisible();

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recent changes' })).toBeVisible();
  await expect(page.getByText('CHF 49.90 →').first()).toBeVisible();

  await page.goto('/history?changed=true');
  await expect(page.getByTestId('history-run').first().getByText('Changed').first()).toBeVisible();
});

test('renames, adds and removes fields, and the edit form loads the saved values', async ({ page }) => {
  await createMonitor(page, `Edited pump ${uniqueSuffix()}`, `edit-${uniqueSuffix()}`);
  await page.getByRole('link', { name: 'Edit', exact: true }).click();

  const rows = page.getByTestId('field-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByLabel('Field name')).toHaveValue('Price');

  await rows.nth(0).getByLabel('Field name').fill('Price CHF');
  await rows.nth(2).getByRole('button', { name: /Remove field/ }).click();
  await page.getByRole('button', { name: 'Add field' }).click();
  await fillField(page, 2, 'Description', '.description');
  await rows.nth(2).getByLabel('Read from').selectOption('ATTRIBUTE');
  await rows.nth(2).getByLabel('Attribute name').fill('title');
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByRole('cell', { name: 'Price CHF' })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('field')).toHaveCount(3);
  await expect(page.getByRole('cell', { name: 'Description', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '.description @title' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Quantity', exact: true })).toHaveCount(0);
});

test('shows a clear message for an invalid selector and for a blocked address', async ({ page }) => {
  await page.goto('/monitors/new');
  await page.getByLabel('Monitor name').fill('Bad input');
  await page.getByLabel('Page URL').fill(`${SHOP_URL}/bad`);
  await fillField(page, 0, 'Price', 'div[[', 'Price');
  await fillField(page, 1, 'Availability', '.stock', 'Stock status');
  await page.getByRole('button', { name: 'Create monitor' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Invalid CSS selector');

  await page.getByTestId('field-row').nth(0).getByLabel('CSS selector').fill('.price');
  await page.getByLabel('Page URL').fill('http://169.254.169.254/latest/meta-data/');
  await page.getByRole('button', { name: 'Create monitor' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('not allowed');
  await expect(page).toHaveURL(/\/monitors\/new$/);
});

test('reports a missing element without failing the other fields', async ({ page }) => {
  const slug = `missing-${uniqueSuffix()}`;
  await createMonitor(page, `Missing pump ${uniqueSuffix()}`, slug);
  await checkNow(page);
  await setShop(slug, { hidden: ['stock'] });
  await checkNow(page);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Availability: element not found');
  await expect(page.getByTestId('field').getByText('Element missing')).toBeVisible();
  await expect(page.getByTestId('field').getByText('CHF 49.90')).toBeVisible();
});

test('pauses, resumes and deletes a monitor', async ({ page }) => {
  const name = `Temporary pump ${uniqueSuffix()}`;
  await createMonitor(page, name, `temp-${uniqueSuffix()}`);
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Status').getByText('Paused').first()).toBeVisible();
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page).toHaveURL(/\/monitors$/);
  await expect(page.getByRole('link', { name })).toHaveCount(0);
});

test('fits a phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/', '/monitors', '/monitors/new', '/history']) {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `sideways overflow on ${path}`).toBeLessThanOrEqual(0);
  }
});

test('saves configuration and explains the problem while Redis is down', async ({ page }) => {
  await createMonitor(page, `Redis outage pump ${uniqueSuffix()}`, `redis-${uniqueSuffix()}`);
  const url = page.url();
  compose('stop redis');
  try {
    await page.getByRole('link', { name: 'Edit', exact: true }).click();
    await page.getByTestId('field-row').nth(0).getByLabel('Field name').fill('Price during outage');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('cell', { name: 'Price during outage' })).toBeVisible();

    await page.getByRole('button', { name: /Check now/ }).click();
    await expect(page.getByRole('main').getByRole('alert').filter({ hasText: 'check queue is not available' })).toBeVisible({ timeout: 15_000 });
  } finally {
    compose('start redis');
  }
  await page.goto(url);
  await expect(page.getByRole('cell', { name: 'Price during outage' })).toBeVisible();
});

test('refuses a write from another website', async ({ page }) => {
  for (const origin of ['https://evil.example', 'null']) {
    const response = await page.request.post('/api/monitors/preview', { headers: { origin }, data: {} });
    expect(response.status(), `origin ${origin}`).toBe(403);
  }
});

test('stays usable with a clear message while the API is down', async ({ page }) => {
  compose('stop api');
  try {
    await page.goto('/monitors');
    await expect(page.getByRole('main').getByRole('alert')).toContainText('could not be loaded');
  } finally {
    compose('start api');
    await waitForApp(page);
  }
  await page.goto('/monitors');
  await expect(page.getByRole('link', { name: /Persistent pump/ }).first()).toBeVisible();
});

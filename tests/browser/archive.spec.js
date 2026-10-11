import { test, expect } from '@playwright/test';

test('loads real data, filters, inspects history and exports CSV', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#result-count')).toContainText('matches');
  await expect(page.locator('#detail h3')).toBeVisible();
  await expect(page.locator('#price-chart')).toBeVisible();
  await page.getByRole('button', { name: 'Full history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Full history', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#sample-slider').focus();
  await page.locator('#sample-slider').press('Home');
  await expect(page.locator('#chart-tooltip')).toContainText('decimal odds');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download match prices (CSV)' }).click();
  expect((await download).suggestedFilename()).toMatch(/tennis-\d+-prices.csv/);
  await page.locator('#search').fill('this player does not exist 123xyz');
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#result-count')).toContainText('0 of');
  await page.getByRole('button', { name: 'Reset filters' }).click();
  await expect(page.locator('#matches tr')).toHaveCount(30);
  await page.locator('#next').click();
  await expect(page.locator('#page-info')).toContainText('2 /');
  const player = await page.locator('#matches tr').first().locator('.match-button').innerText();
  await page.locator('#matches tr').first().locator('button').click();
  await expect(page.locator('#detail h3')).toBeVisible();
  expect(player.length).toBeGreaterThan(5);
  await page.locator('#tour').selectOption('WTA');
  for (const tag of await page.locator('.tour-tag').allTextContents()) expect(tag).toBe('WTA');
  expect(errors).toEqual([]);
});

test('mobile layout stays within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('#detail h3')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#matches tr').first().locator('button').click();
  await expect(page.locator('#price-chart')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('unavailable archive produces a useful error', async ({ page }) => {
  await page.route('**/data/markets.json', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await page.goto('/');
  await expect(page.locator('#load-error')).toContainText('HTTP 503');
});

test('a match with missing history is not given invented prices', async ({ page }) => {
  await page.route('**/data/history/*.json', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.outcomes.forEach((o) => { o.points = []; });
    await route.fulfill({ response, json: body });
  });
  await page.goto('/');
  await expect(page.locator('#chart')).toContainText('No retained price history');
  await expect(page.getByRole('button', { name: 'Download match prices (CSV)' })).toBeDisabled();
});

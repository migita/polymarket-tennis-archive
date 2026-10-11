import { test, expect } from '@playwright/test';

const match = {
  id: '999000001', question: 'Test Open: First Player vs. Second Player', slug: 'atp-first-second',
  sportsMarketType: 'moneyline', volumeNum: 6000, closed: false, acceptingOrders: true,
  outcomes: JSON.stringify(['First Player', 'Second Player']), clobTokenIds: JSON.stringify(['token-a', 'token-b']),
  gameStartTime: '2026-10-20T10:00:00Z', events: [{ seriesSlug: 'atp', slug: 'test-tennis' }],
};

async function mockLive(page) {
  const requests = { books: 0, fail: false };
  await page.route('https://gamma-api.polymarket.com/**', (route) => route.fulfill({ json: {
    markets: [match, { ...match, id: '999000002', volumeNum: 5000 }, { ...match, id: '999000003', question: 'Doubles: A / B vs. C / D' }],
    next_cursor: null,
  } }));
  await page.route('https://clob.polymarket.com/books', (route) => {
    requests.books++;
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON()).toEqual([{ token_id: 'token-a' }, { token_id: 'token-b' }]);
    return requests.fail ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.fulfill({ json: [
      { asset_id: 'token-a', timestamp: String(Date.now()), asks: [{ price: '0.7', size: '100' }, { price: '0.4', size: '5' }, { price: '0', size: '10' }, { price: '0.2', size: '0' }] },
      { asset_id: 'token-b', timestamp: String(Date.now()), asks: [] },
    ] });
  });
  return requests;
}

test('discovers upcoming singles, reads independent ask books and marks failed refreshes stale', async ({ page }) => {
  const requests = await mockLive(page);
  const historyRequests = [];
  page.on('request', (r) => { if (r.url().includes('history/999000001')) historyRequests.push(r.url()); });
  await page.goto('/');
  await expect(page.locator('#live-status')).toContainText('1 OPEN MARKETS');
  await page.locator('#market-view').selectOption('live');
  await expect(page.locator('#matches tr')).toHaveCount(1);
  const row = page.locator('#matches tr').first();
  await expect(row.locator('td').nth(3)).toHaveText('2.50');
  await expect(row.locator('td').nth(5)).toHaveText('—');
  await expect(row.locator('.source-label')).toHaveText('LIVE ASK');
  await row.locator('button').click();
  await expect(page.locator('#chart')).toContainText('Live market; no history in the one-off archive');
  await expect(page.locator('.odds-caption').first()).toContainText('5 shares');
  expect(historyRequests).toEqual([]);
  requests.fail = true;
  await page.locator('#refresh-now').click();
  await expect(page.locator('#live-status')).toContainText('PREVIOUS QUOTES ARE STALE');
  await expect(row.locator('.source-label')).toHaveText('STALE ASK');
  await expect(row.locator('td').nth(3)).toHaveText('2.50');
  await expect(page.locator('.odds-caption').first()).toContainText('STALE');
});

test('refresh interval triggers a new scan, can pause, and persists in the browser', async ({ page }) => {
  const requests = await mockLive(page);
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#live-status')).toContainText('CONNECTED');
  expect(requests.books).toBe(1);
  await page.locator('#refresh-interval').selectOption('30');
  await page.clock.fastForward(31000);
  await expect.poll(() => requests.books).toBe(2);
  await expect(page.locator('#refresh-now')).toBeEnabled();
  await page.locator('#refresh-interval').selectOption('0');
  await page.clock.fastForward(120000);
  expect(requests.books).toBe(2);
  await expect(page.locator('#refresh-countdown')).toHaveText('PAUSED');
  await page.reload();
  await expect(page.locator('#live-status')).toContainText('CONNECTED');
  await expect(page.locator('#refresh-interval')).toHaveValue('0');
});

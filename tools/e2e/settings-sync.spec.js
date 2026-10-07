/* Synced settings, end to end: what a launch sends, what it keeps, and what
 * it takes from the account.
 *
 * Measured on this stack on 2026-10-07: every launch sent PATCH
 * /api/users/settings with the account's own pins, order and interests, the
 * pull's answer could undo a change made while it was on the wire, and a
 * phone with an older copy could keep it. services/userSettings.js and the
 * flock-settings-loaded listener in App.js say how each is handled now; these
 * drive the app the way a person does and check the end state on screen, in
 * storage and on the account (a second device reading it).
 *
 * Plus the tab bar in a window narrower than a phone: iPadOS 27 makes
 * iPhone-only apps freely resizable, and five tabs ran 3 px off 320 px.
 */
'use strict';
const { test, expect } = require('@playwright/test');
const { signUp } = require('./helpers');

const settingsPatches = (page) => {
  const sent = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/api/users/settings')) sent.push(r.postData() || '');
  });
  return sent;
};

// Past the confirm-your-email screen a brand new account lands on, to the tab bar.
async function intoTheApp(page) {
  const nav = page.getByRole('navigation', { name: 'Main' });
  for (let i = 0; i < 6 && !(await nav.isVisible().catch(() => false)); i += 1) {
    const out = page.getByRole('button', { name: /^(not now|skip|continue for now, confirm later)$/i }).first();
    if (await out.count()) await out.click().catch(() => {});
    await page.waitForTimeout(1500);
  }
  await expect(nav).toBeVisible({ timeout: 30_000 });
  return nav;
}

async function addInterest(page, nav, name) {
  await nav.getByRole('button', { name: /^you/i }).click();
  await page.getByRole('button', { name: /interests/i }).first().click();
  await page.getByRole('button', { name: new RegExp(`^\\+?\\s*${name}$`, 'i') }).first().click();
}

// A device with the same session but none of the synced lists in storage.
const withoutLists = (state) => ({
  cookies: state.cookies,
  origins: state.origins.map((o) => ({
    origin: o.origin,
    localStorage: o.localStorage.filter((kv) => !/^flock_(interests|pinned|order)$/.test(kv.name)),
  })),
});

async function launch(browser, contextOptions, state) {
  const context = await browser.newContext({ ...contextOptions, storageState: state });
  const page = await context.newPage();
  const sent = settingsPatches(page);
  await page.goto('/app');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible({ timeout: 60_000 });
  return { context, page, sent };
}

test('a change is saved as itself, a launch sends nothing back, and another device receives it', async ({ browser, contextOptions }) => {
  test.setTimeout(150_000);
  const first = await browser.newContext(contextOptions);
  const page = await first.newPage();
  await signUp(page, 'sync');
  const nav = await intoTheApp(page);
  await page.waitForTimeout(2500); // the launch's own pull settles first
  const edits = settingsPatches(page);
  await addInterest(page, nav, 'Sports');
  await expect.poll(() => edits.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(edits).toEqual(['{"userInterests":["Sports"]}']);
  const state = await first.storageState();
  await first.close();

  for (let i = 0; i < 2; i += 1) {
    const { context, page: p, sent } = await launch(browser, contextOptions, state);
    await p.waitForTimeout(3000);
    expect(sent, `launch ${i + 1} sent the account its own settings`).toEqual([]);
    await context.close();
  }

  const { context, page: other, sent } = await launch(browser, contextOptions, withoutLists(state));
  await expect.poll(() => other.evaluate(() => localStorage.getItem('flock_interests')), { timeout: 10_000 }).toBe('["Sports"]');
  expect(sent).toEqual([]);
  await context.close();
});

test('a change made while the settings pull is on the wire stays, and reaches the account', async ({ browser, contextOptions }) => {
  test.setTimeout(150_000);
  const first = await browser.newContext(contextOptions);
  const setup = await first.newPage();
  await signUp(setup, 'race');
  await intoTheApp(setup);
  await setup.waitForTimeout(2500);
  const state = await first.storageState();
  await first.close();

  const context = await browser.newContext({ ...contextOptions, storageState: state });
  const page = await context.newPage();
  const sent = settingsPatches(page);
  // The pull's answer is read from the server at launch (the old copy) and
  // handed to the page five seconds later, as on a slow connection.
  let answeredAt = null;
  await page.route((u) => u.pathname === '/api/users/settings', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const resp = await route.fetch();
    await new Promise((r) => setTimeout(r, 5000));
    answeredAt = Date.now();
    return route.fulfill({ response: resp });
  });
  await page.goto('/app');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav).toBeVisible({ timeout: 60_000 });
  await addInterest(page, nav, 'Food');
  const tappedAt = Date.now();
  await expect.poll(() => answeredAt, { timeout: 15_000 }).not.toBeNull();
  expect(answeredAt).toBeGreaterThan(tappedAt);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => localStorage.getItem('flock_interests'))).toBe('["Food"]');
  expect(sent.some((b) => b.includes('"Food"'))).toBe(true);
  expect(sent.some((b) => b.includes('"userInterests":[]'))).toBe(false);
  await context.close();

  const { context: other, page: elsewhere } = await launch(browser, contextOptions, withoutLists(state));
  await expect.poll(() => elsewhere.evaluate(() => localStorage.getItem('flock_interests')), { timeout: 10_000 }).toBe('["Food"]');
  await other.close();
});

test('a device holding an older copy ends on the account, and sends nothing stale', async ({ browser, contextOptions }) => {
  test.setTimeout(150_000);
  const first = await browser.newContext(contextOptions);
  const page = await first.newPage();
  await signUp(page, 'stale');
  const nav = await intoTheApp(page);
  await page.waitForTimeout(2500);
  await addInterest(page, nav, 'Trivia');
  await page.waitForTimeout(2000);
  const state = await first.storageState();
  await first.close();

  const stale = {
    cookies: state.cookies,
    origins: state.origins.map((o) => ({
      origin: o.origin,
      localStorage: [...o.localStorage.filter((kv) => kv.name !== 'flock_interests'), { name: 'flock_interests', value: '["Old"]' }],
    })),
  };
  const { context, page: p, sent } = await launch(browser, contextOptions, stale);
  await expect.poll(() => p.evaluate(() => localStorage.getItem('flock_interests')), { timeout: 10_000 }).toBe('["Trivia"]');
  await p.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^you/i }).click();
  await expect(p.getByRole('button', { name: /interests/i }).first()).toContainText('1 interest');
  expect(sent.filter((b) => b.includes('Old'))).toEqual([]);
  await context.close();
});

test('the tab bar fits a window narrower than a phone', async ({ browser, contextOptions }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ ...contextOptions, viewport: { width: 320, height: 568 } });
  const page = await context.newPage();
  await signUp(page, 'narrow');
  const nav = await intoTheApp(page);
  const tabs = nav.getByRole('button');
  const count = await tabs.count();
  expect(count).toBe(5);
  for (let i = 0; i < count; i += 1) {
    const box = await tabs.nth(i).boundingBox();
    expect(box.x, `tab ${i + 1} starts off the left edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `tab ${i + 1} runs off the right edge`).toBeLessThanOrEqual(320);
  }
  await context.close();
});

'use strict';
/*
 * Reproduction of the crash the demonstration recording found (build 52):
 * Discover -> "All N results" -> tap a row -> the venue sheet opens -> Close
 * -> the Discover tab falls into its error boundary, "The map stopped
 * working", with "null is not an object (evaluating 'H[e]')". This drives the
 * same taps against the local stack and prints every error with its stack,
 * so the throw has a line number instead of a minified name.
 */
const { test, expect } = require('@playwright/test');
const { signUp } = require('./helpers');

test.setTimeout(180_000);

test('closing a venue sheet opened from the results list does not crash Discover', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push({ kind: 'pageerror', message: err.message, stack: err.stack }));
  page.on('console', async (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const entry = { kind: 'console.' + msg.type(), text: msg.text() };
    try {
      const stacks = await Promise.all(msg.args().map((a) => a.evaluate((v) => (v && v.stack) ? String(v.stack) : null).catch(() => null)));
      entry.stacks = stacks.filter(Boolean);
    } catch { /* ignore */ }
    errors.push(entry);
  });

  // The analytics choice sheet sits over the auth screen on a fresh profile
  // and intercepts every click until it is answered.
  await page.goto('/app');
  const noThanks = page.getByRole('button', { name: /no thanks/i }).first();
  try { await noThanks.click({ timeout: 8_000 }); } catch { /* not shown */ }

  await signUp(page, 'discover');

  // No mail leaves the local stack, so the confirmation screen offers a way on.
  const later = page.getByText(/Continue for now, confirm later/i).first();
  try { await later.click({ timeout: 15_000 }); } catch { /* not shown */ }

  // The mode chooser, if it is shown: the consumer side.
  const going = page.getByText(/I'm Going Out/i).first();
  try { await going.click({ timeout: 10_000 }); } catch { /* not shown */ }

  await page.getByRole('button', { name: /^discover$/i }).first().click({ timeout: 30_000 });

  // No geolocation permission in this context, so the app takes its fallback
  // city, which is the same path the recording rig takes.
  const all = page.getByRole('button', { name: /All \d+ results/ }).first();
  await expect(all).toBeVisible({ timeout: 60_000 });
  await all.evaluate((el) => el.click());

  const pill = page.getByRole('img', { name: /Crowd level \d+ out of 100/ }).first();
  await expect(pill).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  await pill.evaluate((el) => el.click());

  const close = page.getByRole('button', { name: /^close$/i });
  await expect(close.last()).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(2000);
  const closeCount = await close.count();
  const beforeText = (await page.locator('body').innerText()).slice(0, 400);
  await close.last().evaluate((el) => el.click());
  await page.waitForTimeout(3500);

  const crashed = await page.getByText(/The map stopped working/).count();
  const afterText = (await page.locator('body').innerText()).slice(0, 700);
  console.log('E2E_CLOSE_BUTTONS', closeCount);
  console.log('E2E_BEFORE', JSON.stringify(beforeText));
  console.log('E2E_AFTER', JSON.stringify(afterText));
  console.log('E2E_CRASHED', crashed);
  console.log('E2E_ERRORS', JSON.stringify(errors, null, 1).slice(0, 6000));
  expect(crashed).toBe(0);
  // Two Close buttons while the sheet is up: the map card underneath and the
  // sheet itself. After the sheet closes the card is still there, address and all.
  expect(closeCount).toBe(2);
  await expect(page.getByRole('button', { name: /^close$/i })).toHaveCount(1);
  expect(afterText).toMatch(/, PA \d{5}/);
});

test('tapping a map pin opens the card with the dial and closing it does not crash', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (err) => errors.push({ kind: 'pageerror', message: err.message, stack: err.stack }));
  page.on('console', async (msg) => {
    if (msg.type() !== 'error') return;
    const entry = { kind: 'console.error', text: msg.text() };
    try {
      const stacks = await Promise.all(msg.args().map((a) => a.evaluate((v) => (v && v.stack) ? String(v.stack) : null).catch(() => null)));
      entry.stacks = stacks.filter(Boolean);
    } catch { /* ignore */ }
    errors.push(entry);
  });
  await page.goto('/app');
  try { await page.getByRole('button', { name: /no thanks/i }).first().click({ timeout: 8_000 }); } catch { /* not shown */ }
  await signUp(page, 'pin');
  try { await page.getByText(/Continue for now, confirm later/i).first().click({ timeout: 15_000 }); } catch { /* not shown */ }
  try { await page.getByText(/I'm Going Out/i).first().click({ timeout: 10_000 }); } catch { /* not shown */ }
  await page.getByRole('button', { name: /^discover$/i }).first().click({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /All \d+ results/ }).first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  const pin = page.locator('[role="button"][aria-label*=", crowd "]').first();
  await expect(pin).toBeAttached({ timeout: 20_000 });
  const pinName = await pin.getAttribute('aria-label');
  const box = await pin.boundingBox();
  await pin.evaluate((el) => el.click());
  await page.waitForTimeout(2500);
  const closeCount = await page.getByRole('button', { name: /^close$/i }).count();
  const cardText = (await page.locator('body').innerText()).slice(0, 900);
  const crashedBefore = await page.getByText(/The map stopped working/).count();
  if (closeCount > 0) {
    await page.getByRole('button', { name: /^close$/i }).first().evaluate((el) => el.click());
    await page.waitForTimeout(3000);
  }
  const crashed = await page.getByText(/The map stopped working/).count();
  console.log('PIN_NAME', pinName, 'BOX', JSON.stringify(box));
  console.log('PIN_CLOSE_BUTTONS', closeCount, 'CRASHED_BEFORE_CLOSE', crashedBefore, 'CRASHED_AFTER', crashed);
  console.log('PIN_CARD_TEXT', JSON.stringify(cardText));
  console.log('PIN_ERRORS', JSON.stringify(errors, null, 1).slice(0, 6000));
  expect(crashed).toBe(0);
  expect(crashedBefore).toBe(0);
  // The card, with the dial: a percentage and the ladder's word.
  expect(closeCount).toBe(1);
  expect(cardText).toMatch(/\d{1,3}%/);
});

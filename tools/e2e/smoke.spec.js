/* The spec that proves the harness itself works.
 *
 * Every other spec in this directory is only as trustworthy as this one. If the
 * app is not really loading, or the browser is quietly talking to production,
 * or a React crash is being swallowed by an ErrorBoundary and rendered as a
 * screen, then a suite of green specs means nothing at all.
 *
 * So this asserts the harness before it asserts the product.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const { API_BASE, pinToLocalApi, failOnPageErrors, signUp } = require('./helpers');

test('the app loads and is talking to the LOCAL api, not production', async ({ page }) => {
  const seen = [];
  page.on('request', (req) => { if (req.url().includes('/api/')) seen.push(req.url()); });
  pinToLocalApi(page);

  await page.goto('/app');
  await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();

  // Make it actually call the API rather than trusting a static page load.
  await page.getByRole('textbox', { name: /email/i }).fill('nobody@example.com');
  await page.getByRole('textbox', { name: /password/i }).first().fill('wrong-password-on-purpose');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  await expect.poll(() => seen.length, { timeout: 15_000 }).toBeGreaterThan(0);
  for (const url of seen) expect(url.startsWith(API_BASE)).toBe(true);
});

test('a wrong password is refused in words, not a blank screen', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);
  pinToLocalApi(page);

  await page.goto('/app');
  await page.getByRole('textbox', { name: /email/i }).fill('nobody@example.com');
  await page.getByRole('textbox', { name: /password/i }).first().fill('definitely-not-it');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // Something has to say what went wrong. A sign-in that fails silently is the
  // single most common way an app looks broken to somebody who typo'd.
  await expect(page.locator('body')).toContainText(/incorrect|invalid|wrong|no account|check/i, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('a brand new account can be created through the real screens', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);

  await signUp(page, 'smoke');

  // Landing anywhere that is not still the signup form is the bar here. The
  // flow specs assert what the first screen should actually say.
  await expect(page.getByRole('heading', { name: /create|welcome back/i })).toHaveCount(0, { timeout: 20_000 });
  expect(errors).toEqual([]);
});

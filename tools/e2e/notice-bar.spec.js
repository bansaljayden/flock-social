/* The notice bar makes room for itself, in a real browser.
 *
 * The app says one sentence in a bar fixed across the top of the window:
 * what a confirmation link did, why a session ended, what a venue tap or an
 * invitation link needs first. Nothing under it made room, so it lay over
 * the bird mark on the sign-in screen, the Nest's "Hey, <name>" heading and
 * the profile button beside it, and the top of a toast. The bar now publishes
 * its height on <html> as --notice-h and --safe-top takes the larger of that
 * and the device inset (components/NoticeBar.js, index.css), which is what
 * every screen already pads its top by.
 *
 * jsdom has no layout, so frontend/src/__tests__/noticeBarTakesRoom.test.js
 * can pin the wiring but not the geometry. This file measures the geometry:
 * the bar's bottom edge against the top of what used to be under it, at the
 * harness's phone size (390 x 664, where "That confirmation link has
 * expired..." is two lines), and that Dismiss gives the room back.
 *
 * Every page here is pinned to the local API (helpers.pinToLocalApi), and
 * signups carry an X-Forwarded-For address of their own, for the reason
 * signup.spec.js gives at its top.
 */
'use strict';

const { test, expect } = require('@playwright/test');
const { newEmail, adultDob, pinToLocalApi, failOnPageErrors, expectToast } = require('./helpers');

const PASSWORD = 'E2eTesting!2026';

function clientIp() {
  const r = () => Math.floor(Math.random() * 256);
  return `198.18.${r()}.${r()}`;
}

/** The bar's box, and the published variable, read in the page. */
async function barBox(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-notice-bar]');
    if (!bar) return null;
    const r = bar.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, published: document.documentElement.style.getPropertyValue('--notice-h') };
  });
}

/** The top of the first visible element matching a selector. */
async function topOf(page, selector) {
  return page.evaluate((sel) => {
    const el = [...document.querySelectorAll(sel)].find((e) => {
      const r = e.getBoundingClientRect();
      return r.height > 3 && r.width > 3 && getComputedStyle(e).visibility !== 'hidden';
    });
    return el ? el.getBoundingClientRect().top : null;
  }, selector);
}

/** A new account, through the signup screen, into the app without confirming. */
async function newUnconfirmedAccount(page, tag) {
  await page.setExtraHTTPHeaders({ 'X-Forwarded-For': clientIp() });
  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();
  await page.getByLabel('Name', { exact: true }).fill('Nora Notice');
  await page.getByLabel('Email', { exact: true }).fill(newEmail(tag));
  await page.getByLabel('Year of birth', { exact: true }).fill(adultDob().slice(0, 4));
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: /^create account$/i }).click();
  await expect(page.getByRole('heading', { name: /confirm your email/i })).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /continue for now/i }).click();
  await expect(page.getByText(/no flocks yet/i)).toBeVisible({ timeout: 25_000 });
}

/** Arrive the way a confirmation link lands, which is what raises the bar. */
async function arriveFromLink(page, outcome) {
  await page.goto(`/?email_verified=${outcome}`);
  await expect(page.locator('[data-notice-bar]')).toBeVisible({ timeout: 15_000 });
}

for (const [outcome, words] of [['1', /your email is confirmed/i], ['expired', /has expired/i]]) {
  test(`signed out, "${outcome}": the bird mark and the heading start below the bar`, async ({ page }) => {
    const errors = [];
    failOnPageErrors(page, errors);
    const offences = pinToLocalApi(page);

    await arriveFromLink(page, outcome);
    await expect(page.locator('[data-notice-bar]')).toContainText(words);
    const bar = await barBox(page);
    expect(bar.top).toBe(0);
    expect(bar.published).toBe(`${Math.ceil(bar.bottom - bar.top)}px`);

    const mark = await topOf(page, '.auth-mark');
    const heading = await topOf(page, 'h1');
    expect(mark).not.toBeNull();
    expect(heading).not.toBeNull();
    expect(mark).toBeGreaterThanOrEqual(bar.bottom);
    expect(heading).toBeGreaterThanOrEqual(bar.bottom);

    expect(errors).toEqual([]);
    expect(offences).toEqual([]);
  });
}

test('signed in: the Nest, a toast, and Dismiss all respect the bar', async ({ page }) => {
  const errors = [];
  failOnPageErrors(page, errors);
  const offences = pinToLocalApi(page);
  await newUnconfirmedAccount(page, 'notice');

  // The two-line notice, so the bar is at its tallest at this width.
  await arriveFromLink(page, 'expired');
  await expect(page.getByText(/no flocks yet/i)).toBeVisible({ timeout: 25_000 });
  const bar = await barBox(page);
  expect(bar.bottom - bar.top).toBeGreaterThan(55);

  const heading = await topOf(page, 'h1');
  const profile = await page.getByRole('button', { name: 'Your profile', exact: true }).boundingBox();
  expect(heading).toBeGreaterThanOrEqual(bar.bottom);
  expect(profile.y).toBeGreaterThanOrEqual(bar.bottom);

  // A toast lands under the bar, not behind it. An empty name is refused on
  // the device before any request, so an unconfirmed account can raise it.
  await page.getByRole('button', { name: /start a flock/i }).first().click();
  await expect(page.getByRole('heading', { name: /start a flock/i })).toBeVisible();
  await page.getByRole('button', { name: /create flock/i }).click();
  await expectToast(page, /name your flock first/i);
  const toastTop = await page.getByText(/name your flock first/i).first().evaluate((el) => {
    const card = el.closest('[role="status"] > *') || el;
    return card.getBoundingClientRect().top;
  });
  expect(toastTop).toBeGreaterThanOrEqual(bar.bottom);

  // Back to the Nest, then Dismiss: the bar goes, the variable goes, and the
  // heading moves up by the room it was given.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByText(/no flocks yet/i)).toBeVisible({ timeout: 15_000 });
  const before = await topOf(page, 'h1');
  await page.locator('[data-notice-bar]').getByRole('button', { name: /^dismiss$/i }).click();
  await expect(page.locator('[data-notice-bar]')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--notice-h'))).toBe('');
  const after = await topOf(page, 'h1');
  expect(before - after).toBeGreaterThan(40);

  expect(errors).toEqual([]);
  expect(offences).toEqual([]);
});

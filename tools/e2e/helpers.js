/* Shared helpers for the end to end specs.
 *
 * The rule these encode: a spec proves the PRODUCT works, so it drives the app
 * the way a person does, through the screen. It does not call the API to set up
 * state and then assert on the screen, because that skips exactly the wiring
 * that has been broken repeatedly in this codebase (a control whose server half
 * was complete and whose client half never called it).
 */
'use strict';

const { expect } = require('@playwright/test');

const API_BASE = `http://127.0.0.1:${process.env.E2E_API_PORT || 5199}`;

/** A fresh address per spec, so parallel specs cannot collide on one account. */
function newEmail(tag) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `e2e-${tag}-${Date.now().toString(36)}-${rand}@example.com`;
}

/** Old enough to pass the 13 floor with room to spare, as YYYY-MM-DD. */
function adultDob() {
  const d = new Date();
  return `${d.getFullYear() - 22}-06-15`;
}

/**
 * THE GUARD THAT MAKES THE WHOLE SUITE SAFE TO RUN.
 *
 * A frontend build made without REACT_APP_API_URL falls back to the production
 * Railway host, and it looks completely normal doing it: the app works, signup
 * succeeds, and the accounts land in the real database. Both build.js and
 * stack.js check the bundle, but a bundle can be inspected wrongly. A request
 * cannot be misread.
 *
 * Attach this to any page that will act, and it fails the spec the moment the
 * app talks to anything that is not the local API.
 */
function pinToLocalApi(page) {
  // RECORDS, never throws. The first version of this threw inside the
  // page.on('request') handler, which is not how a Playwright test fails: the
  // throw becomes an unhandled rejection inside the driver rather than a test
  // failure, and it can disrupt the very request handling it is watching. Every
  // spec in the first run reported zero API calls because of it, which looked
  // exactly like the app being unable to reach the server.
  const offences = [];
  const WEB = `http://127.0.0.1:${process.env.E2E_WEB_PORT || 3199}`;
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('/api/')) return;
    if (url.startsWith(API_BASE) || url.startsWith(WEB)) return;
    offences.push(url);
  });
  return offences;
}

/**
 * Create an account through the real signup screen and land in the app.
 * Returns { email, name }.
 */
async function signUp(page, tag, name = 'Ada Tester') {
  const email = newEmail(tag);
  const offences = pinToLocalApi(page);

  await page.goto('/app');
  await page.getByRole('button', { name: /create an account/i }).click();

  await page.getByRole('textbox', { name: /^name$/i }).fill(name);
  await page.getByRole('textbox', { name: /email/i }).fill(email);
  await page.getByRole('textbox', { name: /password/i }).first().fill('E2eTesting!2026');

  // The date of birth screen is deliberately neutral: it prints no threshold
  // and caps nothing, so this fills a real date rather than picking an option.
  const dob = page.getByRole('textbox', { name: /birth|date/i }).first();
  if (await dob.count()) await dob.fill(adultDob());

  await page.getByRole('button', { name: /create account|sign up|continue/i }).first().click();
  return { email, name, offences };
}

/** Wait for a toast by text. Toasts are how this app reports almost everything. */
async function expectToast(page, re) {
  await expect(page.getByText(re).first()).toBeVisible({ timeout: 12_000 });
}

/**
 * Fail the spec on a React crash or an unhandled error in the page.
 *
 * The point is that an ErrorBoundary makes a crash LOOK like a screen. Without
 * this a spec can click happily through a broken app and pass.
 */
function failOnPageErrors(page, errors) {
  page.on('pageerror', (err) => errors.push(String(err && err.message ? err.message : err)));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    // React's own "not valid as a React child" and hook warnings are the class
    // that has actually shipped here, so they are failures rather than noise.
    if (/not valid as a React child|Maximum update depth|Rendered more hooks/i.test(text)) {
      errors.push(text);
    }
  });
}

module.exports = { API_BASE, newEmail, adultDob, signUp, expectToast, pinToLocalApi, failOnPageErrors };

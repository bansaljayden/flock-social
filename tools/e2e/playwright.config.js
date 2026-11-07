/* Playwright config for the local end to end stack.
 *
 * Point this at tools/e2e/stack.js, which must already be running. It is NOT a
 * webServer here on purpose: the stack takes a while to boot embedded Postgres
 * and run 51 migrations, and having every `playwright test` invocation tear
 * that down and rebuild it would make the suite too slow to actually run.
 *
 * Start it once:  node tools/e2e/stack.js
 * Then:           npx playwright test --config tools/e2e/playwright.config.js
 */
'use strict';

const { defineConfig, devices } = require('@playwright/test');
const { zoneForLocalHour } = require('./clock');

const WEB_PORT = Number(process.env.E2E_WEB_PORT || 3199);

// E2E_LOCAL_HOUR=22 runs every spec at 22:xx local, in the dark night theme,
// whatever the time on this machine; 13 runs them by day (see clock.js). Unset,
// the browser keeps this machine's own zone, as it always has. A spec that
// pins its own hour with test.use({ timezoneId }) keeps it. This reaches the
// `page` every test is handed; a second phone a spec opens itself with
// browser.newContext() inherits nothing from here, so it keeps this machine's
// zone unless the spec passes one.
const LOCAL_HOUR = process.env.E2E_LOCAL_HOUR;
const PINNED_ZONE = LOCAL_HOUR === undefined || LOCAL_HOUR === '' ? null : zoneForLocalHour(Number(LOCAL_HOUR));

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.js',

  // Specs share one database, so they must not share one ACCOUNT. Every spec
  // signs up its own, keyed on a unique address (see helpers.js newEmail).
  // With that, parallel is safe and the suite finishes in a usable time.
  //
  // Two workers, not four. The account isolation makes parallel correct, but the
  // two-person specs each drive two browser contexts, so at four workers eight
  // contexts hammer one embedded Postgres and one server process at once. That
  // starved the socket round trip in the photo-share and vote-agreement flows
  // and false-reddened two specs on every full run, while both passed alone. The
  // suite exists to find real breakage (retries stay 0), so the fix is to stop
  // manufacturing contention, not to paper it over with a retry. This is the
  // number CI already used; local now matches it. Cost is a few extra minutes.
  fullyParallel: true,
  workers: 2,

  // A flake that passes on retry is a flake nobody fixes. This suite exists to
  // find real breakage, so a failure stays a failure.
  retries: 0,

  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: [['list'], ['json', { outputFile: require('path').join(__dirname, 'results.json') }]],

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // A phone, because that is what Flock is. Several defects only exist at
    // 390 wide, and DESIGN-STANDARD rule 6 is specifically about 320 to 390.
    ...devices['iPhone 13'],
    // Deny by default. The app must work for somebody who says no, and a
    // granted permission would hide exactly the paths worth testing.
    permissions: [],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'phone', use: { ...devices['iPhone 13'], ...(PINNED_ZONE ? { timezoneId: PINNED_ZONE } : {}) } },
  ],
});

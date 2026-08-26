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

const WEB_PORT = Number(process.env.E2E_WEB_PORT || 3199);

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.js',

  // Specs share one database, so they must not share one ACCOUNT. Every spec
  // signs up its own, keyed on a unique address (see helpers.js newEmail).
  // With that, parallel is safe and the suite finishes in a usable time.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,

  // A flake that passes on retry is a flake nobody fixes. This suite exists to
  // find real breakage, so a failure stays a failure.
  retries: 0,

  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: [['list'], ['json', { outputFile: require('path').join(__dirname, 'results.json') }]],

  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    // A phone, because that is what Flock is. Several defects only exist at
    // 390 wide, and SLOP-AUDIT rule 6 is specifically about 320 to 390.
    ...devices['iPhone 13'],
    // Deny by default. The app must work for somebody who says no, and a
    // granted permission would hide exactly the paths worth testing.
    permissions: [],
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    { name: 'phone', use: { ...devices['iPhone 13'] } },
  ],
});
